import type { Database } from 'firebase-admin/database';
import { dayShardKey } from '../events/ledger.js';

/**
 * Quick task 260722-lxt: a READ-ONLY operator readout for the Phase 10
 * two-week soak gate (~2026-08-02). Aggregates canonical `eventLedger` event
 * volumes, `reconciliationExceptions` counts by kind, and `outboxPending`
 * pending-projection counts across a bounded window of UTC day-shards, so a
 * maintainer can read Stage-1/Stage-3 funnel evidence with one curl instead
 * of Firebase-console spelunking.
 *
 * Structural Pitfall-2 guarantee (mirrors reconcile.ts / prune.ts): this
 * module imports ONLY `dayShardKey` from `events/ledger.ts` — it never
 * imports or calls `createEvent`, so a readout run can never write to, or
 * re-derive, a canonical event. This module performs NO writes at all.
 *
 * T-LXT-01 (Information Disclosure): the response is aggregate-only — counts
 * keyed by `yyyymmdd` day, event name, or exception `kind`, plus
 * `generatedAt`. The handler below reads `eventName` (eventLedger) and
 * `kind` (reconciliationExceptions) ONLY; it never selects `payload`,
 * `actorId`, `sessionId`, `causationId`, or exception `subjectRef`/
 * `expected`/`actual`/`detectedAt`.
 *
 * T-LXT-03 (Denial of Service / bounded blast radius): every read below is a
 * single bounded day-shard path (`${tree}/${day}`), never a tree-root
 * `.get()` — mirrors reconcile.ts's per-day bounded-read pattern. The
 * requested window is clamped to [1, 14] days.
 */

export interface FunnelReadoutDay {
  day: string;
  eventCounts: Record<string, number>;
  exceptionCounts: Record<string, number>;
  pendingProjection: number;
}

export interface FunnelReadoutResult {
  generatedAt: number;
  days: FunnelReadoutDay[];
  totals: {
    eventCounts: Record<string, number>;
    exceptionCounts: Record<string, number>;
    pendingProjection: number;
  };
}

export interface FunnelReadoutOptions {
  /** Injectable "now" for deterministic tests. */
  now?: number;
  /** Requested window size in days; clamped to [1, 14]. Defaults to 7. */
  days?: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READOUT_DAYS = 7;
const MAX_READOUT_DAYS = 14;

/** Fallback bucket for an eventLedger row lacking a non-empty string `eventName` — volume stays honest without surfacing any other envelope field. */
const UNKNOWN_EVENT_NAME_BUCKET = '_unknown';

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(totals: Record<string, number>, perDay: Record<string, number>): void {
  for (const [key, value] of Object.entries(perDay)) {
    totals[key] = (totals[key] ?? 0) + value;
  }
}

export async function runFunnelReadout(
  database: Database,
  opts: FunnelReadoutOptions = {},
): Promise<FunnelReadoutResult> {
  const now = opts.now ?? Date.now();
  // Module-level defense-in-depth clamp (the route also rejects
  // out-of-range values at its zod boundary — see routes/internalJobs.ts).
  const window = Math.min(
    MAX_READOUT_DAYS,
    Math.max(1, Math.trunc(opts.days ?? DEFAULT_READOUT_DAYS)),
  );

  const dayKeys = Array.from({ length: window }, (_, offset) =>
    dayShardKey(now - offset * ONE_DAY_MS),
  );

  const days: FunnelReadoutDay[] = [];
  const totals: FunnelReadoutResult['totals'] = {
    eventCounts: {},
    exceptionCounts: {},
    pendingProjection: 0,
  };

  for (const day of dayKeys) {
    // Bounded per-day reads only — never a tree-root `.get()` on
    // eventLedger/reconciliationExceptions/outboxPending.
    const [ledgerSnapshot, exceptionsSnapshot, outboxSnapshot] = await Promise.all([
      database.ref(`eventLedger/${day}`).get(),
      database.ref(`reconciliationExceptions/${day}`).get(),
      database.ref(`outboxPending/${day}`).get(),
    ]);

    const eventCounts: Record<string, number> = {};
    const ledgerRows = Object.values((ledgerSnapshot.val() ?? {}) as Record<string, unknown>);
    for (const row of ledgerRows) {
      const eventName =
        row &&
        typeof row === 'object' &&
        typeof (row as Record<string, unknown>).eventName === 'string'
          ? ((row as Record<string, unknown>).eventName as string)
          : '';
      incrementCount(eventCounts, eventName.length > 0 ? eventName : UNKNOWN_EVENT_NAME_BUCKET);
    }

    const exceptionCounts: Record<string, number> = {};
    const exceptionRows = Object.values(
      (exceptionsSnapshot.val() ?? {}) as Record<string, unknown>,
    );
    for (const row of exceptionRows) {
      const kind =
        row && typeof row === 'object' && typeof (row as Record<string, unknown>).kind === 'string'
          ? ((row as Record<string, unknown>).kind as string)
          : undefined;
      if (kind) {
        incrementCount(exceptionCounts, kind);
      }
    }

    const pendingProjection = Object.keys(
      (outboxSnapshot.val() ?? {}) as Record<string, unknown>,
    ).length;

    days.push({ day, eventCounts, exceptionCounts, pendingProjection });

    mergeCounts(totals.eventCounts, eventCounts);
    mergeCounts(totals.exceptionCounts, exceptionCounts);
    totals.pendingProjection += pendingProjection;
  }

  return { generatedAt: now, days, totals };
}
