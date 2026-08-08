import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  RESEARCH_LEASE_TTL_MS,
  RESEARCH_RUN_HISTORY_LIMIT,
  isPathSafeProviderId,
  researchTenantIngestionStateSchema,
  type ResearchIngestionCursor,
  type ResearchIngestionMode,
  type ResearchIngestionRun,
  type ResearchIngestionRunStatus,
  type ResearchPageReceipt,
  type ResearchTenantIngestionState,
} from '@smash-tracker/shared';
import { foldPageReceipt } from './rollup.js';

/**
 * Phase 30 Plan 05 (D-06, D-16): the CR-01 run state machine on ONE RTDB
 * node, `researchIngestionRuns/{tenantId}` -> `{ activeRunId?, runs? }`.
 *
 * The "is there an active run" decision and the run record it names must
 * commit atomically, and a sibling node could not be atomic with it — same
 * rationale `research/entitlements.ts` already states for its own
 * active-grant decision. `RESEARCH_RUN_HISTORY_LIMIT` keeps the node small
 * enough that a per-page cursor advance rewriting it stays cheap.
 *
 * CALLER RULE (review C3-H1): every terminal transition (`completeBackfillRun`,
 * `failBackfillRun`) requires a lease, so the lease must be acquired BEFORE
 * any validation that could fail the run. 30-07 has two startup-validation
 * failure classes — a stored `playerId` that will not convert to a provider
 * id, and an identity mapping with no confirmed players — and BOTH are
 * ordinary fenced `failBackfillRun` calls made with a holder already in
 * hand, never a special case. Getting the ordering wrong is silent and
 * permanent: with no lease acquired, `failBackfillRun` returns lease-lost,
 * the run stays `running`, `activeRunId` keeps pointing at it, every retry
 * for that player re-enters the same dead end, and every trigger for any
 * OTHER confirmed player is refused `busy` — forever, because no lease
 * exists to expire and no route can force-fail it. This module deliberately
 * exposes NO unfenced force-fail: one would let any caller kill a run
 * another owner is actively advancing, which is a worse failure than the
 * one it would fix. The correct fix is the acquire-then-validate ordering
 * this module's callers must follow.
 *
 * Performs no authorization, emits nothing, imports no event machinery, and
 * is the ONLY writer of `researchIngestionRuns`.
 */

function runStateRef(database: Database, tenantId: string) {
  return database.ref(`researchIngestionRuns/${tenantId}`);
}

