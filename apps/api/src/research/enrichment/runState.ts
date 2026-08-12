import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  researchEnrichmentRunRecordSchema,
  RESEARCH_ENRICHMENT_RUN_STAGES,
  type ResearchEnrichmentRunRecord,
  type ResearchEnrichmentRunStage,
} from '@smash-tracker/shared';

/**
 * Phase 30.2 Plan 09 (ENR-10): the fenced, resumable enrichment run state
 * machine, mirroring `apps/api/src/research/ingestion/backfillRun.ts`
 * function-for-function against `researchEnrichmentRuns/{tenantId}` and the
 * `ResearchEnrichmentRunRecord` schema from plan 01.
 *
 * ONE STRUCTURAL DIFFERENCE FROM THE MIRRORED MODULE, stated here because it
 * changes every function's shape below: the ingestion run schema stores a
 * `{ activeRunId?, runs? }` WRAPPER — a small history of runs plus a pointer
 * to the active one. The enrichment run schema (plan 01,
 * `researchEnrichmentRunRecordSchema`) stores exactly ONE run record
 * directly at `researchEnrichmentRuns/{tenantId}` — no wrapper, no history,
 * no `activeRunId`. This phase never needed run history (there is no
 * enrichment-run list surface), so plan 01 deliberately did not carry that
 * extra layer, and this module honors that: "create or resume" reads the
 * ONE stored record and either returns it (when `running`) or overwrites it
 * with a fresh one (when absent or terminal) — there is no pruning, no
 * multi-run map, and no second run can ever exist beside an active one for
 * the same tenant.
 *
 * THE FENCE DISCIPLINE, copied exactly from the mirrored module and restated
 * here for the same reason: the fence sequence (`leaseFenceCounter`) lives
 * on the RUN, OUTSIDE the `lease` member, is incremented inside the SAME
 * transaction that grants any lease, is copied onto the granted lease's own
 * `fence`, and is NEVER decremented, reset, or removed — not by release, not
 * by a terminal transition. An earlier draft of the mirrored machinery kept
 * the only fence value inside the `lease` member itself; deleting that
 * member on release therefore reset the sequence, and a released-then-
 * reacquired lease could hand out a fence value a stale, still-running
 * holder already held — reviving it as valid. Keeping the counter outside
 * the lease and monotonic makes that impossible: every fence ever issued for
 * a run is strictly less than every fence issued after it, forever.
 *
 * This module performs no authorization of its own, emits nothing, and is
 * the ONLY writer of `researchEnrichmentRuns`.
 */

export const ENRICHMENT_LEASE_TTL_MS = 120_000;

// ---------------------------------------------------------------------------
// Cursor — the resumable ordered work list
// ---------------------------------------------------------------------------

/**
 * The cursor's ordered work list (Task 1 action; the stage vocabulary itself
 * is declared in `@smash-tracker/shared`, re-exported here so this module's
 * callers never need a second import): discovery (player VOD pages) ->
 * expansion (tournament subpage enumeration) -> probe (batched head
 * revisions) -> extraction (per fact page) -> projection (per target set).
 * `run.ts` (plan 09 Task 2) advances `stage` exactly once, from an earlier
 * stage to `'projection'`, as the single crash-safe checkpoint between
 * "everything has been gathered" and "resolve/attach/project the gathered
 * observations" — an invocation that finds `stage === 'projection'` already
 * stored skips every fetch and resumes directly at resolution.
 */
export { RESEARCH_ENRICHMENT_RUN_STAGES };
export type { ResearchEnrichmentRunStage };

