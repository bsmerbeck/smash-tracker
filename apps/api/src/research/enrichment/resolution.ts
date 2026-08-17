import { createHash } from 'node:crypto';
import type {
  ResearchEnrichmentObservationRecord,
  ResearchEnrichmentResolutionReceiptRecord,
} from '@smash-tracker/shared';
import { LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON } from '../../liquipedia/adapters/vodList.js';
import { buildLiquipediaVodCorroborationIdentity } from '../../liquipedia/vodUrl.js';
import type { CandidateIndex, CandidateSetEntry } from './candidateIndex.js';
import { normalizeCompetitorTag } from './candidateIndex.js';

/**
 * Phase 30.2 Plan 07 (ENR-05/ENR-06): the deterministic evidence ladder that
 * decides whether ONE Liquipedia observation matches ONE start.gg set — and
 * the pure receipt builder that is the ONLY thing an automatic attachment
 * may later cite (cycle-1 review MEDIUM 7 — see `store.ts`'s module header
 * for the writer-side half of that guarantee).
 *
 * This module is PURE: it takes an already-built `CandidateIndex` and an
 * observation and returns an outcome or a receipt. It performs no read, no
 * write, and no clock access beyond values passed in by the caller. It never
 * mutates its inputs.
 *
 * The owner's locked stance (30.2-CONTEXT.md, "Matching") is that abstention
 * is SUCCESS behavior, not failure: every rung below must independently
 * produce a UNIQUE candidate, or the outcome abstains (ambiguous, unmatched,
 * or conflicting) rather than guessing.
 */

// ---------------------------------------------------------------------------
// Outcome shapes
// ---------------------------------------------------------------------------

export interface ResolutionOutcomeMatched {
  type: 'matched';
  targetSetId: string;
  confidence: 'high';
  evidence: string[];
}

export interface ResolutionOutcomeAmbiguous {
  type: 'ambiguous';
  candidateTargetSetIds: string[];
  evidence: string[];
  reasons: string[];
}

export interface ResolutionOutcomeConflicting {
  type: 'conflicting';
  targetSetId: string;
  conflicts: string[];
}

export interface ResolutionOutcomeUnmatched {
  type: 'unmatched';
  reasons: string[];
}

/**
 * A discriminated union in which ONLY the `matched` variant exposes a single
 * `targetSetId` — every other variant deliberately exposes a different shape
 * (a candidate array, or none at all) so a caller can never read a
 * `targetSetId` off an outcome that has not matched.
 */
export type ResolutionOutcome =
  | ResolutionOutcomeMatched
  | ResolutionOutcomeAmbiguous
  | ResolutionOutcomeConflicting
  | ResolutionOutcomeUnmatched;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RESEARCH section 6.2 item 6: wiki timestamps are UTC, `rNmMdate` is an event-local calendar day, and start.gg gives UNIX timestamps — a date comparison is a WINDOW check, never equality, and never the sole discriminator. */
export const RESOLUTION_DATE_TOLERANCE_DAYS = 1;

/** Defense in depth alongside the schema's own `candidateTargetSetIds` length cap (20) — a denial-of-service guard against an unbounded candidate expansion (T-30.2-37). */
export const RESOLUTION_MAX_CANDIDATES = 20;