/** Safe-parse to an empty state on failure — never throws inside a transaction callback (CR-01). */
function parseState(raw: unknown): ResearchTenantIngestionState {
  const parsed = researchTenantIngestionStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Conditional-spread every optional run member (house constraint 1); only
 * `status`, `mode`, `playerId`, `requestedByUid`, and `startedAtMs` are
 * unconditional. Applied to EVERY run written by this module, touched or
 * not, so every write goes through the same discipline.
 */
function buildStoredRun(run: ResearchIngestionRun): Record<string, unknown> {
  return {
    status: run.status,
    mode: run.mode,
    playerId: run.playerId,
    requestedByUid: run.requestedByUid,
    startedAtMs: run.startedAtMs,
    ...(run.updatedAtMs != null ? { updatedAtMs: run.updatedAtMs } : {}),
    ...(run.completedAtMs != null ? { completedAtMs: run.completedAtMs } : {}),
    ...(run.failedAtMs != null ? { failedAtMs: run.failedAtMs } : {}),
    ...(run.coveragePublishedAtMs != null
      ? { coveragePublishedAtMs: run.coveragePublishedAtMs }
      : {}),
    ...(run.reason != null ? { reason: run.reason } : {}),
    ...(run.cursor != null ? { cursor: run.cursor } : {}),
    ...(run.lease != null ? { lease: run.lease } : {}),
    ...(run.leaseFenceCounter != null ? { leaseFenceCounter: run.leaseFenceCounter } : {}),
    ...(run.pendingPageReceipt != null ? { pendingPageReceipt: run.pendingPageReceipt } : {}),
    ...(run.stagedCounters != null ? { stagedCounters: run.stagedCounters } : {}),
    ...(run.stagedNamedGaps != null ? { stagedNamedGaps: run.stagedNamedGaps } : {}),
    ...(run.stagedDateCoverage != null ? { stagedDateCoverage: run.stagedDateCoverage } : {}),
    ...(run.stagedClassificationCounts != null
      ? { stagedClassificationCounts: run.stagedClassificationCounts }
      : {}),
    ...(run.stagedUniqueCounters != null ? { stagedUniqueCounters: run.stagedUniqueCounters } : {}),
    ...(run.stagedUniqueNamedGaps != null
      ? { stagedUniqueNamedGaps: run.stagedUniqueNamedGaps }
      : {}),
    ...(run.stagedUniqueClassificationCounts != null
      ? { stagedUniqueClassificationCounts: run.stagedUniqueClassificationCounts }
      : {}),
    ...(run.observedMaxUpdatedAtSeconds != null
      ? { observedMaxUpdatedAtSeconds: run.observedMaxUpdatedAtSeconds }
      : {}),
    ...(run.backoffEvents != null ? { backoffEvents: run.backoffEvents } : {}),
    ...(run.retryAfterObserved != null ? { retryAfterObserved: run.retryAfterObserved } : {}),
    ...(run.lastRetryAfterValue != null ? { lastRetryAfterValue: run.lastRetryAfterValue } : {}),
  };
}

function buildStoredRuns(
  runs: Record<string, ResearchIngestionRun> | null | undefined,
): Record<string, unknown> | undefined {
  if (!runs) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [id, run] of Object.entries(runs)) {
    result[id] = buildStoredRun(run);
  }
  return result;
}

/** Conditional-spread the whole node (`activeRunId`, `runs`) — omission equals deletion. */
function buildStoredState(state: {
  activeRunId?: string | null;
  runs?: Record<string, ResearchIngestionRun> | null;
}): Record<string, unknown> {
  const storedRuns = buildStoredRuns(state.runs);
  const hasRuns = storedRuns != null && Object.keys(storedRuns).length > 0;
  return {
    ...(state.activeRunId != null ? { activeRunId: state.activeRunId } : {}),
    ...(hasRuns ? { runs: storedRuns } : {}),
  };
}

/** Keeps the active run always, then the most recent terminal runs by completedAt/failedAt/startedAt, up to `limit`. */
function pruneRuns(
  runs: Record<string, ResearchIngestionRun>,
  activeRunId: string | null,
  limit: number,
): Record<string, ResearchIngestionRun> {
  const entries = Object.entries(runs);
  if (entries.length <= limit) {
    return runs;
  }
  const activeEntries = entries.filter(([id]) => id === activeRunId);
  const terminalEntries = entries.filter(([id]) => id !== activeRunId);
  const sorted = [...terminalEntries].sort(([, a], [, b]) => {
    const at = a.completedAtMs ?? a.failedAtMs ?? a.startedAtMs;
    const bt = b.completedAtMs ?? b.failedAtMs ?? b.startedAtMs;
    return bt - at;
  });
  const keepCount = Math.max(0, limit - activeEntries.length);
  const kept = sorted.slice(0, keepCount);
  const result: Record<string, ResearchIngestionRun> = {};
  for (const [id, run] of [...activeEntries, ...kept]) {
    result[id] = run;
  }
  return result;
}

export interface CreateOrResumeInput {
  tenantId: string;
  playerId: string;
  requestedByUid: string;
  mode: ResearchIngestionMode;
  updatedAfterSeconds?: number;
  now?: number;
}
export type CreateOrResumeOutcome = 'created' | 'resumed' | 'busy';
export interface CreateOrResumeResult {
  outcome: CreateOrResumeOutcome;
  runId: string | null;
  resumed: boolean;
  status: ResearchIngestionRunStatus | null;
  /** Populated on 'busy' so the route can say WHO is running. */
  activePlayerId: string | null;
  activeMode: ResearchIngestionMode | null;
}

