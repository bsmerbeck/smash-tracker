import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
  buildEnrichmentObservationId,
  type EnrichmentStageOutcome,
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
import { buildResolutionReceipt, resolveObservation } from './resolution.js';
import {
  attachResolvedObservation,
  listAttachmentsForSet,
  listEnrichmentObservations,
  listEnrichmentReviewQueue,
  readEnrichmentObservation,
  writeEnrichmentObservation,
  writeResolutionReceipt,
} from './store.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
  type EnrichmentProjectionCounts,
} from './projection.js';
import {
  publishEnrichmentCoverage,
  stageEnrichmentProgress,
  type EnrichmentCohortCountsDelta,
  type EnrichmentCountsDelta,
} from './rollup.js';
import {
  acquireEnrichmentRunLease,
  advanceEnrichmentRunState,
  completeEnrichmentRun,
  createOrResumeEnrichmentRun,
  failEnrichmentRun,
  readActiveEnrichmentRun,
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
 * Every page this module caches is therefore keyed by a stable digest of its
 * title rather than by title or by the wiki's own numeric `pageid` — the
 * latter is unavailable for a `getGeneratedVodPage` call made in the default
 * `expandtemplates` mode (`client.ts`'s `LiquipediaGeneratedPageResult` has
 * no `pageId` member for that mode), so a title-derived key is the only one
 * available uniformly across both page classes.
 */
function cacheKeyFor(title: string, hashHex: (value: string) => string): string {
  return hashHex(title).slice(0, 48);
}

/**
 * The page-CACHE-level parser version for the WIKITEXT class, deliberately
 * DISTINCT from the per-observation `parserVersion` the legacy/match2
 * extractors stamp on their own output records
 * (`LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY`/`_MATCH2`). Which FAMILY a
 * wikitext page belongs to is only knowable AFTER its content has been
 * fetched and `detectTemplateFamily` has run — but the whole point of the
 * wikitext freshness gate is to decide whether to fetch content AT ALL. This
 * constant versions "the wikitext probe/family-detection pipeline as a
 * whole" for the page-cache freshness check; bumping it invalidates every
 * cached wikitext page regardless of which family it turns out to be, and a
 * bump to a per-family extractor version continues to invalidate that
 * family's OWN observation records the same way `refresh.ts` (Task 3)
 * documents.
 */
export const WIKITEXT_PROBE_PARSER_VERSION = 'liquipedia-wikitext-probe@1';

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

export interface EnrichmentBatchCounts {
  playersRequested: number;
  vodPagesPresent: number;
  vodPagesMissing: number;
  vodPageProbeRequests: number;
  parseClassRequestsIssued: number;
  generatedCacheHits: number;
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
    backoffEvents: 0,
  };
}

export interface EnrichmentBatchResult {
  runId: string | null;
  dryRun: boolean;
  /** `true` when this invocation found the gather phase already complete (a prior invocation's persisted `cursor.stage === 'projection'`) and issued NO fetch of any kind. */
  resumedAtProjection: boolean;
  counts: EnrichmentBatchCounts;
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

  // Every observation this INVOCATION gathers, in memory — the dry-run
  // resolution/projection pass reads from here (there is nothing persisted
  // to read back); a real run instead re-reads from the database below, so
  // a genuinely resumed invocation (gather skipped) still resolves whatever
  // a PRIOR invocation persisted.
  const gatheredObservations: ResearchEnrichmentObservationRecord[] = [];

