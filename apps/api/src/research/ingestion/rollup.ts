import type { Database } from 'firebase-admin/database';
import {
  RESEARCH_REFRESH_OVERLAP_SECONDS,
  RESEARCH_SET_CLASSIFICATIONS,
  isPathSafeProviderId,
  normalizeResearchClassificationCounts,
  normalizeResearchCounters,
  normalizeResearchNamedGaps,
  researchCoverageResponseSchema,
  researchCoverageSnapshotSchema,
  type ResearchClassificationCounts,
  type ResearchClassificationCountsDelta,
  type ResearchCounters,
  type ResearchCountersDelta,
  type ResearchCoveragePlayerSection,
  type ResearchCoverageResponse,
  type ResearchCoverageSnapshot,
  type ResearchCoverageTotals,
  type ResearchDateCoverage,
  type ResearchIngestionCursor,
  type ResearchIngestionRun,
  type ResearchNamedGaps,
  type ResearchPageReceipt,
  type ResearchSetClassification,
} from '@smash-tracker/shared';
import { advanceRunState, type RunLeaseHolder, type RunWriteResult } from './backfillRun.js';

/**
 * Phase 30 Plan 05 (ING-05, D-16): staged counters (folded inside the SAME
 * transaction `advanceRunState` uses to move the cursor) plus a
 * completion-gated, per-player, recency-guarded publish to
 * `researchCoverage/{tenantId}`.
 *
 * `stageBatchProgress` is a thin composition over `backfillRun.ts`'s
 * `advanceRunState` — it does NOT read the run, fold locally, and write
 * absolute totals. A read-fold-write outside the transaction computes its
 * totals from a snapshot a concurrent invocation may already have
 * replaced, so two invocations each lose the other's contribution; folding
 * inside the callback (`foldPageReceipt` below) makes the operation
 * relative and therefore retry-safe (review C-H7b).
 *
 * `publishCoverageSnapshot` is called ONLY after the run's completion
 * transaction has already committed — never from inside one — because the
 * publish is a one-time side effect, not a pure repeatable callback
 * (30-RESEARCH.md Pattern 4). This module never emits and never
 * authorizes, and owns exactly one node (`researchCoverage/{tenantId}`);
 * the run node belongs to `backfillRun.ts`, which this module calls rather
 * than duplicates.
 *
 * `providerUnavailablePages`/`providerUnavailableRowEstimate` (the
 * provider-dead-page carve-out, 30-CONTEXT.md, decided by Codex advisor as
 * product-owner proxy) are ordinary members of `researchCountersSchema` —
 * every fold/negate/total helper below is generic over that schema's own
 * keys (`Object.keys(normalizeResearchCounters(...))`), so the two new
 * counters fold through `foldPageReceipt`/`stageBatchProgress`/
 * `publishCoverageSnapshot`/`computeTotals` automatically, exactly like
 * `discoveredAllGames` and every sibling counter — no dedicated handling
 * required here.
 */

// ---------------------------------------------------------------------------
// Pure folding helpers — no database, no clock. Every fold helper normalizes
// through the shared `.nullish()`-tolerant normalizers first, so a stored
// shape becomes an all-numeric object before arithmetic runs.
// ---------------------------------------------------------------------------

export function foldCounters(
  current: ResearchCounters | null | undefined,
  delta: ResearchCountersDelta,
): ResearchCounters {
  const base = normalizeResearchCounters(current);
  const result: ResearchCounters = {};
  for (const key of Object.keys(base) as (keyof ResearchCounters)[]) {
    result[key] = Math.max(0, (base[key] ?? 0) + (delta[key] ?? 0));
  }
  return result;
}

export function foldNamedGaps(
  current: ResearchNamedGaps | null | undefined,
  delta: Partial<ResearchNamedGaps>,
): ResearchNamedGaps {
  const base = normalizeResearchNamedGaps(current);
  const result: ResearchNamedGaps = {};
  for (const key of Object.keys(base) as (keyof ResearchNamedGaps)[]) {
    result[key] = Math.max(0, (base[key] ?? 0) + (delta[key] ?? 0));
  }
  return result;
}