/**
 * Idempotent, replay-safe run creation. `runId` and `startedAtMs` are
 * pre-generated OUTSIDE the transaction callback (CR-01); the callback is a
 * pure, total function of its input.
 *
 * A workspace may hold SEVERAL confirmed start.gg player IDs (D-10) — "there
 * is a run in progress" does NOT imply "it is the run you asked for". A
 * trigger for a DIFFERENT player id or mode while a run is active is
 * refused with the `busy` outcome and creates nothing (review C2-H3): an
 * earlier unconditional resume silently advanced the FIRST player's run
 * while the caller believed their own backfill had started.
 */
export async function createOrResumeBackfillRun(
  database: Database,
  input: CreateOrResumeInput,
): Promise<CreateOrResumeResult> {
  if (!isPathSafeProviderId(input.tenantId)) {
    throw new Error('createOrResumeBackfillRun: unsafe tenantId');
  }

  const runId = randomUUID();
  const startedAtMs = input.now ?? Date.now();

  const result = await runStateRef(database, input.tenantId).transaction((raw) => {
    const current = parseState(raw);
    const activeRunId = current.activeRunId ?? null;
    const activeRun = activeRunId ? current.runs?.[activeRunId] : undefined;

    if (activeRun && activeRun.status === 'running') {
      // A run is already in progress for this tenant, resume-eligible or
      // not — either way this attempt creates nothing.
      return buildStoredState(current);
    }

    const newRun: ResearchIngestionRun = {
      status: 'running',
      mode: input.mode,
      playerId: input.playerId,
      requestedByUid: input.requestedByUid,
      startedAtMs,
      cursor: {
        page: 1,
        ...(input.mode === 'refresh' && input.updatedAfterSeconds != null
          ? { updatedAfterSeconds: input.updatedAfterSeconds }
          : {}),
      },
    };
    const nextRuns = { ...(current.runs ?? {}), [runId]: newRun };
    const prunedRuns = pruneRuns(nextRuns, runId, RESEARCH_RUN_HISTORY_LIMIT);
    return buildStoredState({ activeRunId: runId, runs: prunedRuns });
  });

  // Derive the response from the COMMITTED snapshot, never from local
  // intent — a losing concurrent attempt must report the WINNER's run.
  const committed = parseState(result.snapshot.val());
  const committedActiveRunId = committed.activeRunId ?? null;
  const committedActiveRun = committedActiveRunId
    ? committed.runs?.[committedActiveRunId]
    : undefined;

  if (committedActiveRunId === runId) {
    return {
      outcome: 'created',
      runId,
      resumed: false,
      status: committedActiveRun?.status ?? 'running',
      activePlayerId: committedActiveRun?.playerId ?? input.playerId,
      activeMode: committedActiveRun?.mode ?? input.mode,
    };
  }

  if (
    committedActiveRun &&
    committedActiveRun.playerId === input.playerId &&
    committedActiveRun.mode === input.mode
  ) {
    return {
      outcome: 'resumed',
      runId: committedActiveRunId,
      resumed: true,
      status: committedActiveRun.status,
      activePlayerId: committedActiveRun.playerId,
      activeMode: committedActiveRun.mode,
    };
  }

  return {
    outcome: 'busy',
    runId: committedActiveRunId,
    resumed: false,
    status: committedActiveRun?.status ?? null,
    activePlayerId: committedActiveRun?.playerId ?? null,
    activeMode: committedActiveRun?.mode ?? null,
  };
}

export async function readTenantIngestionState(
  database: Database,
  tenantId: string,
): Promise<{ activeRunId: string | null; runs: Record<string, ResearchIngestionRun> }> {
  const snapshot = await runStateRef(database, tenantId).get();
  const state = parseState(snapshot.val());
  return { activeRunId: state.activeRunId ?? null, runs: state.runs ?? {} };
}

