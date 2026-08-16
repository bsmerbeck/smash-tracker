import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
  LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
  buildEnrichmentObservationId,
  type EnrichmentStageOutcome,
  type ResearchEnrichmentAttachmentRecord,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import {
  LiquipediaApiError,
  LIQUIPEDIA_MAX_TITLES_PER_REQUEST,
  buildLiquipediaPageUrl,
  resolveLiquipediaRetryDelayMs,
  type LiquipediaClient,
} from '../../liquipedia/client.js';
import {
  isLiquipediaPageFresh,
  readLiquipediaPageCache,
  writeLiquipediaPageCache,
  type LiquipediaPageCacheRecord,
} from '../../liquipedia/revisionCache.js';
import { resolvePlayerVodPages } from '../../liquipedia/playerPages.js';
import { extractVodListRows, toVodObservationRecords } from '../../liquipedia/adapters/vodList.js';
import { detectTemplateFamily, hashWikitext } from '../../liquipedia/wikitext.js';
import { extractEventContext, type LiquipediaEventContext } from '../../liquipedia/eventContext.js';
import { extractLegacyBracketObservations } from '../../liquipedia/adapters/legacyBracket.js';
import { extractMatch2BracketObservations } from '../../liquipedia/adapters/match2Bracket.js';
import { buildCandidateIndex } from './candidateIndex.js';
import {
  computeObservationPersistenceHash,
  createObservationIdCollisionGuard,
  prepareAndValidateObservation,
} from './prepareObservation.js';
import { buildResolutionReceipt, resolveObservation } from './resolution.js';
import {
  attachResolvedObservation,
  listAttachedTargetSetIds,
  listAttachmentsForSet,
  listEnrichmentObservations,
  listEnrichmentReviewQueue,
  listRawObservationVersionIndex,
  listReceiptedObservationIds,
  readEnrichmentObservation,
  removeSupersededObservations,
  sweepOutdatedFamilyObservations,
  writeEnrichmentObservation,
  writeResolutionReceipt,
} from './store.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
  previewEnrichmentProjection,
  type EnrichmentProjectionCounts,
} from './projection.js';
import {
  publishEnrichmentCoverage,
  stageEnrichmentProgress,
  type EnrichmentCohortCountsDelta,
  type EnrichmentCountsDelta,
} from './rollup.js';
import {
  ENRICHMENT_LEASE_TTL_MS,
  acquireEnrichmentRunLease,
  advanceEnrichmentRunState,
  completeEnrichmentRun,
  createOrResumeEnrichmentRun,
  failEnrichmentRun,
  readActiveEnrichmentRun,
  renewEnrichmentRunLease,
  type EnrichmentRunCursor,
  type EnrichmentRunLeaseHolder,
} from './runState.js';

/**
 * Phase 30.2 Plan 09 (ENR-05/ENR-06/ENR-10, cycle-1 review MEDIUM 7, cycle-2
 * review MEDIUM 8): the enrichment pipeline executor — the shipped batch-
 * executor composition shape (`apps/api/src/jobs/researchBackfillBatch.ts`)
 * applied to the Liquipedia corpus: resolve player pages, extract VOD rows,
 * enumerate tournament child pages, batch-probe head revisions, fetch only
 * the changed subset, detect family and extract, build the candidate index
 * once, resolve, persist a receipt for each matched outcome, attach,
 * project.
 *
 * THE FRESHNESS ASYMMETRY (cycle-1 review MEDIUM 8 — the reason this module
 * exists in the shape it does, restated here because a reader must never
 * come away believing both page classes share one skip guarantee):
 *
 * - WIKITEXT class (bracket/tournament pages): the freshness key is the
 *   batched head-revision probe (revision id + sha1) — CHEAP, and knowable
 *   BEFORE any content fetch. An unchanged page is skipped BEFORE
 *   `client.getWikitext` is ever called: no content request is issued, no
 *   re-extraction happens, no write happens. This class genuinely honours
 *   "freshness before budget."
 * - GENERATED class (player `/VODs` pages): the freshness key is the HASH OF
 *   THE PARSE OUTPUT, which cannot exist before the parse-class request has
 *   already been made and its budget already spent (`revisionCache.ts`'s
 *   ENR-10 hazard doc: the wikitext is a frozen two-template stub whose
 *   revision id predates the live-rendered content by years). This module
 *   therefore issues `client.getGeneratedVodPage` UNCONDITIONALLY for every
 *   resolved, present, deduped VOD page, and only AFTER that fetch checks
 *   `isLiquipediaPageFresh` against the extracted content's own hash. A
 *   cache hit here performs no re-extraction and no write, but it does NOT
 *   avoid the parse-class request — that would be a claim this page class
 *   cannot honestly make, and the previous draft this plan replaces made it
 *   anyway. NEVER state or test that this class "skips before budget."
 *
 * THE RECEIPT SEAM (cycle-1 review MEDIUM 7, cycle-2 review HIGH 1): every
 * matched resolution is persisted through `writeResolutionReceipt` BEFORE
 * `attachResolvedObservation` is ever called, and the attachment writer is
 * handed IDENTIFIERS ONLY (`observationId`, `receiptId`) — never the
 * resolver outcome, never the observation record itself. A receipt write
 * that is refused (a rejected outcome from `writeResolutionReceipt`, or an
 * unexpected throw from the database boundary underneath it) is an
 * ABSTENTION, not a failure: the observation is left unattached, counted,
 * and revisited on a later run rather than crashing this one.
 *
 * RTEN-04 INHERITANCE: this module imports no emitter, no ledger, no GA4
 * projector, and no analytics client. `telemetrySilence.test.ts`'s
 * directory-scoped scan (`apps/api/src/research/enrichment`, extended by
 * plan 07) covers this file automatically.
 *
 * THE DRY-RUN GATE is a HARD STRUCTURAL property, not a flag threaded
 * through individual writers: every database WRITE call in this module
 * (`writeLiquipediaPageCache`, `writeEnrichmentObservation`,
 * `writeResolutionReceipt`, `attachResolvedObservation`,
 * `applyEnrichmentProjection`, and every run-state mutator including run
 * CREATION itself) is reached only through an `if (!dryRun)` guard. A dry
 * run therefore never even creates or leases a run record — only a REAL run
 * needs the fenced, resumable machinery, because only a real run persists
 * anything a crash could leave half-done.
 */

// ---------------------------------------------------------------------------
// Cache-key derivation (Claude's discretion, 30.2-CONTEXT.md)
// ---------------------------------------------------------------------------

/**
 * `liquipediaPageCache/{pageId}` keys must be RTDB-path-safe
 * (`isPathSafeProviderId` forbids `/`), and a Liquipedia page title routinely
 * contains one (`Sparg0/VODs`, `Supernova/2026/Ultimate/Singles Bracket`).
 * Every page this module caches is therefore keyed by a stable digest rather
 * than by title or by the wiki's own numeric `pageid` — the latter is
 * unavailable for a `getGeneratedVodPage` call made in the default
 * `expandtemplates` mode (`client.ts`'s `LiquipediaGeneratedPageResult` has
 * no `pageId` member for that mode), so a title-derived key is the only one
 * available uniformly across both page classes.
 *
 * THE KEY IS TENANT-SCOPED (30.2 production defect A, verified forensics):
 * a freshness skip's implicit contract is "this page's observations are
 * already PERSISTED" — and observation persistence is PER-TENANT
 * (`researchEnrichmentObservations/{tenantId}/...`), so the contract is only
 * valid per-tenant. The original tenant-less key let MkLeo's real run mark
 * every shared event page fresh; Sparg0's serialized run 40 minutes later
 * skip-before-fetched those pages and silently never stored its own
 * observations from them (2,471 of 10,335 stored). Salting the digest with
 * the tenant id makes the skip decision and the persistence guarantee share
 * one scope by construction. The cost is a per-tenant content re-fetch of
 * shared pages (the batched wikitext content requests) — a correct skip
 * without re-fetching would require storing page CONTENT, which this cache
 * deliberately does not do.
 */