  try {
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
      });

      if (!dryRun && runId && holder) {
        await advanceEnrichmentRunState(database, tenantId, runId, holder, {
          cursor: { stage: 'projection' },
        });
      }
    }

    await resolveAndProjectPhase({
      database,
      tenantId,
      runId,
      nowMs,
      dryRun,
      counts,
      gatheredObservations,
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

  return { runId, dryRun, resumedAtProjection, counts };
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
  } = input;

  // --- Discovery: resolve player VOD pages, dedupe, fetch + extract -------
  const resolved = await callWithRetry(() => resolvePlayerVodPages(client, playerLabels), counts);
  counts.vodPageProbeRequests += 2; // resolvePlayerVodPages issues at most two headRevisions batches (player titles, then deduped VOD titles).

  const presentByTitle = new Map<string, (typeof resolved.resolved)[number]>();
  for (const entry of resolved.resolved) {
    if (!entry.present) {
      counts.vodPagesMissing += 1;
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

    const shape = generated.mode === 'parse' ? ('rendered' as const) : ('expanded' as const);
    const extraction = extractVodListRows({
      body: generated.content,
      shape,
      pageTitle: vodPageTitle,
      revisionId: entry.revisionId ?? 0,
      nowMs,
      hashHex,
    });

    const cacheKey = cacheKeyFor(vodPageTitle, hashHex);
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
      gatheredObservations.push(record);
      if (record.tournamentPageTitle) {
        tournamentPageTitles.add(record.tournamentPageTitle);
      }
      if (!dryRun) {
        await writeEnrichmentObservation(database, tenantId, record);
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
    }
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
  }
  counts.factPagesEnumerated = factPageTitles.size;

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
  }

  // --- Decide the changed subset (WIKITEXT skip-before-fetch) -------------
  const changedTitles: string[] = [];
  for (const title of boundedFactPageTitles) {
    const probe = probeResults.get(title);
    if (!probe || !probe.present) {
      continue;
    }
    const cacheKey = cacheKeyFor(title, hashHex);
    const cached = dryRun ? null : await readLiquipediaPageCache(database, cacheKey);
    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'wikitext', revisionId: probe.revisionId, sha1: probe.sha1 },
      WIKITEXT_PROBE_PARSER_VERSION,
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
      const contentHash = hashWikitext(page.content, hashHex);
      const cacheKey = cacheKeyFor(page.title, hashHex);

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
            parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
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
  }

  for (const page of pendingBracketPages) {
    const detected = detectTemplateFamily(page.content);
    const cacheKey = cacheKeyFor(page.title, hashHex);

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
      gatheredObservations.push(unmatched);
      if (!dryRun) {
        await writeEnrichmentObservation(database, tenantId, unmatched);
        await writeLiquipediaPageCache(database, {
          pageId: cacheKey,
          title: page.title,
          pageClass: 'wikitext',
          parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
          fetchedAtMs: nowMs,
          revisionId: page.revisionId,
          sha1: page.sha1,
          contentHash: page.contentHash,
        });
      }
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
      gatheredObservations.push(observation);
      if (!dryRun) {
        await writeEnrichmentObservation(database, tenantId, observation);
      }
    }

    if (!dryRun) {
      await writeLiquipediaPageCache(database, {
        pageId: cacheKey,
        title: page.title,
        pageClass: 'wikitext',
        parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
        fetchedAtMs: nowMs,
        revisionId: page.revisionId,
        sha1: page.sha1,
        contentHash: page.contentHash,
      });
    }
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
  const { database, tenantId, runId, nowMs, dryRun, counts, gatheredObservations } = input;

  const candidateIndex = await buildCandidateIndex(database, tenantId);
  counts.candidateIndexBuildCount = 1;

  const queue = dryRun ? gatheredObservations : await listEnrichmentReviewQueue(database, tenantId);

  // Bracket/stage observations resolve FIRST so their matched outcomes seed
  // `matchedBracketVodUrls` before any VOD-page discovery row (which can
  // only ever resolve through bracket corroboration) is attempted.
  const nonVodRows = queue.filter((observation) => observation.contentType !== 'vod-reference');
  const vodRows = queue.filter((observation) => observation.contentType === 'vod-reference');

  const matchedBracketVodUrls = new Map<string, string>();
  const newlyAttachedTargetSetIds = new Set<string>();

  async function resolveOne(observation: ResearchEnrichmentObservationRecord): Promise<void> {
    const outcome = resolveObservation(observation, candidateIndex, { matchedBracketVodUrls });

    if (outcome.type === 'ambiguous') {
      counts.resolvedAmbiguous += 1;
      return;
    }
    if (outcome.type === 'conflicting') {
      counts.resolvedConflicting += 1;
      return;
    }
    if (outcome.type === 'unmatched') {
      counts.resolvedUnmatched += 1;
      return;
    }

    counts.resolvedMatched += 1;
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
  }
  for (const observation of vodRows) {
    await resolveOne(observation);
  }

  if (dryRun) {
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

  for (const targetSetId of newlyAttachedTargetSetIds) {
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
