import type { Database } from 'firebase-admin/database';
import type { EventEnvelope } from '@smash-tracker/shared';
import type { Ga4Config } from '../config/env.js';
import { sendMeasurementProtocolEventResult } from '../analytics/ga4.js';
import { dayShardKey } from '../events/ledger.js';
import { projectEventToGa4 } from '../events/ga4Project.js';

/**
 * MEAS-05/06, Pitfall 2 (RESEARCH.md): the consent-aware GA4 projection
 * worker. Drains `outboxPending/{today}` (+ a short `{yesterday}` lookback
 * for anything that failed overnight) in bounded batches, projecting only
 * `consentState === 'granted'` events through `projectEventToGa4`'s
 * allowlisted mapper and relaying them via the EXISTING GA4 transport
 * (`sendMeasurementProtocolEventResult`, `analytics/ga4.ts`, unmodified
 * URL-building/logging logic).
 *
 * Structural Pitfall-2 guarantee: this module imports ONLY read helpers
 * from `events/ledger.ts` (`dayShardKey`) — it never imports `createEvent`,
 * so a retry can never re-derive/duplicate a canonical `eventLedger` row.
 * Every write this module makes targets `outboxPending/*` only: either a
 * full key removal (success or a permanently-skipped event) or a
 * `.transaction()`-safe `attempt`/`nextRetryAt` bump (retryable failure).
 */

export interface ProjectGa4Result {
  projected: number;
  skipped: number;
  failed: number;
}

interface OutboxEntry {
  attempt: number;
  nextRetryAt: number | null;
}

/** MEAS-05: bounded batch per day-shard per run — never a full-tree scan. */
const MAX_KEYS_PER_DAY = 500;

/** Simple fixed backoff for a failed GA4 POST — retried on the next scheduled run. */
const RETRY_BACKOFF_MS = 5 * 60 * 1000;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function todayShardKey(): string {
  return dayShardKey(Date.now());
}

function yesterdayShardKey(): string {
  return dayShardKey(Date.now() - ONE_DAY_MS);
}

/**
 * Removes an outbox key without ever touching `eventLedger` — the shared
 * "this event is done, one way or another" exit used by every skip/success
 * branch below.
 */
async function resolveOutboxKey(database: Database, day: string, key: string): Promise<void> {
  await database.ref(`outboxPending/${day}/${key}`).remove();
}

/**
 * CR-01-safe: a `null` current value (first run, or a value already removed
 * by a concurrent invocation) is treated as "not yet retried," never an
 * abort — matches every other new mutable-counter transaction this phase
 * introduces (RESEARCH.md Pitfall 4).
 */
async function bumpOutboxAttempt(database: Database, day: string, key: string): Promise<void> {
  await database.ref(`outboxPending/${day}/${key}`).transaction((current) => {
    const existing = (current ?? { attempt: 0, nextRetryAt: null }) as OutboxEntry;
    return {
      attempt: existing.attempt + 1,
      nextRetryAt: Date.now() + RETRY_BACKOFF_MS,
    } satisfies OutboxEntry;
  });
}

export async function runProjectGa4(
  database: Database,
  config: Ga4Config | null,
  fetchImpl?: typeof fetch,
): Promise<ProjectGa4Result> {
  const result: ProjectGa4Result = { projected: 0, skipped: 0, failed: 0 };

  for (const day of [todayShardKey(), yesterdayShardKey()]) {
    const outboxSnapshot = await database.ref(`outboxPending/${day}`).get();
    if (!outboxSnapshot.exists()) {
      continue;
    }

    const outboxEntries = (outboxSnapshot.val() ?? {}) as Record<string, OutboxEntry>;
    const keys = Object.keys(outboxEntries).slice(0, MAX_KEYS_PER_DAY);

    for (const key of keys) {
      const ledgerSnapshot = await database.ref(`eventLedger/${day}/${key}`).get();
      if (!ledgerSnapshot.exists()) {
        // No matching ledger row (should be structurally impossible given
        // createEvent()'s atomic multi-path write) — drop the orphaned
        // outbox key rather than retry it forever.
        await resolveOutboxKey(database, day, key);
        result.skipped += 1;
        continue;
      }

      const envelope = ledgerSnapshot.val() as EventEnvelope;

      if (envelope.consentState !== 'granted') {
        // Not an error, not a retry candidate — resolved without ever
        // calling GA4 (T-10-05-05).
        await resolveOutboxKey(database, day, key);
        result.skipped += 1;
        continue;
      }

      const projected = projectEventToGa4(envelope);
      if (!projected) {
        // eventName has no defined GA4 projection — resolved, not retried.
        await resolveOutboxKey(database, day, key);
        result.skipped += 1;
        continue;
      }

      const succeeded = await sendMeasurementProtocolEventResult(
        config,
        projected.clientId,
        projected.eventName,
        projected.params,
        fetchImpl,
      );

      if (succeeded) {
        await resolveOutboxKey(database, day, key);
        result.projected += 1;
      } else {
        await bumpOutboxAttempt(database, day, key);
        result.failed += 1;
      }
    }
  }

  return result;
}