function cacheKeyFor(tenantId: string, title: string, hashHex: (value: string) => string): string {
  return hashHex(`${tenantId}\n${title}`).slice(0, 48);
}

/**
 * The OBSERVATION-level parser version for the wikitext probe pipeline —
 * stamped on unknown-family observation records and used in their
 * deterministic observation-id derivation, deliberately DISTINCT from the
 * per-observation `parserVersion` the legacy/match2 extractors stamp on
 * their own output records
 * (`LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY`/`_MATCH2`). Kept short and
 * stable (the observation schema caps `parserVersion` at 64 and the id
 * derivation must not churn); the page-CACHE freshness version below is the
 * one that composes every family version structurally.
 */
export const WIKITEXT_PROBE_PARSER_VERSION = 'liquipedia-wikitext-probe@1';

/**
 * The page-CACHE-level freshness version for the WIKITEXT class — DERIVED
 * STRUCTURALLY from every family extractor version plus the probe pipeline's
 * own version (30.2 production defect B, verified forensics): the original
 * standalone constant relied on a HUMAN remembering to bump it whenever an
 * adapter changed its extraction output. Nobody did for the Gate 1 adapter
 * changes, so pages cached by the morning old-adapter run were treated as
 * fresh by the evening runs and ~39 of MkLeo's pages silently kept
 * OLD-extraction observations (the match2 zeros and the −142).
 *
 * Composing the family constants makes the bump structural: ANY change to
 * `LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY`,
 * `LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2`, or the probe pipeline version
 * changes THIS string, which `isLiquipediaPageFresh` compares verbatim —
 * every previously cached wikitext page re-extracts automatically, with no
 * discipline left to remember. (Which FAMILY a wikitext page belongs to is
 * only knowable AFTER fetching, so the cache version must cover ALL wikitext
 * families at once.) The GENERATED class needs no equivalent: its cache
 * freshness is already keyed directly at `LIQUIPEDIA_PARSER_VERSION_VOD_LIST`,
 * so a vodlist adapter bump auto-invalidates it today.
 */
export const WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION = [
  WIKITEXT_PROBE_PARSER_VERSION,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
].join('|');

/** Bounds `listSubpages`'s continuation walk per tournament prefix (RESEARCH section 8.7) — no traversal in this module ever loops without a caller-visible ceiling. */
const DEFAULT_MAX_SUBPAGE_CONTINUATIONS = 10;

/** Bounded retry budget for a remote rate-limit rejection carrying a `retry-after` signal — this executor has no injected clock/sleep (its whole interface is a single `nowMs` snapshot), so "honouring" the signal means computing the deterministic delay via the shared backoff helper and RETRYING rather than failing the run, not literally sleeping. */
const MAX_CLIENT_CALL_RETRIES = 3;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counters / result shape
// ---------------------------------------------------------------------------

/** Thrown the moment a fenced write (or an explicit renewal) reports the run lease is no longer this invocation's — the run aborts IMMEDIATELY rather than continuing to work without authority (30.2 reliability gate). */
export class EnrichmentRunLeaseLostError extends Error {
  constructor(tenantId: string, runId: string) {
    super(`enrichment run ${runId} for tenant ${tenantId} lost its lease; aborting immediately`);
    this.name = 'EnrichmentRunLeaseLostError';
  }
}

/** Renew when a third of the lease TTL has elapsed — early enough that one missed boundary never lets the lease lapse mid-work. */
const ENRICHMENT_LEASE_RENEW_INTERVAL_MS = Math.floor(ENRICHMENT_LEASE_TTL_MS / 3);

/**
 * One work-unit boundary notification (30.2 reliability gate) — the seam the
 * operator's heartbeat/stall watchdog observes. Emitted at real work-unit
 * boundaries (a page, a probe chunk, an observation, a target set), never on
 * a timer of this module's own.
 */
export interface EnrichmentRunProgressEvent {
  stage:
    | 'discovery'
    | 'expansion'
    | 'probe'
    | 'extraction'
    | 'resolution'
    | 'projection'
    | 'reconciliation';
  /** The unit just completed — a page title, an observation id, a target set id. */
  unit?: string;
  counts: EnrichmentBatchCounts;
}

export interface EnrichmentBatchCounts {
  playersRequested: number;
  vodPagesPresent: number;
  vodPagesMissing: number;
  vodPageProbeRequests: number;
  parseClassRequestsIssued: number;
  generatedCacheHits: number;
  pagesFetched: number;
  vodRowsExtracted: number;
  tournamentPagesDiscovered: number;
  factPagesEnumerated: number;
  probeRequestCount: number;
  contentRequestsIssued: number;
  wikitextCacheHits: number;
  familyLegacy: number;
  familyMatch2: number;
  familyUnknown: number;
  observationsExtracted: number;
  candidateIndexBuildCount: number;
  resolvedMatched: number;
  resolvedAmbiguous: number;
  resolvedUnmatched: number;
  resolvedConflicting: number;
  receiptsWritten: number;
  attachmentsCreated: number;
  attachmentsAbstained: number;
  projectionsApplied: number;
  /** Attached sets reprojected by the resume-reconciliation pass because their overlay keys lacked a witness (or held a pending half) — see `reconcileAttachedSets`. */
  projectionsReconciled: number;
  /** Stored observations removed by the per-page stale-parser supersede pass (30.2 defect-C re-key reconciliation) — old-version records for a page this run re-extracted, cascaded with their receipts and attachments. */
  observationsSuperseded: number;
  /** Stored bracket-family records removed by the END-OF-GATHER version-wide sweep — outdated-parser records on pages the current expansion no longer visits, which the page-scoped pass can never reach. */
  outdatedFamilyRecordsSwept: number;
  backoffEvents: number;
}

function emptyCounts(): EnrichmentBatchCounts {
  return {
    playersRequested: 0,
    vodPagesPresent: 0,
    vodPagesMissing: 0,
    vodPageProbeRequests: 0,
    parseClassRequestsIssued: 0,
    generatedCacheHits: 0,
    pagesFetched: 0,
    vodRowsExtracted: 0,
    tournamentPagesDiscovered: 0,
    factPagesEnumerated: 0,
    probeRequestCount: 0,
    contentRequestsIssued: 0,
    wikitextCacheHits: 0,
    familyLegacy: 0,
    familyMatch2: 0,
    familyUnknown: 0,
    observationsExtracted: 0,
    candidateIndexBuildCount: 0,
    resolvedMatched: 0,
    resolvedAmbiguous: 0,
    resolvedUnmatched: 0,
    resolvedConflicting: 0,
    receiptsWritten: 0,
    attachmentsCreated: 0,
    attachmentsAbstained: 0,
    projectionsApplied: 0,
    projectionsReconciled: 0,
    observationsSuperseded: 0,
    outdatedFamilyRecordsSwept: 0,
    backoffEvents: 0,
  };
}

export interface EnrichmentBatchResult {
  runId: string | null;
  dryRun: boolean;
  /** `true` when this invocation found the gather phase already complete (a prior invocation's persisted `cursor.stage === 'projection'`) and issued NO fetch of any kind. */
  resumedAtProjection: boolean;
  counts: EnrichmentBatchCounts;
  /** Review evidence emitted only from the structurally read-only path. */
  dryRunDetails?: EnrichmentDryRunDetails;
}