export async function readBackfillRun(
  database: Database,
  tenantId: string,
  runId: string,
): Promise<ResearchIngestionRun | null> {
  const state = await readTenantIngestionState(database, tenantId);
  return state.runs[runId] ?? null;
}

export async function readActiveBackfillRun(
  database: Database,
  tenantId: string,
): Promise<{ runId: string; run: ResearchIngestionRun } | null> {
  const state = await readTenantIngestionState(database, tenantId);
  if (!state.activeRunId) {
    return null;
  }
  const run = state.runs[state.activeRunId];
  return run ? { runId: state.activeRunId, run } : null;
}

/**
 * Exactly one holder per run — owner AND fence together (review C-H7,
 * tightened by C2-H1). `fence` is a COPY the current holder was issued; the
 * SEQUENCE lives on the run's `leaseFenceCounter`, never inside the lease
 * member itself, so `releaseRunLease` deleting the lease can never reset the
 * sequence (see the ABA discussion below).
 */
export interface RunLeaseHolder {
  ownerId: string;
  fence: number;
}
export interface AcquireLeaseResult {
  acquired: boolean;
  holder: RunLeaseHolder | null;
  heldBy: string | null;
  expiresAtMs: number | null;
}

/**
 * Admits ONE advancing invocation per run — what stops an admin `advance`
 * and a scheduler `advance` from processing the same cursor simultaneously
 * and double-counting. NOT a rate limiter and does NOT bound concurrency
 * ACROSS tenants — `throttle.ts`'s durable token bucket does that; the two
 * are separate because the constraints they protect are separate.
 *
 * Grants when there is no lease, the stored `expiresAtMs` is at or before
 * `now`, or the stored `ownerId` equals the caller's. On EVERY grant,
 * without exception, `leaseFenceCounter` (treating an absent counter as 0)
 * is incremented and copied into the granted `lease.fence` — including a
 * same-owner re-acquisition, which is DELETED as a special "no increment"
 * case (review C2-H1): that rule is incompatible with an exact-equality
 * fence check, and buys nothing, because `ownerId` defaults to a
 * per-invocation `randomUUID` so two simultaneously live invocations never
 * share one.
 *
 * THE ABA FAILURE THIS PREVENTS: A holds fence 1 and stalls; B expires A and
 * takes fence 2; B finishes and releases, deleting the `lease` member; C
 * acquires. If the sequence lived only inside the deleted `lease` member, C
 * would be handed fence 1 again, and stale A waking up with fence 1 would
 * be ACCEPTED — a double-counted page or a backward cursor. Because
 * `leaseFenceCounter` survives release, every issued fence is strictly
 * greater than every fence before it, and A's 1 can never match again.
 *
 * What the lease does NOT cover: the per-set writes in `sourceLayer.ts` and
 * `projection.ts` carry no fence of their own. They are protected by a
 * stated protocol instead — 30-07 calls `renewRunLease(holder)` at the top
 * of every page and issues ZERO durable writes for that page when renewal
 * returns false. A stale holder's delayed write is the content of ITS OWN
 * older fetch, so under provider mutation inside the TTL window it could
 * REGRESS newer content; what bounds that residual is 30-03's
 * `lastObservedAtMs` compare-and-skip guard on `upsertResearchSourceSet`,
 * which orders two writes by when their DATA was fetched rather than by
 * this lease. No counter, cursor, or coverage snapshot can be moved by an
 * unfenced write, because all three run through the mutators in this file.
 */
