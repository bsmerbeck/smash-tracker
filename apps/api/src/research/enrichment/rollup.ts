import type { Database } from 'firebase-admin/database';
import {
  normalizeResearchEnrichmentCohortCounts,
  normalizeResearchEnrichmentCounts,
  researchEnrichmentCoverageSnapshotSchema,
  researchEnrichmentProjectionStateRecordSchema,
  type ResearchEnrichmentCohortCounts,
  type ResearchEnrichmentCounts,
  type ResearchEnrichmentCoverageResponse,
  type ResearchEnrichmentCoverageSnapshot,
  type ResearchEnrichmentFieldCoverage,
  type ResearchEnrichmentFieldCoverageCell,
  type ResearchEnrichmentProjectionStateRecord,
} from '@smash-tracker/shared';
import { buildLiquipediaPageUrl } from '../../liquipedia/client.js';
import { isPathSafeTenantId } from '../subjectKind.js';
import { markEnrichmentCoveragePublished } from './runState.js';

/**
 * Phase 30.2 Plan 10 (ENR-06/ENR-09/ENR-12, cycle-1 review HIGH 5): the
 * enrichment coverage rollup — publishes to its OWN node,
 * `researchEnrichmentCoverage/{tenantId}`, a SEPARATE node from
 * `researchCoverage/{tenantId}` that `apps/api/src/research/ingestion/
 * rollup.ts` owns and never touches. PATTERNS.md section 5 states why a
 * shared node is unsafe: adding a REQUIRED member to the shipped
 * per-player section would make every already-published ingestion
 * snapshot fail `researchCoverageSnapshotSchema.parse` at read time and
 * blank the panel for all four demo tenants, and a new counter family
 * added to that section but not to the ingestion run's page receipt could
 * never be produced by a run at all. This module therefore never imports
 * and never calls the locked `publishCoverageSnapshot` — a separate node
 * published by THIS enrichment rollup avoids touching that path entirely.
 *
 * Two-phase write, mirroring the ingestion module's "stage inside a
 * transaction, publish once after it commits" discipline
 * (`research/ingestion/rollup.ts:33-48`): `stageEnrichmentProgress` folds a
 * counts/cohort-counts delta into the coverage node through ONE
 * transaction — a read-fold-write OUTSIDE a transaction loses a concurrent
 * invocation's contribution — and `publishEnrichmentCoverage` is the
 * later, one-time side effect that finalizes the per-source-page freshness
 * map and notes and records the published timestamp on the run
 * (`markEnrichmentCoveragePublished`, `./runState.js` — the run node
 * belongs to that module, which this one calls rather than duplicates).
 * `publishEnrichmentCoverage` never runs from inside a transaction
 * callback, exactly like `publishCoverageSnapshot`'s own documented
 * ordering contract.
 *
 * This module performs no authorization of its own and emits nothing.
 */

/** Mirrors `research/ingestion/projection.ts`'s `{ id: 0, name: 'unknown' }` sentinel — the unresolved-provider-stage id. */
const PROVIDER_STAGE_UNKNOWN_ID = 0;

function coverageRef(database: Database, tenantId: string) {
  return database.ref(`researchEnrichmentCoverage/${tenantId}`);
}

function parseSnapshot(raw: unknown): ResearchEnrichmentCoverageSnapshot | null {
  const parsed = researchEnrichmentCoverageSnapshotSchema.safeParse(raw ?? null);
  return parsed.success ? parsed.data : null;
}

/** Recursively sorts object keys so two structurally-equal values compare equal regardless of key insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Pure folding helpers — no database, no clock. Every fold helper normalizes
// through the shared `.nullish()`-tolerant normalizers first, so a stored
// shape becomes an all-numeric object before arithmetic runs (mirrors
// `research/ingestion/rollup.ts`'s `foldCounters`).
// ---------------------------------------------------------------------------

export type EnrichmentCountsDelta = Partial<Record<keyof ResearchEnrichmentCounts, number>>;
export type EnrichmentCohortCountsDelta = Partial<
  Record<keyof ResearchEnrichmentCohortCounts, number>
>;

/**
 * `Required<ResearchEnrichmentCounts>` (the normalizer's own declared
 * return type) removes optionality but NOT the schema's `| null` union
 * member, so a consumer doing arithmetic over the normalized/folded result
 * sees a possibly-null type even though every value is always a real
 * number at runtime. These two mapped types say what the fold helpers
 * ACTUALLY return — every member remapped to a plain `number` — so callers
 * (including this module's own test suite) can sum members without a
 * defensive `?? 0` at every use site.
 */