export interface EnrichmentDryRunCandidate {
  observationId: string;
  sourcePageTitle: string;
  outcome: 'ambiguous' | 'conflicting';
  candidateTargetSetIds: string[];
  evidence: string[];
  reasons: string[];
}

export interface EnrichmentDryRunMatch {
  observationId: string;
  sourcePageTitle: string;
  targetSetId: string;
  evidence: string[];
}

export interface EnrichmentDryRunSourceRevision {
  sourcePageTitle: string;
  sourcePageUrl: string;
  sourceRevisionId: number;
  fetchedAtMs: number;
  parserVersion: string;
}

export interface EnrichmentDryRunDetails {
  gamesWithCanonicalStage: number;
  gamesWithStageForm: number;
  gamesWithoutCanonicalStage: number;
  vodWouldFillEmpty: number;
  vodWouldSkipUserOwned: number;
  stageWouldEnrich: number;
  sourceRevisions: EnrichmentDryRunSourceRevision[];
  extractorVersions: string[];
  matchedCandidates: EnrichmentDryRunMatch[];
  reviewCandidates: EnrichmentDryRunCandidate[];
  missingSourcePages: Array<{ playerLabel: string; pageTitle: string; reason: string }>;
  /**
   * 30.2 reliability gate: the canonical digest over EVERY schema-parsed
   * observation this dry run gathered — the exact records apply would
   * persist, not merely their counts (see
   * `prepareObservation.ts`'s `computeObservationPersistenceHash`).
   */
  observationPersistenceHash: string;
  /** The number of records `observationPersistenceHash` covers. */
  observationsValidated: number;
}

function emptyDryRunDetails(): EnrichmentDryRunDetails {
  return {
    gamesWithCanonicalStage: 0,
    gamesWithStageForm: 0,
    gamesWithoutCanonicalStage: 0,
    vodWouldFillEmpty: 0,
    vodWouldSkipUserOwned: 0,
    stageWouldEnrich: 0,
    sourceRevisions: [],
    extractorVersions: [],
    matchedCandidates: [],
    reviewCandidates: [],
    missingSourcePages: [],
    observationPersistenceHash: computeObservationPersistenceHash([]),
    observationsValidated: 0,
  };
}

export interface RunEnrichmentBatchInput {
  database: Database;
  client: LiquipediaClient;
  tenantId: string;
  playerLabels: string[];
  targetGame: string;
  sliceFilter?: { earliestYear?: number };
  maxPages?: number;
  nowMs: number;
  hashHex: (value: string) => string;
  dryRun: boolean;
  /**
   * REAL clock, used ONLY for lease-renewal timing (30.2 reliability gate) —
   * never for any persisted timestamp, which all stay pinned to the `nowMs`
   * snapshot for dry-run/apply hash determinism. Defaults to the frozen
   * snapshot, which disables time-based renewal (tests keep their
   * deterministic single-snapshot behavior).
   */
  now?: () => number;
  /** Work-unit boundary observer — the operator's heartbeat/stall-watchdog seam. Never awaited; must not throw. */
  onProgress?: (event: EnrichmentRunProgressEvent) => void;
}

// ---------------------------------------------------------------------------
// Client-call retry (retry-after honoured, no real sleep — see module header)
// ---------------------------------------------------------------------------