export async function acquireRunLease(
  database: Database,
  tenantId: string,
  runId: string,
  ownerId: string,
  now?: number,
  ttlMs?: number,
): Promise<AcquireLeaseResult> {
  const nowMs = now ?? Date.now();
  const effectiveTtlMs = ttlMs ?? RESEARCH_LEASE_TTL_MS;
  const expiresAtMs = nowMs + effectiveTtlMs;

  let outcome: AcquireLeaseResult = {
    acquired: false,
    holder: null,
    heldBy: null,
    expiresAtMs: null,
  };

  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];

    if (!run) {
      outcome = { acquired: false, holder: null, heldBy: null, expiresAtMs: null };
      return buildStoredState(current);
    }

    const lease = run.lease;
    const canGrant = !lease || lease.expiresAtMs <= nowMs || lease.ownerId === ownerId;

    if (!canGrant) {
      outcome = {
        acquired: false,
        holder: null,
        heldBy: lease.ownerId,
        expiresAtMs: lease.expiresAtMs,
      };
      return buildStoredState(current);
    }

    const nextFence = (run.leaseFenceCounter ?? 0) + 1;
    const grantedRun: ResearchIngestionRun = {
      ...run,
      leaseFenceCounter: nextFence,
      lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs, fence: nextFence },
    };

    outcome = {
      acquired: true,
      holder: { ownerId, fence: nextFence },
      heldBy: ownerId,
      expiresAtMs,
    };

    const nextRuns = { ...current.runs, [runId]: grantedRun };
    return buildStoredState({ activeRunId: current.activeRunId, runs: nextRuns });
  });

  return outcome;
}

/** Matching owner AND fence extends the expiry and keeps the fence; otherwise changes nothing and returns false. */
export async function renewRunLease(
  database: Database,
  tenantId: string,
  runId: string,
  holder: RunLeaseHolder,
  now?: number,
  ttlMs?: number,
): Promise<boolean> {
  const nowMs = now ?? Date.now();
  const effectiveTtlMs = ttlMs ?? RESEARCH_LEASE_TTL_MS;
  const expiresAtMs = nowMs + effectiveTtlMs;

  let renewed = false;

  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];
    const lease = run?.lease;

    if (!run || !lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      renewed = false;
      return buildStoredState(current);
    }

    const nextRun: ResearchIngestionRun = { ...run, lease: { ...lease, expiresAtMs } };
    renewed = true;

    const nextRuns = { ...current.runs, [runId]: nextRun };
    return buildStoredState({ activeRunId: current.activeRunId, runs: nextRuns });
  });

  return renewed;
}

/** Removes the `lease` member entirely (never a stored null) and leaves `leaseFenceCounter` in place. */
export async function releaseRunLease(
  database: Database,
  tenantId: string,
  runId: string,
  holder: RunLeaseHolder,
): Promise<void> {
  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];
    const lease = run?.lease;

    if (!run || !lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      return buildStoredState(current);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `lease` is intentionally discarded
    const { lease: _releasedLease, ...rest } = run;
    const nextRun: ResearchIngestionRun = { ...rest };

    const nextRuns = { ...current.runs, [runId]: nextRun };
    return buildStoredState({ activeRunId: current.activeRunId, runs: nextRuns });
  });
}

export interface RunStatePatch {
  cursor?: ResearchIngestionCursor;
  /** Replaces loose per-counter deltas (review C2-H2) — a page's whole contribution is one addressable unit. */
  pageReceipt?: ResearchPageReceipt;
  backoffEventsDelta?: number;
  retryAfterObserved?: boolean;
  lastRetryAfterValue?: string;
}
export type RunWriteOutcome = 'applied' | 'absent' | 'terminal' | 'lease-lost';
export interface RunWriteResult {
  outcome: RunWriteOutcome;
  run: ResearchIngestionRun | null;
}

/**
 * Advances a run's cursor and/or staged counters inside ONE transaction.
 * The cursor write must be durable BEFORE any backoff sleep — a crash
 * during the sleep must resume from the same page, never re-fetch an
 * already-committed page or skip the throttled one (Pattern 2). The
 * batch executor calls this after EVERY page and BEFORE any backoff sleep;
 * a future editor must not reorder that.
 *
 * `patch.pageReceipt` is folded INSIDE the callback via `foldPageReceipt`
 * (`rollup.ts`) so a retried transaction re-applies the delta against
 * whatever value actually committed — the property a read-fold-write
 * outside the transaction does not have.
 *
 * Owner AND exact fence are both required (review C2-H1): a fence lower OR
 * higher than the stored one, a matching fence with the wrong owner, or a
 * missing lease all return `lease-lost` with the run byte-unchanged.
 */