export function foldClassificationCounts(
  current: ResearchClassificationCounts | null | undefined,
  delta: ResearchClassificationCountsDelta,
): ResearchClassificationCounts {
  const base = normalizeResearchClassificationCounts(current);
  const result: ResearchClassificationCounts = {};
  for (const classification of RESEARCH_SET_CLASSIFICATIONS) {
    const value = Math.max(0, base[classification] + (delta[classification] ?? 0));
    if (value !== 0) {
      result[classification] = value;
    }
  }
  return result;
}

/**
 * Per-SAMPLE date-coverage widener the executor uses to BUILD a page's own
 * span (one call per contributing set). `mergeDateCoverageSpan` below is the
 * RECEIPT-level fold `foldPageReceipt` uses; the two must never drift apart
 * — folding a two-set page through this per-sample form and then folding
 * the resulting span through `mergeDateCoverageSpan` must equal folding
 * both samples through `mergeDateCoverageSpan` directly.
 *
 * Takes epoch MILLISECONDS (review C-M3) — start.gg reports `completedAt`
 * in SECONDS; the caller converts once via the shared `providerSecondsToMs`
 * before calling this function. A `null`/`undefined` sample (no completion
 * timestamp) returns the existing coverage unchanged.
 */
export function mergeDateCoverage(
  current: ResearchDateCoverage | null | undefined,
  sampleMs: number | null | undefined,
): ResearchDateCoverage {
  if (sampleMs == null) {
    return {
      ...(current?.earliestSetAtMs != null ? { earliestSetAtMs: current.earliestSetAtMs } : {}),
      ...(current?.latestSetAtMs != null ? { latestSetAtMs: current.latestSetAtMs } : {}),
    };
  }
  const earliest =
    current?.earliestSetAtMs != null ? Math.min(current.earliestSetAtMs, sampleMs) : sampleMs;
  const latest =
    current?.latestSetAtMs != null ? Math.max(current.latestSetAtMs, sampleMs) : sampleMs;
  return { earliestSetAtMs: earliest, latestSetAtMs: latest };
}

/**
 * The receipt-level fold (review C3-A4): widens BOTH ends of the existing
 * coverage independently from an incoming SPAN, built from exactly two
 * `mergeDateCoverage` calls (one per end) so the two functions cannot drift
 * apart. `SETS_QUERY` specifies no ordering, so a single page can hold both
 * the earliest and the latest eligible set in a whole career — a
 * single-sample fold could carry at most one of those ends, silently
 * narrowing the published span with no visible symptom.
 */
export function mergeDateCoverageSpan(
  current: ResearchDateCoverage | null | undefined,
  span: { earliestSetAtMs?: number | null; latestSetAtMs?: number | null },
): ResearchDateCoverage {
  const afterEarliest = mergeDateCoverage(current, span.earliestSetAtMs ?? null);
  return mergeDateCoverage(afterEarliest, span.latestSetAtMs ?? null);
}

export function classificationCountsDelta(
  classification: ResearchSetClassification,
): ResearchClassificationCountsDelta {
  return { [classification]: 1 };
}

/**
 * ING-06's automation (review C-M6), scoped to a player id (review C2-H3):
 * a workspace holds MULTIPLE confirmed start.gg player IDs (D-10), and
 * taking "the tenant's most recent completed run" would hand a refresh for
 * player B the high-water observed while backfilling player A — every one
 * of B's sets older than that timestamp would be silently skipped with no
 * error and no gap counter. The overlap (`RESEARCH_REFRESH_OVERLAP_SECONDS`)
 * exists because a provider record can be updated with a timestamp at or
 * just before the boundary, so a strict high-water reread could skip a
 * correction that landed during the previous run; re-observing a day of
 * sets is free because the upsert is idempotent.
 */
export function deriveRefreshUpdatedAfterSeconds(
  state: { runs: Record<string, ResearchIngestionRun> },
  playerId: string,
): number | null {
  let best: ResearchIngestionRun | null = null;
  for (const run of Object.values(state.runs)) {
    if (run.status !== 'completed' || run.playerId !== playerId || run.completedAtMs == null) {
      continue;
    }
    if (!best || (best.completedAtMs ?? -Infinity) < run.completedAtMs) {
      best = run;
    }
  }
  if (!best || best.observedMaxUpdatedAtSeconds == null) {
    return null;
  }
  return Math.max(0, best.observedMaxUpdatedAtSeconds - RESEARCH_REFRESH_OVERLAP_SECONDS);
}