export type NormalizedEnrichmentCounts = { [K in keyof ResearchEnrichmentCounts]-?: number };
export type NormalizedEnrichmentCohortCounts = {
  [K in keyof ResearchEnrichmentCohortCounts]-?: number;
};

/** Folding two counter deltas sums every member and treats an absent member as zero. Floors every result at zero. */
export function foldEnrichmentCounters(
  current: ResearchEnrichmentCounts | null | undefined,
  delta: EnrichmentCountsDelta,
): NormalizedEnrichmentCounts {
  const base = normalizeResearchEnrichmentCounts(current);
  const result = {} as NormalizedEnrichmentCounts;
  for (const key of Object.keys(base) as (keyof ResearchEnrichmentCounts)[]) {
    result[key] = Math.max(0, (base[key] ?? 0) + (delta[key] ?? 0));
  }
  return result;
}

/** Same fold discipline as `foldEnrichmentCounters`, over the three-cohort split. */
export function foldEnrichmentCohortCounts(
  current: ResearchEnrichmentCohortCounts | null | undefined,
  delta: EnrichmentCohortCountsDelta,
): NormalizedEnrichmentCohortCounts {
  const base = normalizeResearchEnrichmentCohortCounts(current);
  const result = {} as NormalizedEnrichmentCohortCounts;
  for (const key of Object.keys(base) as (keyof ResearchEnrichmentCohortCounts)[]) {
    result[key] = Math.max(0, (base[key] ?? 0) + (delta[key] ?? 0));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cohort classification — the artifact Phase 31's cohort-composition
// requirement (EVID-02) consumes.
// ---------------------------------------------------------------------------

export type StageCohort = 'startggOnly' | 'liquipediaSupplemented' | 'missing';

/**
 * A TOTAL function over the three cohorts — every game row lands in
 * EXACTLY one, so folding a tenant's rows through this and
 * `foldEnrichmentCohortCounts` always sums to the classified total with no
 * row counted twice and none omitted.
 *
 * A resolved provider stage is ALWAYS the start.gg-only cohort, even when
 * an enrichment observation also exists for the row — start.gg is
 * authoritative wherever it already has an answer (30.2-CONTEXT.md). Only
 * a row still carrying the unknown sentinel after ingestion can fall
 * through to enrichment's witness, and only a witness that actually
 * projected a stage id counts as supplemented; everything else is an
 * honest `missing` — unknown stays visibly unknown, never inferred.
 */
export function classifyStageCohort(row: {
  providerStageId: number;
  witness: ResearchEnrichmentProjectionStateRecord | null;
}): StageCohort {
  if (row.providerStageId !== PROVIDER_STAGE_UNKNOWN_ID) {
    return 'startggOnly';
  }
  if (row.witness?.projectedStageId != null) {
    return 'liquipediaSupplemented';
  }
  return 'missing';
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StageEnrichmentProgressInput {
  tenantId: string;
  runId: string;
  countsDelta?: EnrichmentCountsDelta;
  cohortCountsDelta?: EnrichmentCohortCountsDelta;
  now?: number;
}

/**
 * Folds a counts/cohort-counts delta into `researchEnrichmentCoverage/
 * {tenantId}` through ONE transaction — never a read-fold-write outside it
 * (PATTERNS.md section 8, CR-01 discipline): a read-fold-write outside a
 * transaction loses a concurrent invocation's contribution, because the
 * second writer's fold starts from a snapshot the first writer may already
 * have replaced. Folding inside the transaction callback makes the
 * operation relative to whatever value actually commits, so two concurrent
 * contributions both survive.
 *
 * Existing `perSourcePage`/`notes` are preserved untouched — only
 * `counts`/`cohortCounts`/`runId`/`asOfMs` move here. The freshness map and
 * notes are `publishEnrichmentCoverage`'s job, not this one's, so a run can
 * stage many small counter contributions (one per classified row, one per
 * extracted observation) without repeatedly rebuilding the freshness map.
 */
export async function stageEnrichmentProgress(
  database: Database,
  input: StageEnrichmentProgressInput,
): Promise<ResearchEnrichmentCoverageSnapshot> {
  if (!isPathSafeTenantId(input.tenantId)) {
    throw new Error('stageEnrichmentProgress: unsafe tenantId');
  }
  const nowMs = input.now ?? Date.now();
  let outcome: ResearchEnrichmentCoverageSnapshot | null = null;

  await coverageRef(database, input.tenantId).transaction((raw) => {
    const existing = parseSnapshot(raw);
    const counts = foldEnrichmentCounters(existing?.counts, input.countsDelta ?? {});
    const cohortCounts = foldEnrichmentCohortCounts(
      existing?.cohortCounts,
      input.cohortCountsDelta ?? {},
    );
    const snapshot = researchEnrichmentCoverageSnapshotSchema.parse({
      asOfMs: nowMs,
      runId: input.runId,
      counts,
      cohortCounts,
      ...(existing?.perSourcePage != null ? { perSourcePage: existing.perSourcePage } : {}),
      ...(existing?.notes != null ? { notes: existing.notes } : {}),
    });
    outcome = snapshot;
    return snapshot;
  });

  if (!outcome) {
    throw new Error('stageEnrichmentProgress: transaction did not commit a snapshot');
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface EnrichmentFreshnessEntryInput {
  /**
   * The Liquipedia page title this entry's `sourcePageUrl` is derived from,
   * via `buildLiquipediaPageUrl`, at publish time (cycle-1 review HIGH 5) —
   * NEVER left for the panel to derive downstream. Omitting it (a
   * forgetful caller) is exactly the case the stored schema's REQUIRED
   * `sourcePageUrl` member rejects: publishing a freshness entry without a
   * source page URL is impossible, not merely discouraged.
   */
  pageTitle?: string;
  revisionId: number;
  contentHash: string;
  fetchedAtMs: number;
  observationCount: number;
}

export interface PublishEnrichmentCoverageInput {
  tenantId: string;
  runId: string;
  now?: number;
  perSourcePage?: Record<string, EnrichmentFreshnessEntryInput>;
  /** The home for the IzAw honest-zero reason and similar disclosed-gap notes — a player with no source page contributes an explicit zero row and a note, rather than being omitted. */
  notes?: string[];
}

export interface PublishEnrichmentCoverageResult {
  published: boolean;
  reason: 'published' | 'unchanged';
  snapshot: ResearchEnrichmentCoverageSnapshot;
}

/**
 * The one-time side effect that finalizes a run's coverage: builds the
 * per-source-page freshness map (deriving each entry's `sourcePageUrl` from
 * `buildLiquipediaPageUrl` — never left for the panel to derive), attaches
 * the notes array, and records `coveragePublishedAtMs` on the run via
 * `markEnrichmentCoveragePublished` (a no-op when no matching completed run
 * is stored, exactly like the module it mirrors). Preserves whatever
 * `counts`/`cohortCounts` `stageEnrichmentProgress` has already
 * accumulated for this tenant — this function never folds a counter delta
 * itself.
 *
 * NEVER called from inside `stageEnrichmentProgress`'s transaction — the
 * caller must have finished staging every counter contribution for this
 * run before calling this, matching `publishCoverageSnapshot`'s own
 * ordering contract (a publish is a one-time side effect, not a
 * repeatable transaction callback).
 *
 * Republishing a byte-identical snapshot (ignoring `asOfMs`, which is a
 * wall-clock stamp rather than part of the published FACTS) is a no-op: no
 * node write happens, though `markEnrichmentCoveragePublished` is still
 * called (itself idempotent).
 */
export async function publishEnrichmentCoverage(
  database: Database,
  input: PublishEnrichmentCoverageInput,
): Promise<PublishEnrichmentCoverageResult> {
  if (!isPathSafeTenantId(input.tenantId)) {
    throw new Error('publishEnrichmentCoverage: unsafe tenantId');
  }
  const nowMs = input.now ?? Date.now();

  const existing = await readEnrichmentCoverage(database, input.tenantId);

  const perSourcePage = input.perSourcePage
    ? Object.fromEntries(
        Object.entries(input.perSourcePage).map(([pageKey, entry]) => [
          pageKey,
          {
            ...(entry.pageTitle != null
              ? { sourcePageUrl: buildLiquipediaPageUrl(entry.pageTitle) }
              : {}),
            revisionId: entry.revisionId,
            contentHash: entry.contentHash,
            fetchedAtMs: entry.fetchedAtMs,
            observationCount: entry.observationCount,
          },
        ]),
      )
    : undefined;

  const snapshot = researchEnrichmentCoverageSnapshotSchema.parse({
    asOfMs: nowMs,
    runId: input.runId,
    counts: normalizeResearchEnrichmentCounts(existing?.counts),
    cohortCounts: normalizeResearchEnrichmentCohortCounts(existing?.cohortCounts),
    ...(perSourcePage != null ? { perSourcePage } : {}),
    ...(input.notes != null ? { notes: input.notes } : {}),
  });

  const unchanged = existing != null && snapshotContentEqual(existing, snapshot);

  if (!unchanged) {
    await coverageRef(database, input.tenantId).set(snapshot);
  }

  // Idempotent no-op when no matching completed run is stored — this
  // function performs no authorization and no run-status enforcement of
  // its own; that machinery lives entirely in `./runState.js`.
  await markEnrichmentCoveragePublished(database, input.tenantId, input.runId, nowMs);

  return {
    published: !unchanged,
    reason: unchanged ? 'unchanged' : 'published',
    snapshot: unchanged ? existing! : snapshot,
  };
}

/** Compares two snapshots by CONTENT — every member except `asOfMs`, a wall-clock stamp rather than a published fact — so a retry with a later clock reading against otherwise-identical inputs is still recognized as unchanged. */
function snapshotContentEqual(
  a: ResearchEnrichmentCoverageSnapshot,
  b: ResearchEnrichmentCoverageSnapshot,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `asOfMs` is intentionally discarded
  const { asOfMs: _asOfMsA, ...restA } = a;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `asOfMs` is intentionally discarded
  const { asOfMs: _asOfMsB, ...restB } = b;
  return JSON.stringify(canonicalize(restA)) === JSON.stringify(canonicalize(restB));
}

/** Performs NO authorization — copies `readCoverageSnapshot`'s doc-comment contract. Safe-parses to null. */
export async function readEnrichmentCoverage(
  database: Database,
  tenantId: string,
): Promise<ResearchEnrichmentCoverageSnapshot | null> {
  if (!isPathSafeTenantId(tenantId)) {
    return null;
  }
  const snapshot = await coverageRef(database, tenantId).get();
  return parseSnapshot(snapshot.val());
}

// ---------------------------------------------------------------------------
// Field coverage (30.3 Gate 5) — present/missing/ambiguous per evidence field
// ---------------------------------------------------------------------------

interface FieldCell {
  present: number;
  missing: number;
  ambiguous: number;
  latestSourceRevisionId: number | null;
  latestProjectedAtMs: number | null;
}

function emptyCell(): FieldCell {
  return {
    present: 0,
    missing: 0,
    ambiguous: 0,
    latestSourceRevisionId: null,
    latestProjectedAtMs: null,
  };
}

function bump(
  cell: FieldCell,
  state: 'present' | 'missing' | 'ambiguous',
  sourceRevisionId: number | null | undefined,
  projectedAtMs: number | null | undefined,
): void {
  cell[state] += 1;
  if (sourceRevisionId != null) {
    cell.latestSourceRevisionId = Math.max(
      cell.latestSourceRevisionId ?? sourceRevisionId,
      sourceRevisionId,
    );
  }
  if (projectedAtMs != null) {
    cell.latestProjectedAtMs = Math.max(cell.latestProjectedAtMs ?? projectedAtMs, projectedAtMs);
  }
}

function toCellShape(cell: FieldCell): ResearchEnrichmentFieldCoverageCell {
  return {
    present: cell.present,
    missing: cell.missing,
    ambiguous: cell.ambiguous,
    ...(cell.latestSourceRevisionId != null
      ? { latestSourceRevisionId: cell.latestSourceRevisionId }
      : {}),
    ...(cell.latestProjectedAtMs != null ? { latestProjectedAtMs: cell.latestProjectedAtMs } : {}),
  };
}

/**
 * A PURE derivation over the stored ownership witnesses — the directive's
 * "explicit present/missing/ambiguous coverage for stages, characters,
 * stocks, and VODs". The universe is every witnessed match key; per field:
 *
 * - `present`: the witness carries a COMMITTED value (a canonical stage id,
 *   an oriented and fully mapped character pair, a projected stocksLeft, a
 *   projected VOD URL).
 * - `ambiguous`: partial or in-flight evidence — a raw-only stage (source
 *   text recorded, unmapped), a flagged-unmapped character pair (orientation
 *   proven but some raw name unreviewed), or a pending half whose commit has
 *   not landed.
 * - `missing`: the honest remainder — including every ABSTENTION, which is
 *   deliberately indistinguishable from never-observed here: an abstained
 *   value is a value this pipeline does not have.
 *
 * Per field the FRESHEST source revision and projection time are exposed
 * (`latestSourceRevisionId`/`latestProjectedAtMs`), so a surface can state
 * "as of revision N"; `asOfMs` is the caller's read clock.
 */
export function deriveEnrichmentFieldCoverage(
  witnesses: ResearchEnrichmentProjectionStateRecord[],
  asOfMs: number,
): ResearchEnrichmentFieldCoverage {
  const stages = emptyCell();
  const characters = emptyCell();
  const stocks = emptyCell();
  const vods = emptyCell();

  for (const witness of witnesses) {
    // Stage.
    if (witness.projectedStageId != null) {
      bump(stages, 'present', witness.stageSourceRevisionId, witness.stageProjectedAtMs);
    } else if (
      witness.projectedStageRaw != null ||
      witness.pendingStageId != null ||
      witness.pendingStageRaw != null
    ) {
      bump(stages, 'ambiguous', witness.stageSourceRevisionId, witness.stageProjectedAtMs);
    } else {
      bump(stages, 'missing', null, null);
    }

    // Characters.
    const orientationProven = witness.projectedSubjectSeat != null;
    const fullyMapped =
      witness.projectedSubjectFighterId != null && witness.projectedOpponentFighterId != null;
    if (orientationProven && fullyMapped) {
      bump(characters, 'present', witness.charsSourceRevisionId, witness.charsProjectedAtMs);
    } else if (orientationProven) {
      bump(characters, 'ambiguous', witness.charsSourceRevisionId, witness.charsProjectedAtMs);
    } else {
      bump(characters, 'missing', null, null);
    }

    // Stocks.
    if (witness.projectedStocksLeft != null) {
      bump(stocks, 'present', witness.stocksSourceRevisionId, witness.stocksProjectedAtMs);
    } else if (witness.pendingStocksLeft != null) {
      bump(stocks, 'ambiguous', witness.stocksSourceRevisionId, witness.stocksProjectedAtMs);
    } else {
      bump(stocks, 'missing', null, null);
    }

    // VODs.
    if (witness.projectedVodUrl != null) {
      bump(vods, 'present', witness.vodSourceRevisionId, witness.vodProjectedAtMs);
    } else if (witness.pendingVodUrl != null || witness.pendingVodRemoval === true) {
      bump(vods, 'ambiguous', witness.vodSourceRevisionId, witness.vodProjectedAtMs);
    } else {
      bump(vods, 'missing', null, null);
    }
  }

  return {
    asOfMs,
    witnessedRows: witnesses.length,
    stages: toCellShape(stages),
    characters: toCellShape(characters),
    stocks: toCellShape(stocks),
    vods: toCellShape(vods),
  };
}

/** Reads the tenant's witness tree and derives the field coverage; `null` when the tenant has no witness tree at all (nothing enriched yet). Performs NO authorization, like every reader in this module. */
export async function readEnrichmentFieldCoverage(
  database: Database,
  tenantId: string,
  asOfMs: number,
): Promise<ResearchEnrichmentFieldCoverage | null> {
  if (!isPathSafeTenantId(tenantId)) {
    return null;
  }
  const snapshot = await database.ref(`researchEnrichmentProjection/${tenantId}`).get();
  const raw = snapshot.val() as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const witnesses: ResearchEnrichmentProjectionStateRecord[] = [];
  for (const value of Object.values(raw)) {
    const parsed = researchEnrichmentProjectionStateRecordSchema.safeParse(value);
    if (parsed.success) {
      witnesses.push(parsed.data);
    }
  }
  return deriveEnrichmentFieldCoverage(witnesses, asOfMs);
}

/**
 * The ONE composer both HTTP surfaces use (`GET /research/tenants/:tenantId/
 * enrichment/coverage` and `composeCoverageResponse`'s `enrichment`
 * member): the STORED snapshot plus the READ-TIME field coverage. Returns
 * `null` when no snapshot has ever been published — field coverage alone
 * never fabricates an enrichment presence for a tenant no run has touched.
 */
export async function composeEnrichmentCoverageResponse(
  database: Database,
  tenantId: string,
  asOfMs: number = Date.now(),
): Promise<ResearchEnrichmentCoverageResponse | null> {
  const snapshot = await readEnrichmentCoverage(database, tenantId);
  if (!snapshot) {
    return null;
  }
  const fieldCoverage = await readEnrichmentFieldCoverage(database, tenantId, asOfMs);
  return {
    ...snapshot,
    ...(fieldCoverage != null ? { fieldCoverage } : {}),
  };
}