export async function advanceRunState(
  database: Database,
  tenantId: string,
  runId: string,
  holder: RunLeaseHolder,
  patch: RunStatePatch,
  now?: number,
): Promise<RunWriteResult> {
  const updatedAtMs = now ?? Date.now();

  let outcome: RunWriteResult = { outcome: 'absent', run: null };

  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];

    if (!run) {
      outcome = { outcome: 'absent', run: null };
      return buildStoredState(current);
    }
    if (run.status !== 'running') {
      outcome = { outcome: 'terminal', run };
      return buildStoredState(current);
    }
    const lease = run.lease;
    if (!lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      outcome = { outcome: 'lease-lost', run };
      return buildStoredState(current);
    }

    let nextRun: ResearchIngestionRun = { ...run, updatedAtMs };

    if (patch.cursor) {
      nextRun = { ...nextRun, cursor: patch.cursor };
    }

    if (patch.pageReceipt) {
      const folded = foldPageReceipt(run, patch.pageReceipt);
      nextRun = {
        ...nextRun,
        pendingPageReceipt: patch.pageReceipt,
        stagedCounters: folded.stagedCounters,
        stagedNamedGaps: folded.stagedNamedGaps,
        stagedClassificationCounts: folded.stagedClassificationCounts,
        stagedUniqueCounters: folded.stagedUniqueCounters,
        stagedUniqueNamedGaps: folded.stagedUniqueNamedGaps,
        stagedUniqueClassificationCounts: folded.stagedUniqueClassificationCounts,
        stagedDateCoverage: folded.stagedDateCoverage,
        ...(folded.observedMaxUpdatedAtSeconds != null
          ? { observedMaxUpdatedAtSeconds: folded.observedMaxUpdatedAtSeconds }
          : {}),
      };
    }

    if (patch.backoffEventsDelta) {
      nextRun = { ...nextRun, backoffEvents: (run.backoffEvents ?? 0) + patch.backoffEventsDelta };
    }
    if (patch.retryAfterObserved != null) {
      nextRun = { ...nextRun, retryAfterObserved: patch.retryAfterObserved };
    }
    if (patch.lastRetryAfterValue != null) {
      nextRun = { ...nextRun, lastRetryAfterValue: patch.lastRetryAfterValue };
    }

    outcome = { outcome: 'applied', run: nextRun };

    const nextRuns = { ...current.runs, [runId]: nextRun };
    return buildStoredState({ activeRunId: current.activeRunId, runs: nextRuns });
  });

  return outcome;
}

/**
 * Sets status `completed`, preserves the staged counters/date coverage
 * verbatim, releases the lease (omits `lease` — never stores null), KEEPS
 * `leaseFenceCounter` (review C2-H1), and clears `activeRunId` when it
 * names this run.
 *
 * Deliberately does NOT set `coveragePublishedAtMs` (review C-H8): a run
 * whose status is completed and whose `coveragePublishedAtMs` is ABSENT is
 * a run whose snapshot has not been published yet — a recoverable state,
 * not a finished one. `markCoveragePublished` is the second, idempotent
 * write that closes it, called by the executor only AFTER
 * `publishCoverageSnapshot` has returned. 30-07's terminal-run path checks
 * for exactly this combination and finishes the publication instead of
 * no-opping, so a crash between the two commits self-heals on the next
 * invocation rather than stranding a completed run whose coverage can never
 * publish.
 */