export interface FoldedRunProgress {
  stagedCounters: ResearchCounters;
  stagedNamedGaps: ResearchNamedGaps;
  stagedClassificationCounts: ResearchClassificationCounts;
  stagedUniqueCounters: ResearchCounters;
  stagedUniqueNamedGaps: ResearchNamedGaps;
  stagedUniqueClassificationCounts: ResearchClassificationCounts;
  stagedDateCoverage: ResearchDateCoverage;
  observedMaxUpdatedAtSeconds: number | null;
}

function negateCounters(counters: ResearchCounters): ResearchCountersDelta {
  const normalized = normalizeResearchCounters(counters);
  const result: ResearchCountersDelta = {};
  for (const key of Object.keys(normalized) as (keyof ResearchCounters)[]) {
    result[key] = -(normalized[key] ?? 0);
  }
  return result;
}

function negateNamedGaps(gaps: ResearchNamedGaps): Partial<ResearchNamedGaps> {
  const normalized = normalizeResearchNamedGaps(gaps);
  const result: Partial<ResearchNamedGaps> = {};
  for (const key of Object.keys(normalized) as (keyof ResearchNamedGaps)[]) {
    result[key] = -(normalized[key] ?? 0);
  }
  return result;
}

function negateClassificationCounts(
  counts: ResearchClassificationCounts,
): ResearchClassificationCountsDelta {
  const normalized = normalizeResearchClassificationCounts(counts);
  const result: ResearchClassificationCountsDelta = {};
  for (const classification of RESEARCH_SET_CLASSIFICATIONS) {
    result[classification] = -normalized[classification];
  }
  return result;
}

/**
 * The page-idempotence mechanism (review C2-H2), PURE so `advanceRunState`
 * can call it inside its transaction callback:
 *
 * 1. Start from the run's staged members (both bundles — observation and
 *    unique).
 * 2. When the run's `pendingPageReceipt` names the SAME page as the
 *    incoming receipt, SUBTRACT that stored receipt's counters/gaps/
 *    classification counts (and its unique bundle) first — this incoming
 *    receipt is a later attempt at the same page and REPLACES its
 *    predecessor's contribution rather than adding to it.
 * 3. Add the incoming receipt's counters/gaps/classification counts, and
 *    its unique bundle, onto the unique accumulators.
 * 4. Floor every result at zero, in both bundles.
 * 5. Widen the staged date coverage with `mergeDateCoverageSpan` (the
 *    receipt's earliest/latest PAIR, never a single sample — review C3-A4),
 *    and raise `observedMaxUpdatedAtSeconds` only when the receipt's value
 *    is larger. Neither is un-folded on a same-page replace: both are
 *    monotone envelopes rather than sums, so re-observing the same page can
 *    only re-widen to the same bound.
 *
 * SCOPE (review C3-H4b): this mechanism makes a run's counts exact over a
 * FIXED page sequence — the same pages returning the same sets. It does
 * NOT make two passes over LIVE start.gg pagination produce equal counts:
 * the provider moves sets across pages between requests, so a set written
 * by an abandoned attempt but absent from the retry's fetch keeps its
 * source record while its contribution is dropped. That is a property of
 * the provider's pagination, not a defect this fold can repair.
 *
 * The additive-delta design this replaces looked correct and was not
 * (review C2-H2): per-set durable writes commit one at a time, so a
 * mid-page write failure left earlier sets of that page already written.
 * Under additive deltas the retry either double-counted every set it had
 * already committed, or — with a run-id dedupe meant to stop that —
 * permanently LOST their contribution, because the retry's sets reported
 * the current run as their previous run and were suppressed. Making a
 * page's whole contribution one replaceable receipt is what makes a
 * re-invocation's convergence to an uninterrupted run's counts provable
 * rather than aspirational.
 */