export interface EnrichmentRunCursor {
  stage?: ResearchEnrichmentRunStage;
  /** The last completed unit of work within `stage` — a page title, when applicable. */
  pageTitle?: string;
  attempt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runRef(database: Database, tenantId: string) {
  return database.ref(`researchEnrichmentRuns/${tenantId}`);
}

/** Parses strictly so malformed persisted state fails loudly rather than being mistaken for an absent run (CR-01 discipline). `null`/`undefined` is the valid absent-run value seen on the Admin SDK's first local-cache transaction attempt. */
function parseRun(raw: unknown): ResearchEnrichmentRunRecord | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const parsed = researchEnrichmentRunRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Conditional-spreads every optional member (house constraint 1) — applied to EVERY write this module performs, touched or not. */
function buildStoredRun(run: ResearchEnrichmentRunRecord): Record<string, unknown> {
  return {
    runId: run.runId,
    status: run.status,
    startedAtMs: run.startedAtMs,
    ...(run.completedAtMs != null ? { completedAtMs: run.completedAtMs } : {}),
    ...(run.failedAtMs != null ? { failedAtMs: run.failedAtMs } : {}),
    ...(run.reason != null ? { reason: run.reason } : {}),
    ...(run.coveragePublishedAtMs != null
      ? { coveragePublishedAtMs: run.coveragePublishedAtMs }
      : {}),
    ...(run.lease != null ? { lease: run.lease } : {}),
    ...(run.leaseFenceCounter != null ? { leaseFenceCounter: run.leaseFenceCounter } : {}),
    ...(run.cursor != null ? { cursor: run.cursor } : {}),
  };
}

// ---------------------------------------------------------------------------
// Create or resume
// ---------------------------------------------------------------------------

export interface CreateOrResumeEnrichmentRunResult {
  runId: string;
  resumed: boolean;
  status: ResearchEnrichmentRunRecord['status'];
}

/**
 * Idempotent, replay-safe run creation. Calling this when NO run is stored,
 * or when the stored run is terminal (`completed`/`failed`), overwrites the
 * slot with a brand-new run (a fresh `runId`, no lease, no fence history —
 * a new run's fence sequence starts at absent/0, exactly like the mirrored
 * module's brand-new runs). Calling this while a run is `running` returns
 * that SAME run untouched — never a second one.
 */
export async function createOrResumeEnrichmentRun(
  database: Database,
  tenantId: string,
  now?: number,
): Promise<CreateOrResumeEnrichmentRunResult> {
  if (!isPathSafeProviderId(tenantId)) {
    throw new Error('createOrResumeEnrichmentRun: unsafe tenantId');
  }

  const candidateRunId = randomUUID();
  const startedAtMs = now ?? Date.now();

  const result = await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    if (current && current.status === 'running') {
      return buildStoredRun(current);
    }
    const newRun: ResearchEnrichmentRunRecord = {
      runId: candidateRunId,
      status: 'running',
      startedAtMs,
    };
    return buildStoredRun(newRun);
  });

  const committed = parseRun(result.snapshot.val());
  if (!committed) {
    throw new Error('createOrResumeEnrichmentRun: transaction committed an unparseable run');
  }
  return {
    runId: committed.runId,
    resumed: committed.runId !== candidateRunId,
    status: committed.status,
  };
}

/** Reads the stored run regardless of status, or `null` when none is stored or the stored value fails to parse. */
export async function readEnrichmentRun(
  database: Database,
  tenantId: string,
): Promise<ResearchEnrichmentRunRecord | null> {
  if (!isPathSafeProviderId(tenantId)) {
    return null;
  }
  const snapshot = await runRef(database, tenantId).get();
  return parseRun(snapshot.val());
}

/** Reads the stored run only when its status is `running`; a terminal or absent run reads as `null`. */
export async function readActiveEnrichmentRun(
  database: Database,
  tenantId: string,
): Promise<ResearchEnrichmentRunRecord | null> {
  const run = await readEnrichmentRun(database, tenantId);
  return run && run.status === 'running' ? run : null;
}

// ---------------------------------------------------------------------------
// Lease / fence
// ---------------------------------------------------------------------------

export interface EnrichmentRunLeaseHolder {
  ownerId: string;
  fence: number;
}
export interface AcquireEnrichmentLeaseResult {
  acquired: boolean;
  holder: EnrichmentRunLeaseHolder | null;
  heldBy: string | null;
  expiresAtMs: number | null;
}

/**
 * Grants when there is no lease, the stored lease has expired, or the
 * stored owner matches the caller. On every grant `leaseFenceCounter`
 * (absent treated as 0) is incremented and copied into the granted
 * `lease.fence` — including a same-owner re-acquisition, deliberately never
 * special-cased (mirrors the shipped module's review-driven rule: a
 * same-owner exemption is incompatible with an exact-equality fence check
 * downstream, and buys nothing since `ownerId` defaults to a
 * per-invocation `randomUUID`).
 */