export async function completeBackfillRun(
  database: Database,
  tenantId: string,
  runId: string,
  holder: RunLeaseHolder,
  now?: number,
): Promise<RunWriteResult> {
  const completedAtMs = now ?? Date.now();

  let outcome: RunWriteResult = { outcome: 'absent', run: null };

  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];

    if (!run) {
      outcome = { outcome: 'absent', run: null };
      return buildStoredState(current);
    }
    if (run.status !== 'running') {
      outcome = { outcome: 'terminal', run };
      return buildStoredState(current);
    }
    const lease = run.lease;
    if (!lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      outcome = { outcome: 'lease-lost', run };
      return buildStoredState(current);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `lease` is intentionally discarded
    const { lease: _lease, ...rest } = run;
    const nextRun: ResearchIngestionRun = { ...rest, status: 'completed', completedAtMs };
    outcome = { outcome: 'applied', run: nextRun };

    const nextRuns = { ...current.runs, [runId]: nextRun };
    const nextActiveRunId = current.activeRunId === runId ? null : (current.activeRunId ?? null);
    const prunedRuns = pruneRuns(nextRuns, nextActiveRunId, RESEARCH_RUN_HISTORY_LIMIT);
    return buildStoredState({ activeRunId: nextActiveRunId, runs: prunedRuns });
  });

  return outcome;
}

/**
 * Second, idempotent write that closes the completion->publication seam
 * (review C-H8). Applies only to a run whose stored status is completed;
 * a no-op returning null on a running run, so a snapshot can never be
 * marked published for a run that never completed. Takes NO lease holder —
 * a completed run has already released its lease, so there is no holder to
 * check; its safety comes from being scoped to a completed run, being
 * idempotent, and from `publishCoverageSnapshot`'s own recency
 * compare-and-set (`rollup.ts`).
 */
export async function markCoveragePublished(
  database: Database,
  tenantId: string,
  runId: string,
  publishedAtMs: number,
): Promise<ResearchIngestionRun | null> {
  let result: ResearchIngestionRun | null = null;

  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];

    if (!run || run.status !== 'completed') {
      result = null;
      return buildStoredState(current);
    }

    const nextRun: ResearchIngestionRun = { ...run, coveragePublishedAtMs: publishedAtMs };
    result = nextRun;

    const nextRuns = { ...current.runs, [runId]: nextRun };
    return buildStoredState({ activeRunId: current.activeRunId, runs: nextRuns });
  });

  return result;
}

/**
 * Sets status `failed` with the supplied reason, preserves the cursor
 * (a later resume needs it), releases the lease, keeps
 * `leaseFenceCounter`, and clears `activeRunId` when it names this run.
 *
 * A run that fails part-way through a page may carry that partial page's
 * contribution in its staged counters (review C2-H2) — the receipt is
 * staged on every attempt including an abandoned one. Harmless and
 * deliberate: a failed run never publishes, so its counters are diagnostic
 * only.
 */
export async function failBackfillRun(
  database: Database,
  tenantId: string,
  runId: string,
  holder: RunLeaseHolder,
  reason: string,
  now?: number,
): Promise<RunWriteResult> {
  const failedAtMs = now ?? Date.now();

  let outcome: RunWriteResult = { outcome: 'absent', run: null };

  await runStateRef(database, tenantId).transaction((raw) => {
    const current = parseState(raw);
    const run = current.runs?.[runId];

    if (!run) {
      outcome = { outcome: 'absent', run: null };
      return buildStoredState(current);
    }
    if (run.status !== 'running') {
      outcome = { outcome: 'terminal', run };
      return buildStoredState(current);
    }
    const lease = run.lease;
    if (!lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      outcome = { outcome: 'lease-lost', run };
      return buildStoredState(current);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `lease` is intentionally discarded
    const { lease: _lease, ...rest } = run;
    const nextRun: ResearchIngestionRun = { ...rest, status: 'failed', failedAtMs, reason };
    outcome = { outcome: 'applied', run: nextRun };

    const nextRuns = { ...current.runs, [runId]: nextRun };
    const nextActiveRunId = current.activeRunId === runId ? null : (current.activeRunId ?? null);
    const prunedRuns = pruneRuns(nextRuns, nextActiveRunId, RESEARCH_RUN_HISTORY_LIMIT);
    return buildStoredState({ activeRunId: nextActiveRunId, runs: prunedRuns });
  });

  return outcome;
}