export function foldPageReceipt(
  run: ResearchIngestionRun,
  receipt: ResearchPageReceipt,
): FoldedRunProgress {
  const pending = run.pendingPageReceipt;
  const isSamePage = pending != null && pending.page === receipt.page;

  let counters: ResearchCounters = normalizeResearchCounters(run.stagedCounters);
  let namedGaps: ResearchNamedGaps = normalizeResearchNamedGaps(run.stagedNamedGaps);
  let classificationCounts: ResearchClassificationCounts = normalizeResearchClassificationCounts(
    run.stagedClassificationCounts,
  );
  let uniqueCounters: ResearchCounters = normalizeResearchCounters(run.stagedUniqueCounters);
  let uniqueNamedGaps: ResearchNamedGaps = normalizeResearchNamedGaps(run.stagedUniqueNamedGaps);
  let uniqueClassificationCounts: ResearchClassificationCounts =
    normalizeResearchClassificationCounts(run.stagedUniqueClassificationCounts);

  if (isSamePage && pending) {
    counters = foldCounters(counters, negateCounters(pending.counters));
    namedGaps = foldNamedGaps(namedGaps, negateNamedGaps(pending.namedGaps));
    classificationCounts = foldClassificationCounts(
      classificationCounts,
      negateClassificationCounts(pending.classificationCounts),
    );
    uniqueCounters = foldCounters(uniqueCounters, negateCounters(pending.uniqueCounters));
    uniqueNamedGaps = foldNamedGaps(uniqueNamedGaps, negateNamedGaps(pending.uniqueNamedGaps));
    uniqueClassificationCounts = foldClassificationCounts(
      uniqueClassificationCounts,
      negateClassificationCounts(pending.uniqueClassificationCounts),
    );
  }

  counters = foldCounters(counters, receipt.counters as ResearchCountersDelta);
  namedGaps = foldNamedGaps(namedGaps, receipt.namedGaps as Partial<ResearchNamedGaps>);
  classificationCounts = foldClassificationCounts(
    classificationCounts,
    receipt.classificationCounts as ResearchClassificationCountsDelta,
  );
  uniqueCounters = foldCounters(uniqueCounters, receipt.uniqueCounters as ResearchCountersDelta);
  uniqueNamedGaps = foldNamedGaps(
    uniqueNamedGaps,
    receipt.uniqueNamedGaps as Partial<ResearchNamedGaps>,
  );
  uniqueClassificationCounts = foldClassificationCounts(
    uniqueClassificationCounts,
    receipt.uniqueClassificationCounts as ResearchClassificationCountsDelta,
  );

  const stagedDateCoverage = mergeDateCoverageSpan(run.stagedDateCoverage, {
    earliestSetAtMs: receipt.earliestSetAtMs,
    latestSetAtMs: receipt.latestSetAtMs,
  });

  const observedMaxUpdatedAtSeconds =
    receipt.observedMaxUpdatedAtSeconds != null &&
    (run.observedMaxUpdatedAtSeconds == null ||
      receipt.observedMaxUpdatedAtSeconds > run.observedMaxUpdatedAtSeconds)
      ? receipt.observedMaxUpdatedAtSeconds
      : (run.observedMaxUpdatedAtSeconds ?? null);

  return {
    stagedCounters: counters,
    stagedNamedGaps: namedGaps,
    stagedClassificationCounts: classificationCounts,
    stagedUniqueCounters: uniqueCounters,
    stagedUniqueNamedGaps: uniqueNamedGaps,
    stagedUniqueClassificationCounts: uniqueClassificationCounts,
    stagedDateCoverage,
    observedMaxUpdatedAtSeconds,
  };
}

// ---------------------------------------------------------------------------
// Staging — composes with the run state machine rather than owning a
// second node.
// ---------------------------------------------------------------------------

export interface StageBatchProgressInput {
  tenantId: string;
  runId: string;
  holder: RunLeaseHolder;
  receipt: ResearchPageReceipt;
  cursor: ResearchIngestionCursor;
  backoffEventsDelta?: number;
  retryAfterObserved?: boolean;
  lastRetryAfterValue?: string;
  now?: number;
}

/**
 * Passes the receipt and the new cursor straight into ONE `advanceRunState`
 * call, whose transaction callback folds `foldPageReceipt` against whatever
 * value actually commits — never a read-fold-write outside the transaction
 * (review C-H7b). Two call sites the executor uses:
 * - PAGE SUCCEEDED: the receipt carries the page's full contribution and
 *   the cursor advances to the next page with `pageAttempt` reset to 0.
 * - PAGE ABANDONED after a durable-write failure: the receipt carries
 *   whatever the partial attempt actually contributed and the cursor stays
 *   on the SAME page with `pageAttempt` incremented — the durable write
 *   that makes `cursor.pageAttempt` a real member with a real writer. The
 *   next attempt's receipt names the same page and therefore REPLACES this
 *   one.
 *
 * Forwards the caller's `holder` so a staging write from a fenced-out or
 * wrong-owner invocation is rejected rather than applied.
 */
