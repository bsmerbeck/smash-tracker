import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  providerSecondsToMs,
  type ResearchClassificationCounts,
  type ResearchIngestionCursor,
  type ResearchIngestionRunStatus,
  type ResearchPageReceipt,
  type ResearchSetClassification,
} from '@smash-tracker/shared';
import {
  acquireRunLease,
  completeBackfillRun,
  failBackfillRun,
  markCoveragePublished,
  readBackfillRun,
  releaseRunLease,
  renewRunLease,
  type RunLeaseHolder,
} from '../research/ingestion/backfillRun.js';
import {
  mergeDateCoverage,
  publishCoverageSnapshot,
  stageBatchProgress,
} from '../research/ingestion/rollup.js';
import { assessStartggFailure, resolveBackoffDelayMs } from '../research/ingestion/backoff.js';
import { createSharedRequestThrottle } from '../research/ingestion/throttle.js';
import { classifyResearchSet } from '../research/ingestion/classification.js';
import {
  readResearchSourceSet,
  upsertResearchSourceSet,
  toProviderFields,
} from '../research/ingestion/sourceLayer.js';
import { applyLegacyProjection, deriveLegacyProjection } from '../research/ingestion/projection.js';
import {
  confirmedPlayerIdSet,
  mineIdentityCandidates,
  readIdentityMapping,
  recordIdentityCandidates,
} from '../research/ingestion/identity.js';
import {
  fetchResearchSetsIdProbe,
  fetchResearchSetsPage,
  normalizeStartggPlayerId,
  RESEARCH_SETS_PER_PAGE,
} from '../startgg/client.js';

/**
 * Phase 30 Plan 07 (ING-01/ING-02/ING-05): the bounded, leased, all-or-retry
 * page loop that composes every wave-2 module (30-02 through 30-05) into a
 * running backfill. Mirrors `jobs/sweepStuckReportJobs.ts`'s
 * bounded-index-scan shape, but this job reads exactly ONE run record for
 * ONE tenant and never scans across tenants or runs. It emits NO canonical
 * event and imports no event machinery (RTEN-04, D-18).
 *
 * ORDERING CONTRACTS THAT MUST NOT BE REORDERED:
 * - The run lease is acquired BEFORE both startup validations (the stored
 *   `playerId` conversion and the identity-confirmation check) — review
 *   C3-H1. A validation that fails before a lease exists cannot commit its
 *   own terminal transition (`failBackfillRun` is fenced), which would wedge
 *   the run in `running` forever and refuse every OTHER confirmed player's
 *   trigger with `busy`.
 * - The cursor write is durable BEFORE any backoff sleep — a crash during
 *   the sleep must resume from the same page, never re-fetch an
 *   already-committed page or skip the throttled one. Load-bearing for
 *   ING-02.
 * - `renewRunLease(holder)` runs after the fetch and BEFORE the first
 *   durable write of every page, and issues ZERO writes for that page on
 *   failure — this is what bounds the unfenced per-set writes in
 *   `sourceLayer.ts`/`projection.ts` (review C2-H1).
 * - Identity candidates are mined and recorded BEFORE the staging
 *   transaction that advances the cursor past the page (review C3-A3) — a
 *   rejection there abandons the page exactly like a durable-write failure,
 *   because candidate mining is a pure per-page function (30-04) and
 *   nothing anywhere re-scans the source tier for them.
 * - Every attempt at a page stages exactly ONE replaceable receipt; a later
 *   attempt at the SAME page replaces the earlier one inside
 *   `foldPageReceipt` (review C2-H2). This is what makes the published
 *   counts trustworthy.
 *
 * COUNT-PARITY SCOPE (review C3-H4b): over a FIXED page sequence — the same
 * pages returning the same sets, which is what a stable historical backfill
 * reproduces — a re-run and a retried page converge on identical counts.
 * Against LIVE start.gg pagination the provider can move sets across pages
 * between requests (`apps/api/src/startgg/sync.ts:330-333` documents the
 * same behavior in the shipped sync), so a set written by an abandoned
 * attempt but absent from the retry's re-fetch keeps its source record while
 * its receipt contribution is dropped, and a set that migrates forward can
 * be observed on a later page instead. Published counts are therefore
 * as-of the run's own page sequence — the source tier stays lossless and
 * dedupes by provider set id regardless; this caveat is about the COUNTERS,
 * never about the records.
 */

export const DEFAULT_MAX_PAGES_PER_INVOCATION = 20;
export const DEFAULT_MAX_RETRIES_PER_PAGE = 5;
export const DEFAULT_MAX_WRITE_RETRIES_PER_PAGE = 3;
export const TRIGGER_MAX_PAGES_PER_REQUEST = 3;
export const TRIGGER_MAX_SYNC_BACKOFF_MS = 10_000;
export const INTERNAL_JOB_MAX_SYNC_BACKOFF_MS = 240_000;
/**
 * Provider-dead-page carve-out (30-CONTEXT.md, decided by Codex advisor as
 * product-owner proxy, 2026-08-08): a CONSECUTIVE confirmed-dead-page cap.
 * Any healthy processed page (a page that is NOT a confirmed dead page)
 * resets the counter to zero, so this bounds a RUN of dead pages, never a
 * run's lifetime total. Exceeding it fails the run rather than silently
 * ingesting an unbounded stretch of "provider unavailable" gaps that could
 * just as easily be a broken confirmation probe.
 */
