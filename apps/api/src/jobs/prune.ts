import type { Database } from 'firebase-admin/database';
import { dayShardKey } from '../events/ledger.js';

/**
 * MEAS-08: retention enforcement via whole-day-node removal — never a
 * per-record scan or a full-tree read. Every day-sharded tree this phase
 * introduces (`eventLedger`, `outboxPending`, `creditLedgerByDay`,
 * `processedStripeEventsByDay`, `reportJobsByDay`) is pruned on the same
 * `ledgerDays` window (default 30); `reconciliationExceptions` gets its own,
 * longer `exceptionDays` window (default 90 — a maintainer needs a longer
 * look-back to spot exception patterns). See `docs/canonical-events-retention.md`
 * (Task 3) for the documented rationale.
 *
 * Structural "no full-tree scan" guarantee: this module NEVER calls `.get()`
 * on any tree. Expired day keys are computed purely from date arithmetic
 * (day-sharding is deterministic — `dayShardKey(ms)` — so the exact keys to
 * remove are known without ever reading the tree first) and removed with
 * `ref(path).remove()`. A small bounded `lookbackDays` window (beyond the
 * exact cutoff day) covers the case where a scheduled prune run was missed —
 * still a fixed, bounded number of blind `.remove()` calls, never a scan.
 * `.remove()` on an already-absent path is a safe no-op, which is what makes
 * a second run over the same state idempotent.
 */

export interface PruneResult {
  /** Deduped `yyyymmdd` day keys targeted for the 30d-window ledger family trees. */
  prunedLedgerDays: string[];
  /** Deduped `yyyymmdd` day keys targeted for the 90d-window `reconciliationExceptions` tree. */
  prunedExceptionDays: string[];
}

export interface PruneOptions {
  /** Injectable "now" for tests. */
  now?: number;
  /** Retention window (days) for eventLedger/outboxPending/day-mirrors; default 30. */
  ledgerDays?: number;
  /** Retention window (days) for reconciliationExceptions; default 90. */
  exceptionDays?: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEDGER_RETENTION_DAYS = 30;
const DEFAULT_EXCEPTION_RETENTION_DAYS = 90;
/** Bounded backlog coverage — handles a missed Cloud Scheduler run without ever scanning a tree to discover what's expired. */
const PRUNE_LOOKBACK_DAYS = 14;

/** Trees pruned on the `ledgerDays` window, alongside the canonical `eventLedger`/`outboxPending`. */
const LEDGER_FAMILY_TREES = [
  'eventLedger',
  'outboxPending',
  'creditLedgerByDay',
  'processedStripeEventsByDay',
  'reportJobsByDay',
] as const;

function expiredDayKeys(now: number, retentionDays: number, lookbackDays: number): string[] {
  const keys = new Set<string>();
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    keys.add(dayShardKey(now - (retentionDays + offset) * ONE_DAY_MS));
  }
  return [...keys];
}

export async function runPrune(database: Database, opts: PruneOptions = {}): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const ledgerDays = opts.ledgerDays ?? DEFAULT_LEDGER_RETENTION_DAYS;
  const exceptionDays = opts.exceptionDays ?? DEFAULT_EXCEPTION_RETENTION_DAYS;

  const prunedLedgerDays = expiredDayKeys(now, ledgerDays, PRUNE_LOOKBACK_DAYS);
  const prunedExceptionDays = expiredDayKeys(now, exceptionDays, PRUNE_LOOKBACK_DAYS);

  await Promise.all([
    ...prunedLedgerDays.flatMap((day) =>
      LEDGER_FAMILY_TREES.map((tree) => database.ref(`${tree}/${day}`).remove()),
    ),
    ...prunedExceptionDays.map((day) => database.ref(`reconciliationExceptions/${day}`).remove()),
  ]);

  return { prunedLedgerDays, prunedExceptionDays };
}