async function callWithRetry<T>(fn: () => Promise<T>, counts: EnrichmentBatchCounts): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const retryable =
        error instanceof LiquipediaApiError &&
        (error.retryAfter != null || error.status === 429) &&
        attempt < MAX_CLIENT_CALL_RETRIES;
      if (!retryable) {
        throw error;
      }
      // Computed for parity with the shared backoff helper (deterministic,
      // finite, non-negative) even though this executor has no sleep
      // primitive to spend it against — the honouring this behavior list
      // item requires is "the run resumes rather than failing," which the
      // retry loop below delivers.
      resolveLiquipediaRetryDelayMs(error, attempt);
      counts.backoffEvents += 1;
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Event-context merge (bracket page's own declarations win; the tournament
// parent page — fetched separately, or recovered from a prior run's
// persisted observations when unchanged — fills what the bracket page never
// carries: startgg slug, dates, display name)
// ---------------------------------------------------------------------------

interface EventContextFallback {
  startggSlug: string | null;
  tournamentDisplayName: string | null;
  game: string | null;
}

function mergeEventContext(
  bracketCtx: LiquipediaEventContext,
  tournamentCtx: LiquipediaEventContext | null,
  fallback: EventContextFallback | null,
): LiquipediaEventContext {
  const source: EventContextFallback | null = tournamentCtx ?? fallback;
  if (!source) {
    return bracketCtx;
  }
  return {
    ...bracketCtx,
    startggSlug: bracketCtx.startggSlug ?? source.startggSlug,
    tournamentDisplayName: bracketCtx.tournamentDisplayName ?? source.tournamentDisplayName,
    game: bracketCtx.game ?? source.game,
  };
}

/** Recovers a tournament's previously-declared startgg slug / display name / game from ANY already-persisted bracket observation under it — used only when the tournament page itself is unchanged this run (freshness-skipped) and therefore was never re-fetched. */
async function deriveFallbackEventContext(
  database: Database,
  tenantId: string,
  tournamentPageTitle: string,
): Promise<EventContextFallback | null> {
  const all = await listEnrichmentObservations(database, tenantId);
  const match = all.find(
    (record) =>
      record.tournamentPageTitle === tournamentPageTitle && record.tournamentStartggSlug != null,
  );
  if (!match) {
    return null;
  }
  return {
    startggSlug: match.tournamentStartggSlug ?? null,
    tournamentDisplayName: match.tournamentDisplayName ?? null,
    game: match.game ?? null,
  };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function runEnrichmentBatch(
  input: RunEnrichmentBatchInput,
): Promise<EnrichmentBatchResult> {
  const { database, client, tenantId, playerLabels, targetGame, maxPages, nowMs, hashHex, dryRun } =
    input;
  const earliestYear = input.sliceFilter?.earliestYear;

  const counts = emptyCounts();
  const dryRunDetails = dryRun ? emptyDryRunDetails() : undefined;
  counts.playersRequested = playerLabels.length;

  let runId: string | null = null;
  let holder: EnrichmentRunLeaseHolder | null = null;
  let resumedAtProjection = false;

  if (!dryRun) {
    const created = await createOrResumeEnrichmentRun(database, tenantId, nowMs);
    runId = created.runId;
    const lease = await acquireEnrichmentRunLease(database, tenantId, runId, randomUUID(), nowMs);
    if (!lease.acquired || !lease.holder) {
      return { runId, dryRun, resumedAtProjection: false, counts };
    }
    holder = lease.holder;
    const active = await readActiveEnrichmentRun(database, tenantId);
    resumedAtProjection = active?.cursor?.stage === 'projection';
  }

  // 30.2 reliability gate: the work-unit boundary ticker. Every phase calls
  // `tick` after completing one real unit of work; it (a) notifies the
  // caller's progress observer (the operator's heartbeat/stall watchdog),
  // and (b) RENEWS the run lease when a third of its TTL has elapsed on the
  // REAL clock, aborting immediately (EnrichmentRunLeaseLostError) if the
  // renewal reports the lease is no longer this invocation's. A dry run has
  // no lease, so only (a) applies.
  const realNow = input.now ?? (() => nowMs);
  let lastRenewedAtMs = realNow();
  const tick = async (stage: EnrichmentRunProgressEvent['stage'], unit?: string): Promise<void> => {
    input.onProgress?.({ stage, ...(unit != null ? { unit } : {}), counts });
    if (dryRun || !runId || !holder) {
      return;
    }
    if (realNow() - lastRenewedAtMs < ENRICHMENT_LEASE_RENEW_INTERVAL_MS) {
      return;
    }
    const renewed = await renewEnrichmentRunLease(database, tenantId, runId, holder, realNow());
    if (!renewed) {
      throw new EnrichmentRunLeaseLostError(tenantId, runId);
    }
    lastRenewedAtMs = realNow();
  };

  // Durable-cursor advancement at real work-unit boundaries (real runs
  // only). A `lease-lost` outcome aborts immediately; `absent`/`terminal`
  // cannot legitimately occur mid-run and abort the same way rather than
  // silently continuing without a run to advance.
  const advanceCursor = async (cursor: EnrichmentRunCursor): Promise<void> => {
    if (dryRun || !runId || !holder) {
      return;
    }
    const result = await advanceEnrichmentRunState(database, tenantId, runId, holder, { cursor });
    if (result.outcome !== 'applied') {
      throw new EnrichmentRunLeaseLostError(tenantId, runId);
    }
  };

  // Every observation this INVOCATION gathers, in memory — the dry-run
  // resolution/projection pass reads from here (there is nothing persisted
  // to read back); a real run instead re-reads from the database below, so
  // a genuinely resumed invocation (gather skipped) still resolves whatever
  // a PRIOR invocation persisted.
  const gatheredObservations: ResearchEnrichmentObservationRecord[] = [];

  // COLLISION-LOUD parity (30.2 defect C): every gathered observation
  // registers its id here; a duplicate within one gather aborts the run at
  // extraction time — dry-run and apply alike — instead of letting the
  // store's upsert-by-id silently drop a record.
  const registerObservationId = createObservationIdCollisionGuard();

  // The stale-parser supersede index (30.2 defect-C re-key reconciliation):
  // a snapshot of the tenant's PRE-RUN observations, grouped by source page.
  // After a page is re-extracted this run, any indexed record for that page
  // whose parserVersion differs from the version this extraction used is
  // provably a prior parser generation's record — its new-id twin has just
  // been written — and is removed (with its receipt and attachments) so
  // coverage and the review queue never hold old+new twins. Records at the
  // CURRENT version are never touched (a same-version shrink is refresh.ts's
  // shrink-guard jurisdiction). Read ONCE at run start — records written
  // during this run all carry the current versions and never enter it.
  const staleObservationIndex: Map<
    string,
    { observationId: string; parserVersion: string }[]
  > | null = !dryRun && !resumedAtProjection ? new Map() : null;

  try {
    if (staleObservationIndex) {
      // RAW read (30.2 schema-blind-hygiene defect): old-generation records
      // are malformed by definition once the schema has evolved past them,
      // and a schema-validating read would silently hide exactly the
      // records this index exists to supersede.
      for (const entry of await listRawObservationVersionIndex(database, tenantId)) {
        if (entry.sourcePageTitle === null || entry.parserVersion === null) {
          continue;
        }
        const entries = staleObservationIndex.get(entry.sourcePageTitle) ?? [];
        entries.push({ observationId: entry.observationId, parserVersion: entry.parserVersion });
        staleObservationIndex.set(entry.sourcePageTitle, entries);
      }
    }

    if (!resumedAtProjection) {
      await gatherPhase({
        database,
        client,
        tenantId,
        playerLabels,
        targetGame,
        earliestYear,
        maxPages,
        nowMs,
        hashHex,
        dryRun,
        counts,
        gatheredObservations,
        dryRunDetails,
        tick,
        advanceCursor,
        registerObservationId,
        staleObservationIndex,
      });

      if (!dryRun && runId && holder) {
        await advanceEnrichmentRunState(database, tenantId, runId, holder, {
          cursor: { stage: 'projection' },
        });
      }
    }

    // THE VERSION-WIDE STALE-RECORD SWEEP (30.2 follow-up): the page-scoped
    // supersede pass above only reaches pages this run re-extracted; a
    // parser bump also strands old-generation records on pages the current
    // expansion no longer visits. Every real run therefore ends its gather
    // with a version-wide sweep of outdated bracket-family records, so a
    // future parser bump self-cleans without a manual step. Runs before
    // resolution so stale records never re-enter this run's review queue.
    if (!dryRun) {
      const swept = await sweepOutdatedFamilyObservations(database, tenantId);
      counts.outdatedFamilyRecordsSwept += swept.removedObservationIds.length;
    }

    await resolveAndProjectPhase({
      database,
      tenantId,
      runId,
      nowMs,
      dryRun,
      counts,
      gatheredObservations,
      dryRunDetails,
      tick,
    });

    if (!dryRun && runId && holder) {
      await completeEnrichmentRun(database, tenantId, runId, holder, nowMs);
      // THE COVERAGE-PUBLICATION SEAM (Rule 1 — the known gap plan 30.2-10's
      // executor flagged: `rollup.ts`'s stage/publish pair landed in wave 7,
      // one wave after this driver, and nothing wired them together until
      // now). `publishEnrichmentCoverage` is called ONLY after
      // `completeEnrichmentRun` commits, mirroring `rollup.ts`'s own
      // documented ordering contract (a publish is a one-time side effect
      // that also stamps `coveragePublishedAtMs` via
      // `markEnrichmentCoveragePublished`, which is a no-op unless the run
      // is already `completed`). The counter/cohort DELTAS themselves are
      // staged earlier, inside `resolveAndProjectPhase`, through
      // `stageEnrichmentProgress` — staging happens per-run-invocation
      // (every invocation's own delta), publication happens once per
      // invocation after completion.
      await publishEnrichmentCoverage(database, { tenantId, runId, now: nowMs });
    }
  } catch (error) {
    if (!dryRun && runId && holder) {
      await failEnrichmentRun(
        database,
        tenantId,
        runId,
        holder,
        error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
        nowMs,
      );
    }
    throw error;
  }

  return {
    runId,
    dryRun,
    resumedAtProjection,
    counts,
    ...(dryRunDetails ? { dryRunDetails } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gather phase: discovery -> expansion -> probe -> extraction
// ---------------------------------------------------------------------------

interface GatherPhaseInput {
  database: Database;
  client: LiquipediaClient;
  tenantId: string;
  playerLabels: string[];
  targetGame: string;
  earliestYear: number | undefined;
  maxPages: number | undefined;
  nowMs: number;
  hashHex: (value: string) => string;
  dryRun: boolean;
  counts: EnrichmentBatchCounts;
  gatheredObservations: ResearchEnrichmentObservationRecord[];
  dryRunDetails: EnrichmentDryRunDetails | undefined;
  tick: (stage: EnrichmentRunProgressEvent['stage'], unit?: string) => Promise<void>;
  advanceCursor: (cursor: EnrichmentRunCursor) => Promise<void>;
  /** The per-gather duplicate-id guard (30.2 defect C) — throws on the second sighting of an id. */
  registerObservationId: (record: ResearchEnrichmentObservationRecord) => void;
  /** Pre-run observation snapshot by source page for the stale-parser supersede pass; `null` on dry runs and projection resumes. */
  staleObservationIndex: Map<string, { observationId: string; parserVersion: string }[]> | null;
}

async function gatherPhase(input: GatherPhaseInput): Promise<void> {
  const {
    database,
    client,
    tenantId,
    playerLabels,
    targetGame,
    earliestYear,
    maxPages,
    nowMs,
    hashHex,
    dryRun,
    counts,
    gatheredObservations,
    dryRunDetails,
    tick,
    advanceCursor,
    registerObservationId,
    staleObservationIndex,
  } = input;

  /** Removes the re-extracted page's prior-parser-generation records (with receipts/attachments) — see the index's doc comment in `runEnrichmentBatch`. */
  async function supersedeStaleForPage(
    sourcePageTitle: string,
    currentParserVersion: string,
  ): Promise<void> {
    if (!staleObservationIndex) {
      return;
    }
    const staleIds = (staleObservationIndex.get(sourcePageTitle) ?? [])
      .filter((entry) => entry.parserVersion !== currentParserVersion)
      .map((entry) => entry.observationId);
    if (staleIds.length === 0) {
      return;
    }
    const { removedObservationIds } = await removeSupersededObservations(
      database,
      tenantId,
      staleIds,
    );
    counts.observationsSuperseded += removedObservationIds.length;
  }

  // --- Discovery: resolve player VOD pages, dedupe, fetch + extract -------
  const resolved = await callWithRetry(() => resolvePlayerVodPages(client, playerLabels), counts);
  counts.vodPageProbeRequests += 2; // resolvePlayerVodPages issues at most two headRevisions batches (player titles, then deduped VOD titles).

  const presentByTitle = new Map<string, (typeof resolved.resolved)[number]>();
  for (const entry of resolved.resolved) {
    if (!entry.present) {
      counts.vodPagesMissing += 1;
      dryRunDetails?.missingSourcePages.push({
        playerLabel: entry.label,
        pageTitle: entry.vodPageTitle,
        reason: 'Liquipedia player VOD page is missing',
      });
      continue;
    }
    if (!presentByTitle.has(entry.vodPageTitle)) {
      presentByTitle.set(entry.vodPageTitle, entry);
    }
  }
  counts.vodPagesPresent = presentByTitle.size;

  const tournamentPageTitles = new Set<string>();

  for (const [vodPageTitle, entry] of presentByTitle) {
    // GENERATED class: the parse-class fetch is unavoidable — see module
    // header. Issued UNCONDITIONALLY, never gated by a pre-fetch freshness
    // check.
    const generated = await callWithRetry(() => client.getGeneratedVodPage(vodPageTitle), counts);
    counts.parseClassRequestsIssued += 1;
    counts.pagesFetched += 1;

    const shape = generated.mode === 'parse' ? ('rendered' as const) : ('expanded' as const);
    const extraction = extractVodListRows({
      body: generated.content,
      shape,
      pageTitle: vodPageTitle,
      revisionId: entry.revisionId ?? 0,
      nowMs,
      hashHex,
    });

    const cacheKey = cacheKeyFor(tenantId, vodPageTitle, hashHex);
    const cached = dryRun ? null : await readLiquipediaPageCache(database, cacheKey);
    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'generated', contentHash: extraction.contentHash },
      LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
    );

    if (fresh) {
      counts.generatedCacheHits += 1;
      // No re-extraction, no write — but sibling tournament pages under a
      // fresh VOD page must still be discoverable, so recover them from
      // whatever this source page previously persisted.
      const priorRows = dryRun ? [] : await listEnrichmentObservations(database, tenantId);
      for (const row of priorRows) {
        if (row.sourcePageTitle === vodPageTitle && row.tournamentPageTitle) {
          tournamentPageTitles.add(row.tournamentPageTitle);
        }
      }
      await tick('discovery', vodPageTitle);
      await advanceCursor({ stage: 'discovery', pageTitle: vodPageTitle });
      continue;
    }

    const filteredRows =
      earliestYear == null
        ? extraction.rows
        : extraction.rows.filter((row) => {
            const parsedYear = row.year ? Number.parseInt(row.year, 10) : NaN;
            return Number.isNaN(parsedYear) || parsedYear >= earliestYear;
          });

    counts.vodRowsExtracted += filteredRows.length;
    const records = toVodObservationRecords(filteredRows, {
      sourcePageTitle: vodPageTitle,
      sourcePageUrl: buildLiquipediaPageUrl(vodPageTitle),
      sourceRevisionId: entry.revisionId ?? 0,
      sourceContentHash: extraction.contentHash,
      fetchedAtMs: nowMs,
      observedAtMs: nowMs,
      hashHex,
      subjectPlayerLabel: entry.label,
    });

    for (const record of records) {
      // THE PARITY GATE (30.2 reliability): every gathered record passes the
      // exact persistence schema HERE, identically on dry-run and apply —
      // never only at the write boundary. The collision guard makes a
      // duplicate id equally loud (30.2 defect C).
      const prepared = prepareAndValidateObservation(record);
      registerObservationId(prepared);
      gatheredObservations.push(prepared);
      if (prepared.tournamentPageTitle) {
        tournamentPageTitles.add(prepared.tournamentPageTitle);
      }
      if (!dryRun) {
        await writeEnrichmentObservation(database, tenantId, prepared);
      }
    }

    if (!dryRun) {
      await writeLiquipediaPageCache(database, {
        pageId: cacheKey,
        title: vodPageTitle,
        pageClass: 'generated',
        parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
        fetchedAtMs: nowMs,
        contentHash: extraction.contentHash,
        observationCount: records.length,
      });
      await supersedeStaleForPage(vodPageTitle, LIQUIPEDIA_PARSER_VERSION_VOD_LIST);
    }
    // A VOD page whose records are all persisted (and whose page cache is
    // written) is a completed, durable work unit.
    await tick('discovery', vodPageTitle);
    await advanceCursor({ stage: 'discovery', pageTitle: vodPageTitle });
  }

  // --- Expansion: enumerate child fact pages by prefix, continuation-looped, bounded ---
  const factPageTitles = new Set<string>();
  for (const tournamentPageTitle of tournamentPageTitles) {
    const children = await callWithRetry(
      () =>
        client.listSubpages(tournamentPageTitle, {
          maxContinuations: DEFAULT_MAX_SUBPAGE_CONTINUATIONS,
        }),
      counts,
    );
    counts.tournamentPagesDiscovered += 1;
    for (const child of children) {
      factPageTitles.add(child.title);
    }
    // The tournament page's own title is included by `apprefix` semantics
    // (it starts with its own prefix); guarantee it explicitly in case a
    // fixture/live corpus omits the self-match.
    factPageTitles.add(tournamentPageTitle);
    await tick('expansion', tournamentPageTitle);
  }
  counts.factPagesEnumerated = factPageTitles.size;
  await advanceCursor({ stage: 'expansion' });

  const boundedFactPageTitles =
    maxPages != null ? Array.from(factPageTitles).slice(0, maxPages) : Array.from(factPageTitles);

  // --- Probe: batched head revisions, chunked at the client's max title count ---
  const probeResults = new Map<string, { present: boolean; revisionId?: number; sha1?: string }>();
  for (const titleChunk of chunk(boundedFactPageTitles, LIQUIPEDIA_MAX_TITLES_PER_REQUEST)) {
    if (titleChunk.length === 0) {
      continue;
    }
    const probe = await callWithRetry(() => client.headRevisions(titleChunk), counts);
    counts.probeRequestCount += 1;
    for (const page of probe.pages) {
      probeResults.set(page.title, {
        present: page.present,
        revisionId: page.present ? page.revisionId : undefined,
        sha1: page.present ? page.sha1 : undefined,
      });
    }
    await tick('probe');
  }
  await advanceCursor({ stage: 'probe' });

  // --- Decide the changed subset (WIKITEXT skip-before-fetch) -------------
  const changedTitles: string[] = [];
  for (const title of boundedFactPageTitles) {
    const probe = probeResults.get(title);
    if (!probe || !probe.present) {
      continue;
    }
    const cacheKey = cacheKeyFor(tenantId, title, hashHex);
    const cached = dryRun ? null : await readLiquipediaPageCache(database, cacheKey);
    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'wikitext', revisionId: probe.revisionId, sha1: probe.sha1 },
      WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION,
    );
    if (fresh) {
      counts.wikitextCacheHits += 1;
      continue;
    }
    changedTitles.push(title);
  }

  // --- Extraction: fetch only the changed subset, family-detect, extract --
  const tournamentContextByTitle = new Map<string, LiquipediaEventContext>();
  const pendingBracketPages: {
    title: string;
    content: string;
    revisionId?: number;
    sha1?: string;
    contentHash: string;
  }[] = [];

  for (const titleChunk of chunk(changedTitles, LIQUIPEDIA_MAX_TITLES_PER_REQUEST)) {
    if (titleChunk.length === 0) {
      continue;
    }
    const fetched = await callWithRetry(() => client.getWikitext(titleChunk), counts);
    counts.contentRequestsIssued += 1;

    for (const page of fetched.pages) {
      if (!page.present || page.content == null) {
        continue;
      }
      counts.pagesFetched += 1;
      const contentHash = hashWikitext(page.content, hashHex);
      const cacheKey = cacheKeyFor(tenantId, page.title, hashHex);

      if (tournamentPageTitles.has(page.title)) {
        const ctx = extractEventContext({
          wikitext: page.content,
          pageTitle: page.title,
          revisionId: page.revisionId ?? 0,
          sha1: page.sha1 ?? null,
        });
        tournamentContextByTitle.set(page.title, ctx);
        if (!dryRun) {
          await writeLiquipediaPageCache(database, {
            pageId: cacheKey,
            title: page.title,
            pageClass: 'wikitext',
            parserVersion: WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION,
            fetchedAtMs: nowMs,
            revisionId: page.revisionId,
            sha1: page.sha1,
            contentHash,
          });
        }
        continue;
      }

      pendingBracketPages.push({
        title: page.title,
        content: page.content,
        revisionId: page.revisionId,
        sha1: page.sha1,
        contentHash,
      });
    }
    await tick('extraction');
  }

  for (const page of pendingBracketPages) {
    const detected = detectTemplateFamily(page.content);
    const cacheKey = cacheKeyFor(tenantId, page.title, hashHex);

    if (detected.family === 'unknown') {
      counts.familyUnknown += 1;
      const unmatched: ResearchEnrichmentObservationRecord = {
        observationId: buildEnrichmentObservationId(
          {
            sourcePageTitle: page.title,
            parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
            discriminator: 'unknown-family',
          },
          hashHex,
        ),
        sourceProvider: 'liquipedia',
        sourceWiki: 'smash',
        contentType: 'stage-observation',
        sourcePageTitle: page.title,
        sourcePageUrl: buildLiquipediaPageUrl(page.title),
        sourceRevisionId: page.revisionId ?? 0,
        sourceContentHash: page.contentHash,
        parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
        templateFamily: 'unknown',
        fetchedAtMs: nowMs,
        observedAtMs: nowMs,
        matchingStatus: 'unmatched',
        extractionFailed: true,
      };
      const preparedUnmatched = prepareAndValidateObservation(unmatched);
      registerObservationId(preparedUnmatched);
      gatheredObservations.push(preparedUnmatched);
      if (!dryRun) {
        await writeEnrichmentObservation(database, tenantId, preparedUnmatched);
        await writeLiquipediaPageCache(database, {
          pageId: cacheKey,
          title: page.title,
          pageClass: 'wikitext',
          parserVersion: WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION,
          fetchedAtMs: nowMs,
          revisionId: page.revisionId,
          sha1: page.sha1,
          contentHash: page.contentHash,
        });
        await supersedeStaleForPage(page.title, WIKITEXT_PROBE_PARSER_VERSION);
      }
      await tick('extraction', page.title);
      await advanceCursor({ stage: 'extraction', pageTitle: page.title });
      continue;
    }

    const bracketOwnCtx = extractEventContext({
      wikitext: page.content,
      pageTitle: page.title,
      revisionId: page.revisionId ?? 0,
      sha1: page.sha1 ?? null,
    });
    const tournamentCtx = tournamentContextByTitle.get(bracketOwnCtx.tournamentPageTitle) ?? null;
    const fallback =
      tournamentCtx == null && !dryRun
        ? await deriveFallbackEventContext(database, tenantId, bracketOwnCtx.tournamentPageTitle)
        : null;
    const eventContext = mergeEventContext(bracketOwnCtx, tournamentCtx, fallback);

    const extractInput = {
      wikitext: page.content,
      pageTitle: page.title,
      revisionId: page.revisionId ?? 0,
      sha1: page.sha1 ?? null,
      eventContext,
      targetGame,
      nowMs,
      hashHex,
    };
    const extracted =
      detected.family === 'legacy'
        ? extractLegacyBracketObservations(extractInput)
        : extractMatch2BracketObservations(extractInput);

    if (detected.family === 'legacy') {
      counts.familyLegacy += 1;
    } else {
      counts.familyMatch2 += 1;
    }
    counts.observationsExtracted += extracted.observations.length;

    for (const observation of extracted.observations) {
      // THE PARITY GATE (30.2 reliability): see the VOD-record loop above.
      const prepared = prepareAndValidateObservation(observation);
      registerObservationId(prepared);
      gatheredObservations.push(prepared);
      if (!dryRun) {
        await writeEnrichmentObservation(database, tenantId, prepared);
      }
    }

    if (!dryRun) {
      await writeLiquipediaPageCache(database, {
        pageId: cacheKey,
        title: page.title,
        pageClass: 'wikitext',
        parserVersion: WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION,
        fetchedAtMs: nowMs,
        revisionId: page.revisionId,
        sha1: page.sha1,
        contentHash: page.contentHash,
      });
      await supersedeStaleForPage(
        page.title,
        detected.family === 'legacy'
          ? LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY
          : LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
      );
    }
    // A bracket page whose observations are all persisted (and whose page
    // cache is written) is a completed, durable work unit.
    await tick('extraction', page.title);
    await advanceCursor({ stage: 'extraction', pageTitle: page.title });
  }
}

// ---------------------------------------------------------------------------
// Resolution + projection phase
// ---------------------------------------------------------------------------

interface ResolveAndProjectPhaseInput {
  database: Database;
  tenantId: string;
  /** `null` for a dry run (no run is ever created for one — see the module header's dry-run-gate note); a real run's id otherwise, threaded through so this phase can stage its own counter delta. */
  runId: string | null;
  nowMs: number;
  dryRun: boolean;
  counts: EnrichmentBatchCounts;
  gatheredObservations: ResearchEnrichmentObservationRecord[];
  dryRunDetails: EnrichmentDryRunDetails | undefined;
  tick: (stage: EnrichmentRunProgressEvent['stage'], unit?: string) => Promise<void>;
}

/**
 * `EnrichmentStageOutcome` (`@smash-tracker/shared`'s
 * `researchEnrichmentProjection.ts`) IS the three-cohort split ENR-11
 * requires — `resolveEnrichedMatchMembers`'s own stage decision already
 * answers "is this row start.gg-only, Liquipedia-supplemented, or still
 * missing" for the row it just touched, so this map is a RESTATEMENT of
 * `rollup.ts`'s `classifyStageCohort` in terms of the outcome this run's own
 * `applyEnrichmentProjection` call already computed, never a second,
 * independently-derived classification that could disagree with it.
 */
const STAGE_OUTCOME_TO_COHORT: Record<EnrichmentStageOutcome, keyof EnrichmentCohortCountsDelta> = {
  'provider-authoritative': 'startggOnly',
  enriched: 'liquipediaSupplemented',
  unknown: 'missing',
};

async function resolveAndProjectPhase(input: ResolveAndProjectPhaseInput): Promise<void> {
  const {
    database,
    tenantId,
    runId,
    nowMs,
    dryRun,
    counts,
    gatheredObservations,
    dryRunDetails,
    tick,
  } = input;

  if (dryRunDetails) {
    // Every member of `gatheredObservations` has already passed the parity
    // gate, so this digest covers exactly the schema-parsed records apply
    // would persist.
    dryRunDetails.observationPersistenceHash =
      computeObservationPersistenceHash(gatheredObservations);
    dryRunDetails.observationsValidated = gatheredObservations.length;
    const revisions = new Map<string, EnrichmentDryRunSourceRevision>();
    const versions = new Set<string>();
    for (const observation of gatheredObservations) {
      versions.add(observation.parserVersion);
      revisions.set(`${observation.sourcePageTitle}:${observation.sourceRevisionId}`, {
        sourcePageTitle: observation.sourcePageTitle,
        sourcePageUrl: observation.sourcePageUrl,
        sourceRevisionId: observation.sourceRevisionId,
        fetchedAtMs: observation.fetchedAtMs,
        parserVersion: observation.parserVersion,
      });
      for (const game of observation.games ?? []) {
        if (game.canonicalStageId != null) {
          dryRunDetails.gamesWithCanonicalStage += 1;
        } else {
          dryRunDetails.gamesWithoutCanonicalStage += 1;
        }
        if (game.stageForm != null) {
          dryRunDetails.gamesWithStageForm += 1;
        }
      }
    }
    dryRunDetails.sourceRevisions = Array.from(revisions.values()).sort((a, b) =>
      a.sourcePageTitle.localeCompare(b.sourcePageTitle),
    );
    dryRunDetails.extractorVersions = Array.from(versions).sort();
  }

  const candidateIndex = await buildCandidateIndex(database, tenantId);
  counts.candidateIndexBuildCount = 1;

  // THE RESOLUTION INPUT (30.2 skip-heavy defect): a real run's input is the
  // UNION of
  //   (a) the review queue — stored observations lacking an ATTACHMENT, and
  //   (b) stored CURRENT-VERSION observations lacking a parseable RECEIPT —
  // deduped by observationId. (b) exists because a freshness-skip-heavy run
  // gathers nothing, and an observation whose receipt was lost (the mid-run
  // supersession race) but whose attachment survived appears in NEITHER the
  // gather output NOR the attachment-absence queue — it would stay
  // receipt-less forever while every manifest showed it uniquely matched.
  // Re-resolution is idempotent by construction: the resolver is
  // deterministic and the receipt/attachment writers gate on recomputed
  // evidence, so a healthy record re-resolves to the identical receipt and
  // a `replaced` attachment. Only schema-parsed records enter resolution
  // (the raw-read requirement applies to hygiene sweeps, never here).
  let queue: ResearchEnrichmentObservationRecord[];
  if (dryRun) {
    queue = gatheredObservations;
  } else {
    const reviewQueue = await listEnrichmentReviewQueue(database, tenantId);
    const receiptedIds = await listReceiptedObservationIds(database, tenantId);
    const currentParserVersions = new Set<string>([
      LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
      LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
      LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
      WIKITEXT_PROBE_PARSER_VERSION,
    ]);
    const receiptless = (await listEnrichmentObservations(database, tenantId)).filter(
      (record) =>
        currentParserVersions.has(record.parserVersion) && !receiptedIds.has(record.observationId),
    );
    const byObservationId = new Map<string, ResearchEnrichmentObservationRecord>();
    for (const record of [...reviewQueue, ...receiptless]) {
      byObservationId.set(record.observationId, record);
    }
    queue = Array.from(byObservationId.values()).sort((a, b) =>
      a.observationId.localeCompare(b.observationId),
    );
  }

  // Bracket/stage observations resolve FIRST so their matched outcomes seed
  // `matchedBracketVodUrls` before any VOD-page discovery row (which can
  // only ever resolve through bracket corroboration) is attempted.
  const nonVodRows = queue.filter((observation) => observation.contentType !== 'vod-reference');
  const vodRows = queue.filter((observation) => observation.contentType === 'vod-reference');

  const matchedBracketVodUrls = new Map<string, string>();
  const newlyAttachedTargetSetIds = new Set<string>();
  const dryRunAttachments = new Map<string, ResearchEnrichmentAttachmentRecord[]>();

  async function resolveOne(observation: ResearchEnrichmentObservationRecord): Promise<void> {
    const outcome = resolveObservation(observation, candidateIndex, { matchedBracketVodUrls });

    if (outcome.type === 'ambiguous') {
      counts.resolvedAmbiguous += 1;
      dryRunDetails?.reviewCandidates.push({
        observationId: observation.observationId,
        sourcePageTitle: observation.sourcePageTitle,
        outcome: 'ambiguous',
        candidateTargetSetIds: outcome.candidateTargetSetIds,
        evidence: outcome.evidence,
        reasons: outcome.reasons,
      });
      return;
    }
    if (outcome.type === 'conflicting') {
      counts.resolvedConflicting += 1;
      dryRunDetails?.reviewCandidates.push({
        observationId: observation.observationId,
        sourcePageTitle: observation.sourcePageTitle,
        outcome: 'conflicting',
        candidateTargetSetIds: [outcome.targetSetId],
        evidence: [],
        reasons: outcome.conflicts,
      });
      return;
    }
    if (outcome.type === 'unmatched') {
      counts.resolvedUnmatched += 1;
      return;
    }

    counts.resolvedMatched += 1;
    dryRunDetails?.matchedCandidates.push({
      observationId: observation.observationId,
      sourcePageTitle: observation.sourcePageTitle,
      targetSetId: outcome.targetSetId,
      evidence: outcome.evidence,
    });
    if (
      observation.contentType !== 'vod-reference' &&
      observation.vodUrl &&
      observation.tournamentPageTitle
    ) {
      matchedBracketVodUrls.set(
        `${observation.tournamentPageTitle}::${observation.vodUrl}`,
        outcome.targetSetId,
      );
    }

    if (dryRun) {
      const attachment: ResearchEnrichmentAttachmentRecord = {
        observationId: observation.observationId,
        targetSetId: outcome.targetSetId,
        attachmentSource: 'resolver',
        attachedAtMs: nowMs,
        sourceRevisionId: observation.sourceRevisionId,
        sourceContentHash: observation.sourceContentHash,
        parserVersion: observation.parserVersion,
        receiptId: `dry-run:${observation.observationId}`,
        matchEvidence: outcome.evidence,
      };
      const existing = dryRunAttachments.get(outcome.targetSetId) ?? [];
      existing.push(attachment);
      dryRunAttachments.set(outcome.targetSetId, existing);
      return;
    }

    const receipt = buildResolutionReceipt(observation, outcome, nowMs);
    if (!receipt) {
      counts.attachmentsAbstained += 1;
      return;
    }

    try {
      const receiptResult = await writeResolutionReceipt(database, tenantId, receipt);
      if (receiptResult.outcome !== 'created' && receiptResult.outcome !== 'replaced') {
        counts.attachmentsAbstained += 1;
        return;
      }
      counts.receiptsWritten += 1;

      const attachResult = await attachResolvedObservation(
        database,
        tenantId,
        observation.observationId,
        receipt.receiptId,
        nowMs,
      );
      if (attachResult.outcome === 'created' || attachResult.outcome === 'replaced') {
        counts.attachmentsCreated += 1;
        newlyAttachedTargetSetIds.add(outcome.targetSetId);
      } else {
        counts.attachmentsAbstained += 1;
      }
    } catch {
      // The receipt/attachment write was suppressed by the database
      // boundary underneath the store — an abstention, never a crash. The
      // observation stays unattached and is revisited on a later run.
      counts.attachmentsAbstained += 1;
    }
  }

  for (const observation of nonVodRows) {
    await resolveOne(observation);
    await tick('resolution', observation.observationId);
  }
  for (const observation of vodRows) {
    await resolveOne(observation);
    await tick('resolution', observation.observationId);
  }

  if (dryRun) {
    for (const [targetSetId, attachments] of dryRunAttachments) {
      const observationsById = Object.fromEntries(
        gatheredObservations.map((observation) => [observation.observationId, observation]),
      );
      const overlay = buildEnrichmentOverlay({
        targetSetId,
        attachments,
        observations: observationsById,
      });
      const preview = await previewEnrichmentProjection(database, tenantId, targetSetId, overlay);
      if (dryRunDetails) {
        dryRunDetails.vodWouldFillEmpty += preview.counts.vodFilledEmpty;
        dryRunDetails.vodWouldSkipUserOwned += preview.counts.vodSkippedUserOwned;
        dryRunDetails.stageWouldEnrich += preview.counts.stageEnriched;
      }
    }
    return;
  }

  // Accumulated across every touched target set THIS invocation — the exact
  // delta `stageEnrichmentProgress` folds below. `cohortCountsDelta` is
  // built from each row's OWN `stageOutcome`
  // (`STAGE_OUTCOME_TO_COHORT`) rather than a second read of the row —
  // `applyEnrichmentProjection` already decided that outcome via the shared
  // `resolveEnrichedMatchMembers`, so this is a restatement, never a second
  // classification that could disagree.
  const projectionCountsTotal: EnrichmentProjectionCounts = {
    stageEnriched: 0,
    vodFilledEmpty: 0,
    vodSkippedUserOwned: 0,
    unknownStageAfterEnrichment: 0,
    attachedNoProjectableRows: 0,
  };
  const cohortCountsDelta: EnrichmentCohortCountsDelta = {};

  async function projectOneSet(targetSetId: string): Promise<void> {
    const attachments = await listAttachmentsForSet(database, tenantId, targetSetId);
    const observationsById: Record<string, ResearchEnrichmentObservationRecord> = {};
    for (const attachment of attachments) {
      const record = await readEnrichmentObservation(database, tenantId, attachment.observationId);
      if (record) {
        observationsById[attachment.observationId] = record;
      }
    }
    const overlay = buildEnrichmentOverlay({
      targetSetId,
      attachments,
      observations: observationsById,
    });
    const projectionOutcome = await applyEnrichmentProjection(
      database,
      tenantId,
      targetSetId,
      overlay,
      nowMs,
    );
    counts.projectionsApplied += 1;

    for (const key of Object.keys(projectionCountsTotal) as (keyof EnrichmentProjectionCounts)[]) {
      projectionCountsTotal[key] += projectionOutcome.counts[key];
    }
    for (const row of projectionOutcome.rows) {
      const cohort = STAGE_OUTCOME_TO_COHORT[row.stageOutcome];
      cohortCountsDelta[cohort] = (cohortCountsDelta[cohort] ?? 0) + 1;
    }
  }

  for (const targetSetId of newlyAttachedTargetSetIds) {
    await projectOneSet(targetSetId);
    await tick('projection', targetSetId);
  }

  // THE RESUME-RECONCILIATION PASS (30.2 reliability gate, requirement D): a
  // crash between "attachment written" and "projection/witness committed"
  // strands a set that no later run would ever touch again — the attached
  // observation is no longer in the review queue, so `newlyAttached` never
  // re-includes it. Every real run therefore sweeps the FULL attached-set
  // universe and reprojects exactly the sets whose READ-ONLY preview reports
  // an outstanding fill (`vodOutcome: 'filled-empty'` or
  // `stageOutcome: 'enriched'` against the current rows/witnesses). The
  // preview is the trigger — never a bare witness-presence check — because
  // (a) a healthy apply legitimately leaves pending-half residue (the
  // projection module's documented, benign crash window), and (b) re-running
  // the applier over an ALREADY-projected set is not witness-idempotent: the
  // shared resolver treats the row's now-resolved stage as
  // provider-authoritative and would CLEAR the stage witness, silently
  // destroying attribution. A healthy set previews as
  // unchanged/provider-authoritative and is skipped, so a completed
  // account's rerun stays a no-op; only a genuinely stranded fill triggers
  // an apply, which then converges by the projection module's own
  // crash-safety contract.
  for (const targetSetId of await listAttachedTargetSetIds(database, tenantId)) {
    if (newlyAttachedTargetSetIds.has(targetSetId)) {
      continue;
    }
    const attachments = await listAttachmentsForSet(database, tenantId, targetSetId);
    const observationsById: Record<string, ResearchEnrichmentObservationRecord> = {};
    for (const attachment of attachments) {
      const record = await readEnrichmentObservation(database, tenantId, attachment.observationId);
      if (record) {
        observationsById[attachment.observationId] = record;
      }
    }
    const overlay = buildEnrichmentOverlay({
      targetSetId,
      attachments,
      observations: observationsById,
    });
    const preview = await previewEnrichmentProjection(database, tenantId, targetSetId, overlay);
    // Row-change-aware trigger (30.2 defect-C composition): the outcome
    // labels alone can no longer distinguish "row already holds our
    // projection" from "row is missing its fill" (the own-projection stage
    // guard reports both as `enriched`), so the trigger is the preview's
    // explicit would-this-apply-change-the-row signal.
    const hasStrandedFill = preview.rows.some((row) => row.wouldChangeRow === true);
    if (!hasStrandedFill) {
      continue;
    }
    await projectOneSet(targetSetId);
    counts.projectionsReconciled += 1;
    await tick('reconciliation', targetSetId);
  }

  // THE ROLLUP-STAGING SEAM (Rule 1 — the known gap this run driver left
  // unwired between plan 09 (this file) and plan 10 (`rollup.ts`): the two
  // landed in different waves and nothing called `stageEnrichmentProgress`
  // until now). Staged here, inside this phase, rather than by the caller —
  // this is the ONE place every counter this invocation moved (resolution
  // outcomes AND projection outcomes) is already in scope. `runId` is
  // non-null exactly when `!dryRun` (the caller only reaches this phase with
  // a real run id, or not at all for a dry run — see the module header's
  // dry-run-gate note), so this guard is equivalent to `!dryRun` but reads
  // directly off the value the fold actually needs.
  if (runId) {
    const countsDelta: EnrichmentCountsDelta = {
      matched: counts.resolvedMatched,
      ambiguous: counts.resolvedAmbiguous,
      unmatched: counts.resolvedUnmatched,
      conflicting: counts.resolvedConflicting,
      stageEnriched: projectionCountsTotal.stageEnriched,
      vodEnriched: projectionCountsTotal.vodFilledEmpty,
      vodFilledEmpty: projectionCountsTotal.vodFilledEmpty,
      vodSkippedUserOwned: projectionCountsTotal.vodSkippedUserOwned,
      unknownStageAfterEnrichment: projectionCountsTotal.unknownStageAfterEnrichment,
      attachedNoProjectableRows: projectionCountsTotal.attachedNoProjectableRows,
      observationsExtracted: counts.observationsExtracted,
      vodRowsDeclared: counts.vodPagesPresent,
      vodRowsExtracted: counts.vodRowsExtracted,
      sourcePagesMissing: counts.vodPagesMissing,
    };
    await stageEnrichmentProgress(database, {
      tenantId,
      runId,
      countsDelta,
      cohortCountsDelta,
      now: nowMs,
    });
  }
}

// Re-exported so a caller (or a test) can inspect the raw cache record shape
// this module writes without importing `revisionCache.ts` directly.
export type { LiquipediaPageCacheRecord };