export const RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES = 25;

export interface ResearchBackfillLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

export interface ResearchBackfillBatchOptions {
  maxPagesPerInvocation?: number;
  perPage?: number;
  maxRetriesPerPage?: number;
  maxWriteRetriesPerPage?: number;
  /** Total synchronous sleep budget for THIS invocation (review C2-A3). */
  maxSyncBackoffMs?: number;
  /** Lease owner; defaults to a per-invocation randomUUID. */
  ownerId?: string;
  leaseTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetchImpl?: typeof fetch;
  logger?: ResearchBackfillLogger;
}

export type ResearchBackfillStopReason =
  | 'completed'
  | 'page-budget'
  | 'lease-held'
  | 'lease-lost'
  | 'retryable-write'
  | 'backoff-pending'
  | 'infra-error'
  | 'failed'
  | 'noop-terminal';

export interface ResearchBackfillBatchResult {
  runId: string;
  status: ResearchIngestionRunStatus;
  completed: boolean;
  stopReason: ResearchBackfillStopReason;
  retryable: boolean;
  pagesProcessed: number;
  setsObserved: number;
  cursorPage: number;
  totalPages: number | null;
  throttledMs: number;
  backoffEvents: number;
  writeRetries: number;
  /**
   * Invocation-scoped diagnostic (review C3-H5): counts sets whose upsert
   * was refused because the stored record already carried a NEWER
   * observation. Deliberately NEVER staged onto the run and NEVER published
   * as a coverage counter or a named gap — the set is present and its
   * stored content is newer than the write that was refused, so publishing
   * it would describe a coverage problem that does not exist. Logging it
   * surfaces the operational condition (a lease expiring mid-page under
   * contention) to the person who can act on it.
   */
  staleWritesSkipped: number;
  retryAfterObserved: boolean;
  reason: string | null;
}

/**
 * The never-throw boundary this function's contract depends on (review
 * C2-H6). Every durable operation in this file — every await that touches
 * the database, the provider, or the throttle — goes through this wrapper,
 * which awaits `fn` inside a try/catch and NEVER rethrows. A false outcome
 * is logged through the injected logger and converted by the caller into a
 * structured result: `infra-error` at the invocation level, or a page
 * abandonment where the operation is page-scoped.
 *
 * Wrapped boundaries — SEVENTEEN, listed here so a future addition is
 * visibly missing from this list: `readBackfillRun`, `publishCoverageSnapshot`,
 * `markCoveragePublished`, `readIdentityMapping`, `acquireRunLease`,
 * `renewRunLease`, `releaseRunLease`, `throttle.acquire`,
 * `fetchResearchSetsPage`, `fetchResearchSetsIdProbe`, `upsertResearchSourceSet`,
 * `readResearchSourceSet`, `applyLegacyProjection`, `stageBatchProgress`,
 * `recordIdentityCandidates`, `completeBackfillRun`, `failBackfillRun`.
 * `fetchResearchSetsIdProbe` is the provider-dead-page carve-out's
 * confirmation probe (30-CONTEXT.md, decided by Codex advisor as
 * product-owner proxy) — called ONLY when the heavy fetch returned an EMPTY
 * page against prior pagination knowledge, THROTTLED like any provider
 * call, never for a short NON-EMPTY page (that stays an unconditional hard
 * failure).
 */
export const RESEARCH_BACKFILL_INFRA_BOUNDARIES = [
  'readBackfillRun',
  'publishCoverageSnapshot',
  'markCoveragePublished',
  'readIdentityMapping',
  'acquireRunLease',
  'renewRunLease',
  'releaseRunLease',
  'throttle.acquire',
  'fetchResearchSetsPage',
  'fetchResearchSetsIdProbe',
  'upsertResearchSourceSet',
  'readResearchSourceSet',
  'applyLegacyProjection',
  'stageBatchProgress',
  'recordIdentityCandidates',
  'completeBackfillRun',
  'failBackfillRun',
] as const;

type InfraOutcome<T> = { ok: true; value: T } | { ok: false; label: string; error: unknown };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plain-number counters accumulator — `ResearchCounters`'s `.nullish()` members accept a plain number on write, but arithmetic needs a type that is never `null`. */
interface NumericCounters {
  discoveredAllGames: number;
  discoveredEligible: number;
  imported: number;
  skipped: number;
  unresolved: number;
  corrected: number;
  providerUnavailablePages: number;
  providerUnavailableRowEstimate: number;
}

/** Plain-number named-gaps accumulator — same rationale as `NumericCounters`. */
interface NumericNamedGaps {
  unknownCharacter: number;
  unknownStage: number;
  missingGameDetail: number;
  missingCompletedAt: number;
  unknownOnlineContext: number;
  unknownVideogame: number;
  unsafeProviderKey: number;
}

interface PageAccumulator {
  counters: NumericCounters;
  namedGaps: NumericNamedGaps;
  classificationCounts: Partial<Record<ResearchSetClassification, number>>;
  uniqueCounters: NumericCounters;
  uniqueNamedGaps: NumericNamedGaps;
  uniqueClassificationCounts: Partial<Record<ResearchSetClassification, number>>;
  earliestSetAtMs?: number;
  latestSetAtMs?: number;
  observedMaxUpdatedAtSeconds?: number;
}