/** @2 adds a unique-within-tournament, no-seek-offset VOD identity fallback; stored @1 receipts remain self-verifiable because writers derive from each receipt's own recorded version. */
export const RESOLVER_VERSION = 'liquipedia-resolver@2';

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDateToMs(isoDate: string): number | null {
  const parsed = Date.parse(`${isoDate}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Absolute day difference between an observation's ISO date and a candidate's derived calendar day, or null when either side is missing/unparseable. */
function dateDeltaDays(
  observationDate: string | null | undefined,
  candidateDay: string | null,
): number | null {
  if (!observationDate || !candidateDay) {
    return null;
  }
  const observationMs = isoDateToMs(observationDate);
  const candidateMs = isoDateToMs(candidateDay);
  if (observationMs === null || candidateMs === null) {
    return null;
  }
  return Math.abs(observationMs - candidateMs) / MS_PER_DAY;
}

function sortedPairEquals(a: [number, number], b: [number, number]): boolean {
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA[0] === sortedB[0] && sortedA[1] === sortedB[1];
}

/**
 * `true` exactly when the observation's declared numeric scores (never
 * coerced from a non-numeric raw value — RESEARCH section 6.2 item 7) equal
 * the candidate's tallied game-win pair, as an UNORDERED (multiset)
 * comparison — seat order is not player-stable across the two sources.
 */
function scoresAgree(
  observation: ResearchEnrichmentObservationRecord,
  candidate: CandidateSetEntry,
): boolean {
  const scores = observation.scores;
  if (!scores || scores[0] === null || scores[1] === null || candidate.scorePair === null) {
    return false;
  }
  return sortedPairEquals([scores[0], scores[1]], candidate.scorePair);
}

/** `null` when the observation carries no game-level rows at all — that is the "nothing to corroborate" case, distinct from a stated disagreement. */
function gameCountsAgree(
  observation: ResearchEnrichmentObservationRecord,
  candidate: CandidateSetEntry,
): boolean | null {
  const observationGameCount = observation.games?.length ?? 0;
  if (observationGameCount === 0 || candidate.totalGames === null) {
    return null;
  }
  return observationGameCount === candidate.totalGames;
}

function normalizedPairKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

/** Filters `pool` to entries whose normalized, unordered competitor pair equals the observation's. `null` when the observation has no two-player pair to compare (e.g. a VOD-page row, handled by its own branch). */
function filterByCompetitorPair(
  pool: CandidateSetEntry[],
  observation: ResearchEnrichmentObservationRecord,
): CandidateSetEntry[] | null {
  const players = observation.players;
  if (!players) {
    return null;
  }
  const observedPairKey = normalizedPairKey(
    normalizeCompetitorTag(players[0].rawTag),
    normalizeCompetitorTag(players[1].rawTag),
  );
  return pool.filter(
    (candidate) =>
      candidate.normalizedCompetitorPair.length === 2 &&
      normalizedPairKey(
        candidate.normalizedCompetitorPair[0]!,
        candidate.normalizedCompetitorPair[1]!,
      ) === observedPairKey,
  );
}

/**
 * A HARD filter — kept only when both sides carry comparable numeric scores
 * AND they agree as an unordered pair. This is what disambiguates the grand
 * final from its reset when they share the same slug, pair and calendar day
 * (RESEARCH section 2.6): the two sets differ ONLY in score/game-count, so
 * score must narrow the pool, not merely corroborate an already-unique
 * survivor.
 */
function filterByScoreAgreement(
  pool: CandidateSetEntry[],
  observation: ResearchEnrichmentObservationRecord,
): CandidateSetEntry[] {
  return pool.filter((candidate) => scoresAgree(observation, candidate));
}

function filterByDateTolerance(
  pool: CandidateSetEntry[],
  observation: ResearchEnrichmentObservationRecord,
): CandidateSetEntry[] {
  if (!observation.date) {
    // No date to compare — this rung is vacuously satisfied, never a filter.
    return pool;
  }
  return pool.filter((candidate) => {
    const delta = dateDeltaDays(observation.date, candidate.calendarDay);
    // A candidate with no derivable calendar day cannot be excluded by a
    // rung it has no data for — date is never the SOLE discriminator
    // (RESEARCH section 6.2 item 6), so it is left in the pool for the
    // later rungs (pair/score/uniqueness) to decide.
    return delta === null || delta <= RESOLUTION_DATE_TOLERANCE_DAYS;
  });
}

function capCandidates(pool: CandidateSetEntry[]): CandidateSetEntry[] {
  return pool.length > RESOLUTION_MAX_CANDIDATES ? pool.slice(0, RESOLUTION_MAX_CANDIDATES) : pool;
}

// ---------------------------------------------------------------------------
// VOD-page discovery-index branch
// ---------------------------------------------------------------------------

/**
 * A caller-supplied declaration (30.2-RESEARCH.md Trap A: 58/111 tournaments
 * on Sparg0's VOD page alone contain a duplicated tournament-and-opponent
 * pair) that THIS row's `(tournamentPageTitle, opponent)` pair is one of
 * `vodList.ts`'s own `duplicatePairs` entries. `vodList.ts` itself does not
 * write this marker onto an observation — a future plan that persists
 * VOD-list observations into `researchEnrichmentObservations` is expected to
 * attach it, from `extractVodListRows`'s `duplicatePairs` result, onto every
 * affected row's `resolutionReasons` BEFORE it ever reaches this resolver.
 */
export const VOD_ROW_DUPLICATE_PAIR_REASON_MARKER =
  'liquipedia-vod-row-duplicate-tournament-opponent-pair';

function isVodPageDiscoveryRow(observation: ResearchEnrichmentObservationRecord): boolean {
  return (
    observation.contentType === 'vod-reference' &&
    (observation.resolutionReasons?.includes(LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON) ?? false)
  );
}

/**
 * A VOD-page row carries no round, no date, and no score (RESEARCH section
 * 6.3 Trap A) — it can NEVER resolve on its own. It resolves ONLY through a
 * bracket observation that has ALREADY resolved as matched for the SAME
 * tournament and the SAME canonical VOD URL. `matchedBracketVodUrls` is
 * keyed by `${tournamentPageTitle}::${vodUrl}` (scoping the corroboration to
 * "the same tournament" is encoded directly in the key, never inferred at
 * lookup time) and its value is the target set id that bracket observation
 * matched to.
 */
function resolveVodPageRow(
  observation: ResearchEnrichmentObservationRecord,
  matchedBracketVodUrls: Map<string, string> | undefined,
  matchedBracketVodIdentities: Map<string, string> | undefined,
): ResolutionOutcome {
  if (observation.resolutionReasons?.includes(VOD_ROW_DUPLICATE_PAIR_REASON_MARKER)) {
    return {
      type: 'ambiguous',
      candidateTargetSetIds: [],
      evidence: [],
      reasons: ['vod-page-row-duplicate-tournament-opponent-pair'],
    };
  }

  const vodUrl = observation.vodUrl;
  if (!vodUrl) {
    return {
      type: 'ambiguous',
      candidateTargetSetIds: [],
      evidence: [],
      reasons: ['vod-page-row-missing-vod-url'],
    };
  }

  const compositeKey = `${observation.tournamentPageTitle ?? ''}::${vodUrl}`;
  const exactTargetSetId = matchedBracketVodUrls?.get(compositeKey);
  const identity = buildLiquipediaVodCorroborationIdentity(vodUrl);
  const identityTargetSetId = identity
    ? matchedBracketVodIdentities?.get(`${observation.tournamentPageTitle ?? ''}::${identity}`)
    : undefined;
  const targetSetId = exactTargetSetId ?? identityTargetSetId;
  if (!targetSetId) {
    return {
      type: 'ambiguous',
      candidateTargetSetIds: [],
      evidence: [],
      reasons: ['vod-page-row-no-bracket-corroboration'],
    };
  }

  return {
    type: 'matched',
    targetSetId,
    confidence: 'high',
    evidence: ['vod-page-bracket-corroboration'],
  };
}

// ---------------------------------------------------------------------------
// Main ladder
// ---------------------------------------------------------------------------

export interface ResolveObservationOptions {
  /** VOD-page-row corroboration map — see `resolveVodPageRow`'s doc comment. */
  matchedBracketVodUrls?: Map<string, string>;
  /** Offset-insensitive fallback identities that are UNIQUE within the same tournament. Exact URL remains the first rung; ambiguous shared-video identities are omitted by the caller. */
  matchedBracketVodIdentities?: Map<string, string>;
}

/**
 * Implements the ladder in RESEARCH section 6.4, IN ORDER: anchor on the
 * tournament slug when present; scope by declared game; require the
 * unordered normalized competitor pair to equal the candidate's; require
 * the score multiset to match; require the completion date to fall within
 * tolerance (skipped once the pool is already down to zero-or-one — date is
 * never the SOLE discriminator, RESEARCH section 6.2 item 6); then require
 * exactly one survivor. GAME-COUNT is evaluated as a CORROBORATION on that
 * one final survivor (any observation carrying game-level stage rows) — a
 * disagreement demotes a would-be match to `conflicting` rather than being
 * a pool filter, because the stage rows would otherwise be projected onto
 * the wrong game ordinals (a fact about THIS specific survivor, not about
 * which candidate to pick).
 *
 * A SINGLE pair-matching candidate that the score rung eliminates is
 * reported `conflicting` (naming `score`), not `unmatched` — the pair
 * already uniquely identified a real set; the disagreement is a stated fact
 * about THAT set, not an absence of one.
 *
 * When NO slug anchors the search, the ladder runs the SAME pair/score/date
 * filters against the whole index, but a unique survivor reaches `matched`
 * ONLY when score, date AND game count ALL agree — with no independent
 * event anchor, a disagreement on any of the three is reported `ambiguous`
 * (not `conflicting`, not `unmatched`): there is no anchored event to
 * disagree WITH (RESEARCH section 6.4 rung 2's parenthetical).
 *
 * ROUND IS DELIBERATELY NOT A RUNG: no round parameter exists in either
 * source, every round label either side carries is a DERIVATION, and the
 * two vocabularies disagree ("Losers Finals" vs "Losers Round 5" vs
 * `r2m1`). A derived round label (`observation.derivedRoundLabel`, written
 * by the adapters) may appear only in the explanation returned for the
 * admin-review surface — this resolver never reads it.
 */
export function resolveObservation(
  observation: ResearchEnrichmentObservationRecord,
  index: CandidateIndex,
  options: ResolveObservationOptions = {},
): ResolutionOutcome {
  if (isVodPageDiscoveryRow(observation)) {
    return resolveVodPageRow(
      observation,
      options.matchedBracketVodUrls,
      options.matchedBracketVodIdentities,
    );
  }

  // Scope by declared game (RESEARCH section 6.4 rung 3). The provider tier
  // this index is built from is EXCLUSIVELY Ultimate sets (Phase 30 only
  // ingests SSBU_VIDEOGAME_ID), so a non-Ultimate declared game can never
  // have a real candidate — abstain immediately rather than running the
  // rest of the ladder against a pool that structurally cannot contain one.
  if (observation.game != null && observation.game.toLowerCase() !== 'ultimate') {
    return { type: 'unmatched', reasons: ['game-scope-mismatch'] };
  }

  const slug = observation.tournamentStartggSlug;
  const usedSlug = slug != null && slug.length > 0;
  const anchoredPool = capCandidates(
    usedSlug ? (index.byTournamentSlug.get(slug) ?? []) : index.all,
  );
  const anchorEmpty = usedSlug && anchoredPool.length === 0;

  const pairFiltered = filterByCompetitorPair(anchoredPool, observation);
  if (pairFiltered === null) {
    return { type: 'unmatched', reasons: ['observation-missing-competitor-pair'] };
  }

  return usedSlug
    ? resolveWithSlugAnchor(observation, pairFiltered, anchorEmpty)
    : resolveWithoutSlugAnchor(observation, pairFiltered);
}

/** Applies score, then date (only when it can still disambiguate), returning the final pool alongside which rung, if any, first reduced a non-empty pool to empty. */
function narrowByScoreThenDate(
  pool: CandidateSetEntry[],
  observation: ResearchEnrichmentObservationRecord,
): { survivors: CandidateSetEntry[]; emptiedByScore: boolean; wasSingletonBeforeScore: boolean } {
  const wasSingletonBeforeScore = pool.length === 1;
  const scoreFiltered = filterByScoreAgreement(pool, observation);
  const emptiedByScore = pool.length > 0 && scoreFiltered.length === 0;

  // Date only ever DISAMBIGUATES an already-multi-candidate pool — it never
  // eliminates the last remaining candidate (date is never the sole
  // discriminator).
  const dateFiltered =
    scoreFiltered.length > 1 ? filterByDateTolerance(scoreFiltered, observation) : scoreFiltered;

  return { survivors: dateFiltered, emptiedByScore, wasSingletonBeforeScore };
}

function resolveWithSlugAnchor(
  observation: ResearchEnrichmentObservationRecord,
  pairFiltered: CandidateSetEntry[],
  anchorEmpty: boolean,
): ResolutionOutcome {
  if (pairFiltered.length === 0) {
    return {
      type: 'unmatched',
      reasons: [anchorEmpty ? 'no-matched-event' : 'no-pair-match-in-event'],
    };
  }

  const { survivors, emptiedByScore, wasSingletonBeforeScore } = narrowByScoreThenDate(
    pairFiltered,
    observation,
  );

  // The pair rung already uniquely identified a real start.gg set; the
  // score rung eliminating it is a stated DISAGREEMENT about that set, not
  // an absence of one.
  if (wasSingletonBeforeScore && emptiedByScore) {
    return { type: 'conflicting', targetSetId: pairFiltered[0]!.targetSetId, conflicts: ['score'] };
  }

  if (survivors.length === 0) {
    return { type: 'unmatched', reasons: ['no-date-match-in-event'] };
  }
  if (survivors.length > 1) {
    return {
      type: 'ambiguous',
      candidateTargetSetIds: survivors.map((entry) => entry.targetSetId),
      evidence: ['slug-anchor', 'competitor-pair', 'score-agreement'],
      reasons: ['multiple-candidates-survived'],
    };
  }

  const survivor = survivors[0]!;
  const gameCountAgreement = gameCountsAgree(observation, survivor);
  if (gameCountAgreement === false) {
    return { type: 'conflicting', targetSetId: survivor.targetSetId, conflicts: ['gameCount'] };
  }

  return {
    type: 'matched',
    targetSetId: survivor.targetSetId,
    confidence: 'high',
    evidence: [
      'slug-anchor',
      'competitor-pair',
      'score-agreement',
      'date-window',
      ...(gameCountAgreement === true ? ['game-count-agreement'] : []),
    ],
  };
}

function resolveWithoutSlugAnchor(
  observation: ResearchEnrichmentObservationRecord,
  pairFiltered: CandidateSetEntry[],
): ResolutionOutcome {
  if (pairFiltered.length === 0) {
    return { type: 'unmatched', reasons: ['no-slug-no-pair-match'] };
  }

  const { survivors } = narrowByScoreThenDate(pairFiltered, observation);

  if (survivors.length === 0) {
    // Without a slug anchor there is no independently-verified event to
    // report "unmatched" against — the abstention is ambiguous, never a
    // stronger claim than the evidence supports.
    return {
      type: 'ambiguous',
      candidateTargetSetIds: [],
      evidence: ['competitor-pair'],
      reasons: ['no-slug-no-full-corroboration'],
    };
  }
  if (survivors.length > 1) {
    return {
      type: 'ambiguous',
      candidateTargetSetIds: survivors.map((entry) => entry.targetSetId),
      evidence: ['competitor-pair', 'score-agreement'],
      reasons: ['multiple-candidates-survived-without-slug'],
    };
  }

  const survivor = survivors[0]!;
  const gameCountAgreement = gameCountsAgree(observation, survivor);
  // Without a slug anchor, high confidence requires ALL FOUR of pair, score,
  // date AND game count to agree — a slug-less unique survivor whose game
  // count disagrees (or is unverifiable) is at most AMBIGUOUS, never
  // matched and never conflicting, because there is no independent anchor
  // corroborating that this is even the right EVENT in the first place
  // (RESEARCH section 6.4 rung 2's parenthetical).
  if (gameCountAgreement !== true) {
    return {
      type: 'ambiguous',
      candidateTargetSetIds: [survivor.targetSetId],
      evidence: ['competitor-pair', 'score-agreement', 'date-window'],
      reasons: ['no-slug-corroboration-incomplete'],
    };
  }

  return {
    type: 'matched',
    targetSetId: survivor.targetSetId,
    confidence: 'high',
    evidence: ['competitor-pair', 'score-agreement', 'date-window', 'game-count-agreement'],
  };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * Derives the receipt id from the observation id, the resolver version, and
 * the OBSERVATION's own content hash — so a receipt written for stale
 * content can never authorise an attachment against refreshed content
 * (cycle-1 review MEDIUM 7). Both `buildResolutionReceipt` and `store.ts`'s
 * writer-side revalidation call this SAME function, so there is exactly one
 * definition of "does this receipt id derive from this content."
 */
export function deriveReceiptId(input: {
  observationId: string;
  resolverVersion: string;
  sourceContentHash: string;
}): string {
  return createHash('sha256')
    .update(`${input.observationId}\n${input.resolverVersion}\n${input.sourceContentHash}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Returns a receipt ONLY for the `matched` variant — every other variant
 * returns `null`, so there is nothing to persist and therefore nothing an
 * automatic attachment can cite (cycle-1 review MEDIUM 7). Every fingerprint
 * member (`sourceRevisionId`, `sourceContentHash`, `parserVersion`) is
 * copied FROM THE OBSERVATION, never accepted as a caller-suppliable
 * parameter — the receipt exists to be reloaded and re-verified by a writer
 * that does not trust its caller, so any field a caller could choose would
 * defeat it.
 */
export function buildResolutionReceipt(
  observation: ResearchEnrichmentObservationRecord,
  outcome: ResolutionOutcome,
  nowMs: number,
): ResearchEnrichmentResolutionReceiptRecord | null {
  if (outcome.type !== 'matched') {
    return null;
  }

  const receiptId = deriveReceiptId({
    observationId: observation.observationId,
    resolverVersion: RESOLVER_VERSION,
    sourceContentHash: observation.sourceContentHash,
  });

  return {
    receiptId,
    observationId: observation.observationId,
    targetSetId: outcome.targetSetId,
    confidence: 'high',
    resolvedAtMs: nowMs,
    resolverVersion: RESOLVER_VERSION,
    sourceRevisionId: observation.sourceRevisionId,
    sourceContentHash: observation.sourceContentHash,
    parserVersion: observation.parserVersion,
    candidateTargetSetIds: [outcome.targetSetId],
    ...(outcome.evidence.length > 0 ? { evidence: outcome.evidence } : {}),
  };
}
