import type { Database } from 'firebase-admin/database';
import { eventEnvelopeSchema, type EventEnvelope } from '@smash-tracker/shared';

/**
 * MEAS-05: derives the UTC `yyyymmdd` day-shard key for `eventLedger`/
 * `outboxPending` from an envelope's `occurredAt` (epoch ms). Exported for
 * reuse by the GA4 projection worker, the nightly reconciliation job, and
 * the retention/pruning job — all of which need to address the same
 * day-sharded tree without re-deriving the key format.
 */
export function dayShardKey(occurredAt: number): string {
  return new Date(occurredAt).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * MEAS-02/03/04/05: the SOLE writer of the `eventLedger` RTDB tree. Every
 * D/B/X emitter across this codebase must call this function — never write
 * to `eventLedger`/`outboxPending`/`eventDedup` directly, and never call
 * this function a second time for an event that has already been
 * successfully emitted (retry/reconciliation code reads these trees, it
 * never re-derives a canonical event through this path — see PITFALLS.md
 * Pitfall 2).
 *
 * Idempotency: a `.transaction()` dedup-abort on
 * `eventDedup/{eventName}/{schemaVersion}/{causationId}` guards against a
 * duplicate emission of the same logical event. CR-01 discipline applies —
 * `current === true` means "already emitted, abort"; `null`/`undefined`
 * means "not yet seen," never an abort condition (see `credits.ts`'s
 * `markStripeEventProcessed`/`spendCredit` for the exact same shape).
 *
 * Atomicity: once the dedup transaction commits, the ledger row and its
 * paired outbox row are written together in ONE root-level multi-path
 * `update()` — either both exist or neither does (mirrors `rtdb.ts`'s
 * `deleteShare` multi-path pattern).
 */
export async function createEvent(database: Database, envelope: EventEnvelope): Promise<void> {
  const parsed = eventEnvelopeSchema.parse(envelope);

  const dedupRef = database.ref(
    `eventDedup/${parsed.eventName}/${parsed.schemaVersion}/${parsed.causationId}`,
  );
  const dedup = await dedupRef.transaction((current) => {
    if (current === true) {
      // Already emitted — abort, no write. NEVER `if (current === null) return;`
      // (CR-01: null/undefined on the first run means "not yet seen," not "abort").
      return undefined;
    }
    return true;
  });
  if (!dedup.committed) {
    return;
  }

  const day = dayShardKey(parsed.occurredAt);
  const key = database.ref(`eventLedger/${day}`).push().key;
  if (!key) {
    throw new Error('Failed to allocate an eventLedger push key');
  }

  await database.ref().update({
    [`eventLedger/${day}/${key}`]: parsed,
    [`outboxPending/${day}/${key}`]: { attempt: 0, nextRetryAt: null },
  });
}