function createEmptyCounters(): NumericCounters {
  return {
    discoveredAllGames: 0,
    discoveredEligible: 0,
    imported: 0,
    skipped: 0,
    unresolved: 0,
    corrected: 0,
    providerUnavailablePages: 0,
    providerUnavailableRowEstimate: 0,
  };
}

function createEmptyNamedGaps(): NumericNamedGaps {
  return {
    unknownCharacter: 0,
    unknownStage: 0,
    missingGameDetail: 0,
    missingCompletedAt: 0,
    unknownOnlineContext: 0,
    unknownVideogame: 0,
    unsafeProviderKey: 0,
  };
}

function createPageAccumulator(): PageAccumulator {
  return {
    counters: createEmptyCounters(),
    namedGaps: createEmptyNamedGaps(),
    classificationCounts: {},
    uniqueCounters: createEmptyCounters(),
    uniqueNamedGaps: createEmptyNamedGaps(),
    uniqueClassificationCounts: {},
  };
}

function bumpClassificationCount(
  map: Partial<Record<ResearchSetClassification, number>>,
  classification: ResearchSetClassification,
): void {
  map[classification] = (map[classification] ?? 0) + 1;
}

/** Adds `deriveLegacyProjection`'s six-key gap delta into a named-gaps accumulator (the `unsafeProviderKey` gap is bumped separately, from the upsert result). */
function addProjectionGapDelta(
  target: NumericNamedGaps,
  delta: {
    unknownCharacter: number;
    unknownStage: number;
    missingGameDetail: number;
    missingCompletedAt: number;
    unknownOnlineContext: number;
    unknownVideogame: number;
  },
): void {
  target.unknownCharacter += delta.unknownCharacter;
  target.unknownStage += delta.unknownStage;
  target.missingGameDetail += delta.missingGameDetail;
  target.missingCompletedAt += delta.missingCompletedAt;
  target.unknownOnlineContext += delta.unknownOnlineContext;
  target.unknownVideogame += delta.unknownVideogame;
}

function buildReceipt(
  page: number,
  attempt: number,
  stagedAtMs: number,
  acc: PageAccumulator,
): ResearchPageReceipt {
  return {
    page,
    attempt,
    stagedAtMs,
    counters: acc.counters,
    namedGaps: acc.namedGaps,
    classificationCounts: acc.classificationCounts as ResearchClassificationCounts,
    uniqueCounters: acc.uniqueCounters,
    uniqueNamedGaps: acc.uniqueNamedGaps,
    uniqueClassificationCounts: acc.uniqueClassificationCounts as ResearchClassificationCounts,
    ...(acc.earliestSetAtMs != null ? { earliestSetAtMs: acc.earliestSetAtMs } : {}),
    ...(acc.latestSetAtMs != null ? { latestSetAtMs: acc.latestSetAtMs } : {}),
    ...(acc.observedMaxUpdatedAtSeconds != null
      ? { observedMaxUpdatedAtSeconds: acc.observedMaxUpdatedAtSeconds }
      : {}),
  };
}

function zeroContributionReceipt(
  page: number,
  attempt: number,
  stagedAtMs: number,
): ResearchPageReceipt {
  return buildReceipt(page, attempt, stagedAtMs, createPageAccumulator());
}