export async function stageBatchProgress(
  database: Database,
  input: StageBatchProgressInput,
): Promise<RunWriteResult> {
  return advanceRunState(
    database,
    input.tenantId,
    input.runId,
    input.holder,
    {
      cursor: input.cursor,
      pageReceipt: input.receipt,
      backoffEventsDelta: input.backoffEventsDelta,
      retryAfterObserved: input.retryAfterObserved,
      lastRetryAfterValue: input.lastRetryAfterValue,
    },
    input.now,
  );
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

function coverageRef(database: Database, tenantId: string) {
  return database.ref(`researchCoverage/${tenantId}`);
}

function parseCoverageSnapshot(raw: unknown): ResearchCoverageSnapshot | null {
  const parsed = researchCoverageSnapshotSchema.safeParse(raw ?? null);
  return parsed.success ? parsed.data : null;
}

function emptyTotals(): ResearchCoverageTotals {
  return {
    counters: normalizeResearchCounters(undefined),
    namedGaps: normalizeResearchNamedGaps(undefined),
    dateCoverage: {},
    classificationCounts: normalizeResearchClassificationCounts(undefined),
  };
}

/**
 * `totals` is the tenant's UNIQUE-RECORD library: deduped by provider set
 * id, so a set exposed under two confirmed player IDs of the same human
 * counts once. Summed from each section's `unique*` bundle, NEVER from the
 * sections' observation bundles — the source tier is tenant-wide and keyed
 * by provider set id, so summing observations would report two records
 * where one exists. Each section still reports its own observation, so a
 * shared set legitimately appears in both sections and once in the rollup.
 * `dateCoverage` is widened, never summed, because a span is an envelope.
 */
function computeTotals(
  players: Record<string, ResearchCoveragePlayerSection>,
): ResearchCoverageTotals {
  let counters: ResearchCounters = normalizeResearchCounters(undefined);
  let namedGaps: ResearchNamedGaps = normalizeResearchNamedGaps(undefined);
  let classificationCounts: ResearchClassificationCounts =
    normalizeResearchClassificationCounts(undefined);
  let dateCoverage: ResearchDateCoverage = {};

  for (const section of Object.values(players)) {
    counters = foldCounters(counters, section.uniqueCounters as ResearchCountersDelta);
    namedGaps = foldNamedGaps(namedGaps, section.uniqueNamedGaps as Partial<ResearchNamedGaps>);
    classificationCounts = foldClassificationCounts(
      classificationCounts,
      section.uniqueClassificationCounts as ResearchClassificationCountsDelta,
    );
    dateCoverage = mergeDateCoverageSpan(dateCoverage, section.dateCoverage);
  }

  return { counters, namedGaps, dateCoverage, classificationCounts };
}

export interface PublishCoverageResult {
  published: boolean;
  reason: 'published' | 'superseded';
  snapshot: ResearchCoverageSnapshot;
}

/**
 * Writes a per-player section into `researchCoverage/{tenantId}` via ONE
 * MERGE transaction with a recency compare-and-set — never a whole-node
 * replace (review C2-H3): a workspace holds multiple confirmed player IDs
 * and a run covers exactly one of them, so a whole-node `.set()` would let
 * backfilling a second historical ID replace the workspace's published
 * coverage with second-ID-only counts.
 *
 * ORDERING CONTRACT: the caller must have already committed the run's
 * completion transaction and must pass the run value returned BY that
 * commit — this is the separate, one-time side effect that follows it,
 * never a step inside a transaction callback. Throws (a deliberate
 * programming-error signal, never a runtime condition — review C2-H6) for
 * a run whose status is not completed, or a completed run with no
 * `completedAtMs`; 30-07 wraps this call at its infrastructure boundary.
 *
 * `asOfMs`/`runCompletedAtMs` derive from `run.completedAtMs` — there is NO
 * `now` parameter (review C2-H4) — so republishing the same completed run
 * an hour later produces a byte-identical section. The recency guard
 * refuses any section whose incoming `runCompletedAtMs` is older than the
 * incumbent's (equal timestamps with the SAME run id are treated as the
 * byte-identical republication case and allowed through); everything else
 * with an equal or older timestamp is refused as `superseded` — not a
 * failure, since 30-07 still calls `markCoveragePublished` afterward either
 * way.
 */
export async function publishCoverageSnapshot(
  database: Database,
  tenantId: string,
  runId: string,
  run: ResearchIngestionRun,
): Promise<PublishCoverageResult> {
  if (run.status !== 'completed') {
    throw new Error('publishCoverageSnapshot: run is not completed');
  }
  if (run.completedAtMs == null) {
    throw new Error('publishCoverageSnapshot: completed run has no completedAtMs');
  }
  if (!isPathSafeProviderId(tenantId)) {
    throw new Error('publishCoverageSnapshot: unsafe tenantId');
  }

  const completedAtMs = run.completedAtMs;
  let outcome: PublishCoverageResult | null = null;

  await coverageRef(database, tenantId).transaction((raw) => {
    const existing = parseCoverageSnapshot(raw);
    const players = existing?.players ?? {};
    const existingSection = players[run.playerId];

    const shouldWrite =
      !existingSection ||
      completedAtMs > existingSection.runCompletedAtMs ||
      (completedAtMs === existingSection.runCompletedAtMs && existingSection.runId === runId);

    if (!shouldWrite) {
      outcome = {
        published: false,
        reason: 'superseded',
        snapshot: existing ?? { asOfMs: 0, players: {}, totals: emptyTotals() },
      };
      // Unchanged, defined value — never `undefined` (safe under the
      // null-first-run emulation: a genuinely empty node has no
      // `existingSection` and always takes the `shouldWrite: true` branch).
      return raw ?? {};
    }

    const section: ResearchCoveragePlayerSection = {
      playerId: run.playerId,
      runId,
      runCompletedAtMs: completedAtMs,
      asOfMs: completedAtMs,
      counters: normalizeResearchCounters(run.stagedCounters),
      namedGaps: normalizeResearchNamedGaps(run.stagedNamedGaps),
      dateCoverage: run.stagedDateCoverage ?? {},
      classificationCounts: normalizeResearchClassificationCounts(run.stagedClassificationCounts),
      uniqueCounters: normalizeResearchCounters(run.stagedUniqueCounters),
      uniqueNamedGaps: normalizeResearchNamedGaps(run.stagedUniqueNamedGaps),
      uniqueClassificationCounts: normalizeResearchClassificationCounts(
        run.stagedUniqueClassificationCounts,
      ),
    };

    const nextPlayers = { ...players, [run.playerId]: section };
    const totals = computeTotals(nextPlayers);
    const asOfMs = Math.max(...Object.values(nextPlayers).map((p) => p.asOfMs));

    const snapshot = researchCoverageSnapshotSchema.parse({ asOfMs, players: nextPlayers, totals });
    outcome = { published: true, reason: 'published', snapshot };
    return snapshot;
  });

  return outcome!;
}

/** Performs NO authorization — copies `resolveEntitlement`'s doc-comment contract. Safe-parses to null. */
export async function readCoverageSnapshot(
  database: Database,
  tenantId: string,
): Promise<ResearchCoverageSnapshot | null> {
  const snapshot = await coverageRef(database, tenantId).get();
  return parseCoverageSnapshot(snapshot.val());
}

export function buildCoverageResponse(input: {
  coverage: ResearchCoverageSnapshot | null;
  confirmedPlayerIds: string[];
  unresolvedCandidateCount: number;
  activeRun: { runId: string; run: ResearchIngestionRun } | null;
}): ResearchCoverageResponse {
  return researchCoverageResponseSchema.parse({
    coverage: input.coverage,
    confirmedPlayerIds: input.confirmedPlayerIds,
    confirmedPlayerIdCount: input.confirmedPlayerIds.length,
    unresolvedCandidateCount: input.unresolvedCandidateCount,
    ...(input.activeRun
      ? {
          activeRun: {
            runId: input.activeRun.runId,
            status: input.activeRun.run.status,
            playerId: input.activeRun.run.playerId,
            startedAtMs: input.activeRun.run.startedAtMs,
            ...(input.activeRun.run.cursor?.page != null
              ? { cursorPage: input.activeRun.run.cursor.page }
              : {}),
            ...(input.activeRun.run.cursor?.totalPages != null
              ? { totalPages: input.activeRun.run.cursor.totalPages }
              : {}),
          },
        }
      : {}),
  });
}