export async function acquireEnrichmentRunLease(
  database: Database,
  tenantId: string,
  runId: string,
  ownerId: string,
  now?: number,
  ttlMs?: number,
): Promise<AcquireEnrichmentLeaseResult> {
  const nowMs = now ?? Date.now();
  const effectiveTtlMs = ttlMs ?? ENRICHMENT_LEASE_TTL_MS;
  const expiresAtMs = nowMs + effectiveTtlMs;

  let outcome: AcquireEnrichmentLeaseResult = {
    acquired: false,
    holder: null,
    heldBy: null,
    expiresAtMs: null,
  };

  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    if (!current || current.runId !== runId) {
      outcome = { acquired: false, holder: null, heldBy: null, expiresAtMs: null };
      return current ? buildStoredRun(current) : null;
    }

    const lease = current.lease;
    const canGrant = !lease || lease.expiresAtMs <= nowMs || lease.ownerId === ownerId;
    if (!canGrant) {
      outcome = {
        acquired: false,
        holder: null,
        heldBy: lease.ownerId,
        expiresAtMs: lease.expiresAtMs,
      };
      return buildStoredRun(current);
    }

    const nextFence = (current.leaseFenceCounter ?? 0) + 1;
    const grantedRun: ResearchEnrichmentRunRecord = {
      ...current,
      leaseFenceCounter: nextFence,
      lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs, fence: nextFence },
    };
    outcome = {
      acquired: true,
      holder: { ownerId, fence: nextFence },
      heldBy: ownerId,
      expiresAtMs,
    };
    return buildStoredRun(grantedRun);
  });

  return outcome;
}

/** Matching owner AND fence extends the expiry and keeps the fence; any mismatch (or an absent run/lease) changes nothing and returns `false`. */
export async function renewEnrichmentRunLease(
  database: Database,
  tenantId: string,
  runId: string,
  holder: EnrichmentRunLeaseHolder,
  now?: number,
  ttlMs?: number,
): Promise<boolean> {
  const nowMs = now ?? Date.now();
  const effectiveTtlMs = ttlMs ?? ENRICHMENT_LEASE_TTL_MS;
  const expiresAtMs = nowMs + effectiveTtlMs;

  let renewed = false;

  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    const lease = current?.runId === runId ? current.lease : undefined;
    if (
      !current ||
      current.runId !== runId ||
      !lease ||
      lease.ownerId !== holder.ownerId ||
      lease.fence !== holder.fence
    ) {
      renewed = false;
      return current ? buildStoredRun(current) : null;
    }
    renewed = true;
    const nextRun: ResearchEnrichmentRunRecord = { ...current, lease: { ...lease, expiresAtMs } };
    return buildStoredRun(nextRun);
  });

  return renewed;
}

/** Removes the `lease` member entirely (never a stored null) and leaves `leaseFenceCounter` in place — the property that makes a released-then-reacquired lease unable to revalidate a stale holder. */
export async function releaseEnrichmentRunLease(
  database: Database,
  tenantId: string,
  runId: string,
  holder: EnrichmentRunLeaseHolder,
): Promise<void> {
  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    const lease = current?.runId === runId ? current.lease : undefined;
    if (
      !current ||
      current.runId !== runId ||
      !lease ||
      lease.ownerId !== holder.ownerId ||
      lease.fence !== holder.fence
    ) {
      return current ? buildStoredRun(current) : null;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `lease` is intentionally discarded
    const { lease: _releasedLease, ...rest } = current;
    return buildStoredRun({ ...rest });
  });
}

// ---------------------------------------------------------------------------
// Advance / terminal transitions
// ---------------------------------------------------------------------------

export type EnrichmentRunWriteOutcome = 'applied' | 'absent' | 'terminal' | 'lease-lost';
export interface EnrichmentRunWriteResult {
  outcome: EnrichmentRunWriteOutcome;
  run: ResearchEnrichmentRunRecord | null;
}

/** Advances the cursor inside one fenced transaction. Owner AND exact fence are both required — any mismatch (or a non-running run) returns `lease-lost`/`terminal` with the run byte-unchanged. */
export async function advanceEnrichmentRunState(
  database: Database,
  tenantId: string,
  runId: string,
  holder: EnrichmentRunLeaseHolder,
  patch: { cursor: EnrichmentRunCursor },
): Promise<EnrichmentRunWriteResult> {
  let outcome: EnrichmentRunWriteResult = { outcome: 'absent', run: null };

  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    if (!current || current.runId !== runId) {
      outcome = { outcome: 'absent', run: null };
      return current ? buildStoredRun(current) : null;
    }
    if (current.status !== 'running') {
      outcome = { outcome: 'terminal', run: current };
      return buildStoredRun(current);
    }
    const lease = current.lease;
    if (!lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      outcome = { outcome: 'lease-lost', run: current };
      return buildStoredRun(current);
    }

    const nextRun: ResearchEnrichmentRunRecord = { ...current, cursor: patch.cursor };
    outcome = { outcome: 'applied', run: nextRun };
    return buildStoredRun(nextRun);
  });

  return outcome;
}