export async function runResearchBackfillBatch(
  database: Database,
  serverToken: string,
  tenantId: string,
  runId: string,
  opts: ResearchBackfillBatchOptions = {},
): Promise<ResearchBackfillBatchResult> {
  const logger: ResearchBackfillLogger = opts.logger ?? {
    warn: () => undefined,
    info: () => undefined,
  };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const perPage = opts.perPage ?? RESEARCH_SETS_PER_PAGE;
  const maxPagesPerInvocation = opts.maxPagesPerInvocation ?? DEFAULT_MAX_PAGES_PER_INVOCATION;
  const maxRetriesPerPage = opts.maxRetriesPerPage ?? DEFAULT_MAX_RETRIES_PER_PAGE;
  const maxWriteRetriesPerPage = opts.maxWriteRetriesPerPage ?? DEFAULT_MAX_WRITE_RETRIES_PER_PAGE;
  const maxSyncBackoffMs = opts.maxSyncBackoffMs ?? TRIGGER_MAX_SYNC_BACKOFF_MS;
  const ownerId = opts.ownerId ?? randomUUID();

  async function runInfraStep<T>(label: string, fn: () => Promise<T>): Promise<InfraOutcome<T>> {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (error) {
      logger.warn({ label, err: error }, 'research backfill batch: infra step failed');
      return { ok: false, label, error };
    }
  }

  // Invocation-scoped accumulators, mutated as the batch progresses.
  let pagesProcessed = 0;
  let setsObserved = 0;
  let totalSleptMs = 0;
  let backoffEvents = 0;
  let writeRetries = 0;
  let staleWritesSkipped = 0;
  let retryAfterObserved = false;
  let cursorPage = 1;
  let knownTotalPages: number | null = null;
  let statusForResult: ResearchIngestionRunStatus = 'running';
  /**
   * Provider-dead-page carve-out (30-CONTEXT.md, decided by Codex advisor
   * as product-owner proxy): a run of CONSECUTIVE confirmed-dead pages,
   * invocation-scoped like `backoffEvents`/`writeRetries` — every one of
   * this cap's runs the design contract exercises stays well inside
   * `maxPagesPerInvocation`'s own bound, and `providerUnavailablePages`
   * (staged and published) is the durable, cross-invocation record of how
   * many dead pages a tenant's history actually carries. Any healthy
   * processed page resets this to zero.
   */
  let consecutiveDeadPages = 0;

  function buildResult(
    partial: Partial<ResearchBackfillBatchResult> & {
      stopReason: ResearchBackfillStopReason;
      retryable: boolean;
      completed: boolean;
    },
  ): ResearchBackfillBatchResult {
    return {
      runId,
      status: partial.status ?? statusForResult,
      completed: partial.completed,
      stopReason: partial.stopReason,
      retryable: partial.retryable,
      pagesProcessed,
      setsObserved,
      cursorPage: partial.cursorPage ?? cursorPage,
      totalPages: partial.totalPages !== undefined ? partial.totalPages : knownTotalPages,
      throttledMs: totalSleptMs,
      backoffEvents,
      writeRetries,
      staleWritesSkipped,
      retryAfterObserved,
      reason: partial.reason ?? null,
    };
  }

  try {
    // Step 1: read the ONE run record this invocation was addressed at.
    const runOutcome = await runInfraStep('readBackfillRun', () =>
      readBackfillRun(database, tenantId, runId),
    );
    if (!runOutcome.ok) {
      return buildResult({
        stopReason: 'infra-error',
        retryable: true,
        completed: false,
        reason: describeError(runOutcome.error),
      });
    }
    const run = runOutcome.value;
    if (!run) {
      return buildResult({
        status: 'failed',
        stopReason: 'noop-terminal',
        retryable: false,
        completed: false,
        reason: 'run-not-found',
      });
    }
    statusForResult = run.status;
    cursorPage = run.cursor?.page ?? 1;
    knownTotalPages = run.cursor?.totalPages ?? null;

    if (run.status === 'failed') {
      return buildResult({
        status: 'failed',
        stopReason: 'noop-terminal',
        retryable: false,
        completed: false,
        reason: run.reason ?? null,
      });
    }

    if (run.status === 'completed') {
      if (run.coveragePublishedAtMs != null) {
        return buildResult({
          status: 'completed',
          stopReason: 'completed',
          retryable: false,
          completed: true,
        });
      }
      // Crash-between-completion-and-publication recovery (review C-H8):
      // the completion transaction and the snapshot write are deliberately
      // separate, so a crash between them would otherwise strand a
      // completed run whose coverage could never publish without an
      // entire fresh backfill. Takes no lease — a terminal run already
      // released its own.
      const publishOutcome = await runInfraStep('publishCoverageSnapshot', () =>
        publishCoverageSnapshot(database, tenantId, runId, run),
      );
      if (!publishOutcome.ok) {
        return buildResult({
          status: 'completed',
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(publishOutcome.error),
        });
      }
      const markOutcome = await runInfraStep('markCoveragePublished', () =>
        markCoveragePublished(database, tenantId, runId, now()),
      );
      if (!markOutcome.ok) {
        return buildResult({
          status: 'completed',
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(markOutcome.error),
        });
      }
      return buildResult({
        status: 'completed',
        stopReason: 'completed',
        retryable: false,
        completed: true,
      });
    }

    // Step 2: acquire the run lease BEFORE any validation that can fail the
    // run (review C-H7, reordered by review C3-H1). A refused lease skips
    // the validations too — a run someone else currently owns is not this
    // invocation's to judge or to fail.
    const acquireOutcome = await runInfraStep('acquireRunLease', () =>
      acquireRunLease(database, tenantId, runId, ownerId, now(), opts.leaseTtlMs),
    );
    if (!acquireOutcome.ok) {
      return buildResult({
        stopReason: 'infra-error',
        retryable: true,
        completed: false,
        reason: describeError(acquireOutcome.error),
      });
    }
    if (!acquireOutcome.value.acquired || !acquireOutcome.value.holder) {
      return buildResult({ stopReason: 'lease-held', retryable: true, completed: false });
    }
    const holder: RunLeaseHolder = acquireOutcome.value.holder;

    async function doRelease(): Promise<void> {
      await runInfraStep('releaseRunLease', () =>
        releaseRunLease(database, tenantId, runId, holder),
      );
    }

    async function doFail(reason: string): Promise<ResearchBackfillBatchResult> {
      const failOutcome = await runInfraStep('failBackfillRun', () =>
        failBackfillRun(database, tenantId, runId, holder, reason, now()),
      );
      if (!failOutcome.ok) {
        return buildResult({
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(failOutcome.error),
        });
      }
      if (failOutcome.value.outcome === 'lease-lost') {
        return buildResult({ stopReason: 'lease-lost', retryable: true, completed: false });
      }
      return buildResult({
        status: 'failed',
        stopReason: 'failed',
        retryable: false,
        completed: false,
        reason,
      });
    }

    // Step 3: the single validated crossing from the stored STRING playerId
    // (an RTDB key) to the numeric form the provider client requires
    // (review C-H9b). The holder is in hand, so this transition COMMITS.
    const numericPlayerId = normalizeStartggPlayerId(run.playerId);
    if (numericPlayerId == null) {
      return await doFail('invalid-player-id');
    }

    // Step 4: nothing backfills before an admin confirms the identity
    // mapping (D-10) — the second, defense-in-depth check behind the
    // trigger route's own validate-then-create refusal.
    const identityOutcome = await runInfraStep('readIdentityMapping', () =>
      readIdentityMapping(database, tenantId),
    );
    if (!identityOutcome.ok) {
      await doRelease();
      return buildResult({
        stopReason: 'infra-error',
        retryable: true,
        completed: false,
        reason: describeError(identityOutcome.error),
      });
    }
    const confirmedPlayerIds = confirmedPlayerIdSet(identityOutcome.value);
    if (confirmedPlayerIds.size === 0) {
      return await doFail('identity-not-confirmed');
    }

    // Step 5: the DURABLE, token-wide throttle (review C-H7c) — never the
    // cheaper in-process window. Constructed with NO wait ceiling (review
    // C3-A1); every `acquire` call below is passed the invocation's CURRENT
    // remaining sleep budget, recomputed at the call site because the call
    // site is the only place that knows the running total.
    const throttle = createSharedRequestThrottle(database, { now, sleep });

    async function stageAttempt(
      receipt: ResearchPageReceipt,
      nextCursor: ResearchIngestionCursor,
      extra: {
        backoffEventsDelta?: number;
        retryAfterObserved?: boolean;
        lastRetryAfterValue?: string;
      } = {},
    ): Promise<
      | { kind: 'applied'; totalPages: number | null }
      | { kind: 'lease-lost' }
      | { kind: 'infra-error'; message: string }
    > {
      const stageOutcome = await runInfraStep('stageBatchProgress', () =>
        stageBatchProgress(database, {
          tenantId,
          runId,
          holder,
          receipt,
          cursor: nextCursor,
          ...extra,
        }),
      );
      if (!stageOutcome.ok) {
        return { kind: 'infra-error', message: describeError(stageOutcome.error) };
      }
      if (stageOutcome.value.outcome === 'lease-lost') {
        return { kind: 'lease-lost' };
      }
      if (stageOutcome.value.outcome === 'applied') {
        return { kind: 'applied', totalPages: stageOutcome.value.run?.cursor?.totalPages ?? null };
      }
      return {
        kind: 'infra-error',
        message: `stageBatchProgress returned unexpected outcome: ${stageOutcome.value.outcome}`,
      };
    }

    let pageAttempt = run.cursor?.pageAttempt ?? 0;
    let cursor: ResearchIngestionCursor = run.cursor ?? { page: 1 };

    async function finishRun(): Promise<ResearchBackfillBatchResult> {
      // Step 8: complete, then publish, then mark — never on an invocation
      // that merely exhausted its page or sleep budget.
      const completeOutcome = await runInfraStep('completeBackfillRun', () =>
        completeBackfillRun(database, tenantId, runId, holder, now()),
      );
      if (!completeOutcome.ok) {
        return buildResult({
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(completeOutcome.error),
        });
      }
      if (completeOutcome.value.outcome === 'lease-lost') {
        return buildResult({ stopReason: 'lease-lost', retryable: true, completed: false });
      }
      if (completeOutcome.value.outcome !== 'applied' || !completeOutcome.value.run) {
        return buildResult({
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: `completeBackfillRun returned ${completeOutcome.value.outcome}`,
        });
      }
      const completedRun = completeOutcome.value.run;
      const publishOutcome = await runInfraStep('publishCoverageSnapshot', () =>
        publishCoverageSnapshot(database, tenantId, runId, completedRun),
      );
      if (!publishOutcome.ok) {
        return buildResult({
          status: 'completed',
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(publishOutcome.error),
        });
      }
      const markOutcome = await runInfraStep('markCoveragePublished', () =>
        markCoveragePublished(database, tenantId, runId, now()),
      );
      if (!markOutcome.ok) {
        return buildResult({
          status: 'completed',
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(markOutcome.error),
        });
      }
      return buildResult({
        status: 'completed',
        stopReason: 'completed',
        retryable: false,
        completed: true,
      });
    }

    // Step 6: THE PAGE IS THE UNIT OF WORK AND THE UNIT OF RETRY (review
    // C-H6). Each loop iteration is ONE ATTEMPT at `cursor.page` — either a
    // fresh page (pageAttempt === 0) or a retry of the same page.
    for (;;) {
      cursorPage = cursor.page;

      if (knownTotalPages != null && cursor.page > knownTotalPages) {
        return await finishRun();
      }
      if (pageAttempt === 0 && pagesProcessed >= maxPagesPerInvocation) {
        await doRelease();
        return buildResult({ stopReason: 'page-budget', retryable: true, completed: false });
      }

      // Step 6a: throttle, passed the CURRENT remaining budget — never a
      // value captured earlier (review C3-A1).
      const remainingForThrottle = maxSyncBackoffMs - totalSleptMs;
      const throttleOutcome = await runInfraStep('throttle.acquire', () =>
        throttle.acquire(remainingForThrottle),
      );
      if (!throttleOutcome.ok) {
        await doRelease();
        return buildResult({
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(throttleOutcome.error),
        });
      }
      totalSleptMs += throttleOutcome.value.sleptMs;
      if (!throttleOutcome.value.acquired) {
        await doRelease();
        return buildResult({ stopReason: 'backoff-pending', retryable: true, completed: false });
      }

      // Step 6b: fetch the page.
      const fetchOutcome = await runInfraStep('fetchResearchSetsPage', () =>
        fetchResearchSetsPage(
          serverToken,
          numericPlayerId,
          cursor.page,
          perPage,
          {
            updatedAfter: cursor.updatedAfterSeconds ?? undefined,
          },
          fetchImpl,
        ),
      );

      if (!fetchOutcome.ok) {
        const assessment = assessStartggFailure(fetchOutcome.error);
        if (assessment.complexityRejected) {
          return await doFail('query-complexity-rejected');
        }
        if (assessment.isRateLimited) {
          const zeroReceipt = zeroContributionReceipt(cursor.page, pageAttempt, now());
          const staged = await stageAttempt(
            zeroReceipt,
            { ...cursor, pageAttempt: pageAttempt + 1 },
            {
              backoffEventsDelta: 1,
              retryAfterObserved: assessment.retryAfter != null,
              ...(assessment.retryAfter != null
                ? { lastRetryAfterValue: assessment.retryAfter }
                : {}),
            },
          );
          if (staged.kind === 'lease-lost') {
            return buildResult({ stopReason: 'lease-lost', retryable: true, completed: false });
          }
          if (staged.kind === 'infra-error') {
            await doRelease();
            return buildResult({
              stopReason: 'infra-error',
              retryable: true,
              completed: false,
              reason: staged.message,
            });
          }
          pageAttempt += 1;
          cursor = { ...cursor, pageAttempt };
          backoffEvents += 1;
          if (assessment.retryAfter != null) {
            retryAfterObserved = true;
          }
          if (pageAttempt > maxRetriesPerPage) {
            return await doFail('rate-limited: retry budget exhausted');
          }
          const delay = resolveBackoffDelayMs(assessment.retryAfter, pageAttempt - 1, {
            now,
            random: opts.random,
          });
          const remainingForSleep = maxSyncBackoffMs - totalSleptMs;
          if (delay > remainingForSleep) {
            await doRelease();
            return buildResult({
              stopReason: 'backoff-pending',
              retryable: true,
              completed: false,
            });
          }
          await sleep(delay);
          totalSleptMs += delay;
          continue;
        }
        // A non-rate-limit, non-complexity provider error: fail the run,
        // preserving the cursor, and return without throwing.
        return await doFail(describeError(fetchOutcome.error));
      }

      const page = fetchOutcome.value;
      // COLLAPSED-PAGINATION TRUNCATION (live probe, 2026-08-08): a fully
      // clipped page reports totalPages 0 alongside zero nodes, so
      // fetchResearchSetsPage's in-response guard cannot see it — but the
      // cursor's prior pagination knowledge can: pages remain beyond the
      // current one, yet the provider returned a short page. Overwriting
      // knownTotalPages with the collapsed value would let the loop-top
      // completion check close the run with a tiny fraction of the career
      // ingested (ING-01) — fail loudly instead, cursor preserved.
      //
      // PROVIDER-DEAD-PAGE CARVE-OUT (30-CONTEXT.md, decided by Codex
      // advisor as product-owner proxy, 2026-08-08): live evidence showed
      // start.gg deterministically returning an EMPTY connection for
      // specific row ranges (Hungrybox rows 16-30), a provider-side fault
      // rather than clipping. A short NON-EMPTY page stays unconditionally
      // fatal (clipping, unchanged below). An EMPTY page (zero nodes) with
      // prior pagination knowledge is only a NAMED GAP once a same-page,
      // lightweight ID-only confirmation probe ALSO returns zero nodes/zero
      // total — the zero/zero shape alone is not unique, since a fully
      // clipped page produces the identical shape; a probe that finds nodes
      // or a nonzero total means the heavy query was clipped, and the hard
      // failure below still stands.
      let isConfirmedDeadPage = false;
      if (page.sets.length < perPage && knownTotalPages != null && knownTotalPages > cursor.page) {
        if (page.sets.length > 0) {
          return await doFail(
            `provider-truncated-page: ${page.sets.length}/${perPage} nodes at page ${cursor.page} with prior totalPages=${knownTotalPages} (response reported ${page.totalPages}) — start.gg clipped the response to fit its object budget; lower perPage`,
          );
        }

        const probeThrottleOutcome = await runInfraStep('throttle.acquire', () =>
          throttle.acquire(maxSyncBackoffMs - totalSleptMs),
        );
        if (!probeThrottleOutcome.ok) {
          await doRelease();
          return buildResult({
            stopReason: 'infra-error',
            retryable: true,
            completed: false,
            reason: describeError(probeThrottleOutcome.error),
          });
        }
        totalSleptMs += probeThrottleOutcome.value.sleptMs;
        if (!probeThrottleOutcome.value.acquired) {
          await doRelease();
          return buildResult({ stopReason: 'backoff-pending', retryable: true, completed: false });
        }

        const probeOutcome = await runInfraStep('fetchResearchSetsIdProbe', () =>
          fetchResearchSetsIdProbe(
            serverToken,
            numericPlayerId,
            cursor.page,
            perPage,
            { updatedAfter: cursor.updatedAfterSeconds ?? undefined },
            fetchImpl,
          ),
        );
        if (!probeOutcome.ok) {
          await doRelease();
          return buildResult({
            stopReason: 'infra-error',
            retryable: true,
            completed: false,
            reason: describeError(probeOutcome.error),
          });
        }
        const probe = probeOutcome.value;
        if (probe.nodeCount > 0 || probe.total > 0) {
          // The confirmation probe found rows the heavy query did not —
          // the heavy query was clipped, the provider is not dead.
          return await doFail(
            `provider-truncated-page: 0/${perPage} nodes at page ${cursor.page} with prior totalPages=${knownTotalPages} (response reported ${page.totalPages}) — confirmation probe found nodeCount=${probe.nodeCount} total=${probe.total}, so the heavy query was clipped; lower perPage`,
          );
        }

        // CONFIRMED dead page: zero nodes AND zero total on BOTH the heavy
        // query and the lightweight probe. Named-gap, not a failure —
        // knownTotalPages is intentionally left unchanged below (never
        // overwritten by the collapsed 0).
        consecutiveDeadPages += 1;
        if (consecutiveDeadPages > RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES) {
          return await doFail(
            `dead-page cap exceeded: ${consecutiveDeadPages} consecutive confirmed dead pages ending at page ${cursor.page} (cap ${RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES})`,
          );
        }
        isConfirmedDeadPage = true;
      } else {
        knownTotalPages = page.totalPages;
      }
      // Captured ONCE per page attempt, right when the fetch resolves — the
      // comparator 30-03's stale-write guard reads (review C3-H5).
      const fetchedSnapshotAtMs = now();

      // Step 6c: RENEW BEFORE WRITING (review C2-H1) — issues ZERO durable
      // writes for this page when renewal fails.
      const renewOutcome = await runInfraStep('renewRunLease', () =>
        renewRunLease(database, tenantId, runId, holder, now()),
      );
      if (!renewOutcome.ok) {
        await doRelease();
        return buildResult({
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: describeError(renewOutcome.error),
        });
      }
      if (!renewOutcome.value) {
        return buildResult({ stopReason: 'lease-lost', retryable: true, completed: false });
      }

      // Step 6d/7: process every set on the page into LOCAL accumulators.
      const acc = createPageAccumulator();
      let abandoned = false;
      let abandonMessage: string | null = null;

      if (isConfirmedDeadPage) {
        // A confirmed dead page carries a zero-contribution receipt PLUS
        // the provider-unavailable counters — no set to classify, so the
        // per-set loop below is a no-op (`page.sets` is empty).
        acc.counters.providerUnavailablePages = 1;
        acc.counters.providerUnavailableRowEstimate = perPage;
        acc.uniqueCounters.providerUnavailablePages = 1;
        acc.uniqueCounters.providerUnavailableRowEstimate = perPage;
      }

      for (const set of page.sets) {
        setsObserved += 1;

        let classificationResult;
        try {
          classificationResult = classifyResearchSet({ set, confirmedPlayerIds });
        } catch (error) {
          // Safe-parse-and-skip, generalized: one malformed provider
          // record classifies unresolved and the batch keeps going.
          acc.counters.unresolved += 1;
          logger.warn(
            { err: error, setId: set.id },
            'research backfill: classification failed on one set',
          );
          continue;
        }
        const providerFields = toProviderFields(set, classificationResult);
        const providerSetId = String(set.id);

        const upsertOutcome = await runInfraStep('upsertResearchSourceSet', () =>
          upsertResearchSourceSet(database, {
            tenantId,
            providerSetId,
            fields: providerFields,
            ingestionRunId: runId,
            playerId: run.playerId,
            page: cursor.page,
            fetchedSnapshotAtMs,
          }),
        );
        if (!upsertOutcome.ok) {
          abandoned = true;
          abandonMessage = describeError(upsertOutcome.error);
          break;
        }
        const upsertResult = upsertOutcome.value;

        if (upsertResult.outcome === 'rejected-key') {
          acc.counters.unresolved += 1;
          continue;
        }
        if (upsertResult.outcome === 'stale-write-skipped') {
          staleWritesSkipped += 1;
          logger.info({ providerSetId }, 'research backfill: stale write skipped');
          continue;
        }

        const contributes = upsertResult.contributes;
        const unique = upsertResult.uniqueToTenant;

        if (upsertResult.keyDerived && contributes) {
          acc.namedGaps.unsafeProviderKey += 1;
          if (unique) {
            acc.uniqueNamedGaps.unsafeProviderKey += 1;
          }
        }

        if (contributes) {
          acc.counters.discoveredAllGames += 1;
          if (unique) {
            acc.uniqueCounters.discoveredAllGames += 1;
          }
          const classification = classificationResult.classification;
          if (classification === 'non-ssbu' || classification === 'non-singles') {
            acc.counters.skipped += 1;
            if (unique) acc.uniqueCounters.skipped += 1;
          } else if (classification === 'unresolved') {
            acc.counters.unresolved += 1;
            if (unique) acc.uniqueCounters.unresolved += 1;
          } else {
            acc.counters.discoveredEligible += 1;
            if (unique) acc.uniqueCounters.discoveredEligible += 1;
          }
          bumpClassificationCount(acc.classificationCounts, classification);
          if (unique) {
            bumpClassificationCount(acc.uniqueClassificationCounts, classification);
          }

          if (
            upsertResult.baselineFingerprint != null &&
            upsertResult.baselineFingerprint !== upsertResult.fingerprint
          ) {
            acc.counters.corrected += 1;
            if (unique) acc.uniqueCounters.corrected += 1;
          }
        }

        const storageKey = upsertResult.storageKey;
        if (storageKey == null) {
          continue;
        }

        const readOutcome = await runInfraStep('readResearchSourceSet', () =>
          readResearchSourceSet(database, tenantId, storageKey),
        );
        if (!readOutcome.ok || readOutcome.value == null) {
          abandoned = true;
          abandonMessage = readOutcome.ok
            ? 'readResearchSourceSet returned no record after a committed upsert'
            : describeError(readOutcome.error);
          break;
        }

        const projected = deriveLegacyProjection(readOutcome.value);
        const applyOutcome = await runInfraStep('applyLegacyProjection', () =>
          applyLegacyProjection(database, tenantId, storageKey, projected),
        );
        if (!applyOutcome.ok) {
          abandoned = true;
          abandonMessage = describeError(applyOutcome.error);
          break;
        }

        if (contributes) {
          acc.counters.imported += projected.importedGames;
          addProjectionGapDelta(acc.namedGaps, projected.namedGapDelta);
          if (unique) {
            acc.uniqueCounters.imported += projected.importedGames;
            addProjectionGapDelta(acc.uniqueNamedGaps, projected.namedGapDelta);
          }

          const sampleMs = providerSecondsToMs(set.completedAt);
          const widened = mergeDateCoverage(
            { earliestSetAtMs: acc.earliestSetAtMs, latestSetAtMs: acc.latestSetAtMs },
            sampleMs,
          );
          acc.earliestSetAtMs = widened.earliestSetAtMs ?? undefined;
          acc.latestSetAtMs = widened.latestSetAtMs ?? undefined;

          if (set.updatedAt != null) {
            acc.observedMaxUpdatedAtSeconds =
              acc.observedMaxUpdatedAtSeconds == null
                ? set.updatedAt
                : Math.max(acc.observedMaxUpdatedAtSeconds, set.updatedAt);
          }
        }
      }

      if (!abandoned) {
        // Step 6d-i: RECORD IDENTITY CANDIDATES FIRST, BEFORE THE CURSOR
        // MOVES (review C3-A3) — one write per page, from data already in
        // hand (D-15).
        const candidates = mineIdentityCandidates(page.sets, identityOutcome.value);
        const recordOutcome = await runInfraStep('recordIdentityCandidates', () =>
          recordIdentityCandidates(database, tenantId, candidates, fetchedSnapshotAtMs),
        );
        if (!recordOutcome.ok) {
          abandoned = true;
          abandonMessage = describeError(recordOutcome.error);
        }
      }

      if (abandoned) {
        // Step 6e: abandon the page — but STAGE THE RECEIPT ANYWAY (review
        // C2-H2), so a durable write records `cursor.pageAttempt` and the
        // next attempt REPLACES this one rather than adding to it.
        const receipt = buildReceipt(cursor.page, pageAttempt, now(), acc);
        const staged = await stageAttempt(receipt, { ...cursor, pageAttempt: pageAttempt + 1 });
        if (staged.kind === 'lease-lost') {
          return buildResult({ stopReason: 'lease-lost', retryable: true, completed: false });
        }
        if (staged.kind === 'infra-error') {
          await doRelease();
          return buildResult({
            stopReason: 'infra-error',
            retryable: true,
            completed: false,
            reason: staged.message,
          });
        }
        pageAttempt += 1;
        cursor = { ...cursor, pageAttempt };
        writeRetries += 1;
        if (pageAttempt > maxWriteRetriesPerPage) {
          const failResult = await doFail(
            `write-failure: retry budget exhausted (${abandonMessage ?? 'unknown'})`,
          );
          return { ...failResult, stopReason: 'retryable-write', retryable: true };
        }
        continue;
      }

      // A healthy processed page resets the dead-page run (provider-dead-
      // page carve-out) — only a confirmed dead page increments it.
      if (!isConfirmedDeadPage) {
        consecutiveDeadPages = 0;
      }

      // Step 6d-ii: stage the page's FULL contribution and advance the
      // cursor to the next page with `pageAttempt` reset to 0 — one
      // transaction carrying both, durable BEFORE the next iteration
      // (D-09). A confirmed dead page's collapsed `page.totalPages` (0)
      // must never overwrite the prior pagination knowledge (ING-01).
      const nextCursor: ResearchIngestionCursor = {
        page: cursor.page + 1,
        totalPages: isConfirmedDeadPage ? (knownTotalPages ?? page.totalPages) : page.totalPages,
        ...(cursor.updatedAfterSeconds != null
          ? { updatedAfterSeconds: cursor.updatedAfterSeconds }
          : {}),
        pageAttempt: 0,
      };
      const receipt = buildReceipt(cursor.page, pageAttempt, now(), acc);
      const staged = await stageAttempt(receipt, nextCursor);
      if (staged.kind === 'lease-lost') {
        return buildResult({ stopReason: 'lease-lost', retryable: true, completed: false });
      }
      if (staged.kind === 'infra-error') {
        await doRelease();
        return buildResult({
          stopReason: 'infra-error',
          retryable: true,
          completed: false,
          reason: staged.message,
        });
      }

      pagesProcessed += 1;
      knownTotalPages =
        staged.totalPages ?? (isConfirmedDeadPage ? knownTotalPages : page.totalPages);
      cursor = nextCursor;
      pageAttempt = 0;
    }
  } catch (error) {
    // The backstop for anything a future edit adds without wrapping through
    // `runInfraStep` — never a rejected promise out of this function.
    logger.warn(
      { err: error },
      'research backfill batch: unhandled exception escaped the invocation',
    );
    return buildResult({
      stopReason: 'infra-error',
      retryable: true,
      completed: false,
      reason: describeError(error),
    });
  }
}