/**
 * Sets `status: 'completed'`, preserves the cursor verbatim, releases the
 * lease (omits `lease` — never a stored null) and KEEPS `leaseFenceCounter`.
 * Deliberately does NOT set `coveragePublishedAtMs` — a completed run whose
 * `coveragePublishedAtMs` is absent is a recoverable "not yet published"
 * state, closed by `markEnrichmentCoveragePublished` below, mirroring the
 * shipped module's completion->publication seam.
 */
export async function completeEnrichmentRun(
  database: Database,
  tenantId: string,
  runId: string,
  holder: EnrichmentRunLeaseHolder,
  now?: number,
): Promise<EnrichmentRunWriteResult> {
  const completedAtMs = now ?? Date.now();
  let outcome: EnrichmentRunWriteResult = { outcome: 'absent', run: null };

  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    if (!current || current.runId !== runId) {
      outcome = { outcome: 'absent', run: null };
      return current ? buildStoredRun(current) : null;
    }
    if (current.status !== 'running') {
      outcome = { outcome: 'terminal', run: current };
      return buildStoredRun(current);
    }
    const lease = current.lease;
    if (!lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      outcome = { outcome: 'lease-lost', run: current };
      return buildStoredRun(current);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `lease` is intentionally discarded
    const { lease: _lease, ...rest } = current;
    const nextRun: ResearchEnrichmentRunRecord = { ...rest, status: 'completed', completedAtMs };
    outcome = { outcome: 'applied', run: nextRun };
    return buildStoredRun(nextRun);
  });

  return outcome;
}

/** Second, idempotent write that closes the completion->publication seam. Applies only to a stored run whose status is `completed`; a no-op (`null`) on anything else. Takes no lease holder — a completed run has already released its own. */
export async function markEnrichmentCoveragePublished(
  database: Database,
  tenantId: string,
  runId: string,
  publishedAtMs: number,
): Promise<ResearchEnrichmentRunRecord | null> {
  let result: ResearchEnrichmentRunRecord | null = null;

  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    if (!current || current.runId !== runId || current.status !== 'completed') {
      result = null;
      return current ? buildStoredRun(current) : null;
    }
    const nextRun: ResearchEnrichmentRunRecord = {
      ...current,
      coveragePublishedAtMs: publishedAtMs,
    };
    result = nextRun;
    return buildStoredRun(nextRun);
  });

  return result;
}

/** Sets `status: 'failed'` with the supplied reason, preserves the cursor (a later resume needs it), releases the lease, and keeps `leaseFenceCounter`. */
export async function failEnrichmentRun(
  database: Database,
  tenantId: string,
  runId: string,
  holder: EnrichmentRunLeaseHolder,
  reason: string,
  now?: number,
): Promise<EnrichmentRunWriteResult> {
  const failedAtMs = now ?? Date.now();
  let outcome: EnrichmentRunWriteResult = { outcome: 'absent', run: null };

  await runRef(database, tenantId).transaction((raw) => {
    const current = parseRun(raw);
    if (!current || current.runId !== runId) {
      outcome = { outcome: 'absent', run: null };
      return current ? buildStoredRun(current) : null;
    }
    if (current.status !== 'running') {
      outcome = { outcome: 'terminal', run: current };
      return buildStoredRun(current);
    }
    const lease = current.lease;
    if (!lease || lease.ownerId !== holder.ownerId || lease.fence !== holder.fence) {
      outcome = { outcome: 'lease-lost', run: current };
      return buildStoredRun(current);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `lease` is intentionally discarded
    const { lease: _lease, ...rest } = current;
    const nextRun: ResearchEnrichmentRunRecord = { ...rest, status: 'failed', failedAtMs, reason };
    outcome = { outcome: 'applied', run: nextRun };
    return buildStoredRun(nextRun);
  });

  return outcome;
}
