/**
 * RPT-09 / D-12 / D-18 (phase 39 plan 05): the deterministic recommended-
 * action engine. `buildActionCandidates` derives a CLOSED set of at-most-
 * three-kind candidates from a claim set — never a fourth kind, never an
 * unlicensed candidate. `rankActionCandidates` orders and ID-assigns them
 * deterministically; `selectTopActions` is the surface contract both the
 * free brief and a paid output slice from — the SAME ranked list, never two
 * different rankings (D-12: "The app renders them; never an exhaustive
 * list").
 *
 * PURE, no `node:` import, no module-level mutable state (`purity.test.ts`
 * joins this module in its directory-wide scan) — this module composes only
 * `./claims.js`, `./policy.js` and `./snapshot.js`.
 *
 * Targets carry AXES ONLY, never a route string (`ActionTarget`) — a route
 * literal here would bake a URL shape into shared code the web layer's
 * subject-aware path builder must decide instead; this plan's `<verify>`
 * grep-gates the module for a stray `/matchups`/`/vod`/`/stages` literal.
 */
import type {
  ActionId,
  ClaimAtom,
  ClaimId,
  ClaimPredicate,
  ClaimSubject,
  ClaimValue,
} from './claims.js';
import { ACTION_ID_VOCABULARY, ACTION_ID_VOCABULARY_SIZE } from './claims.js';
import {
  ABSTENTION_FLOOR_GAMES,
  PRACTICE_MATCHUP_MIN_GAMES,
  PRACTICE_STAGE_MIN_GAMES,
} from './policy.js';
import { parseVodEvidenceId } from './snapshot.js';

/** RPT-09: the closed set of three action kinds — no fourth member. */
export const RECOMMENDED_ACTION_KINDS = ['matchup_practice', 'vod_review', 'drill'] as const;
export type RecommendedActionKind = (typeof RECOMMENDED_ACTION_KINDS)[number];

/** The surface contract: at most this many action rows are ever rendered, on the free brief or a paid output alike. */
export const MAX_RECOMMENDED_ACTIONS = 3;

/**
 * A recommended action's destination, expressed as AXES the web layer turns
 * into a subject-aware path (Phase 38's builders) — never a URL string. Every
 * field is independently nullable; which axes are populated depends on the
 * candidate's kind and its licensing claim's own subject.
 */
export interface ActionTarget {
  kind: 'matchup' | 'vod' | 'stage';
  myFighterId: number | null;
  opponentFighterId: number | null;
  stageId: number | null;
  opponentTag: string | null;
  matchId: string | null;
}

/**
 * One recommended-action candidate. `id` is a PROVISIONAL value on the
 * output of `buildActionCandidates` — `ACTION_ID_VOCABULARY[0]` on every raw
 * candidate, since ids are assigned in RANK order (never build order); only
 * `rankActionCandidates`'s output carries a meaningful `id`. `claimIds` is
 * never empty — every candidate cites at least one claim (D-12), and a
 * candidate whose licensing claim did not survive is never emitted.
 */
export interface ActionCandidate {
  id: ActionId;
  kind: RecommendedActionKind;
  claimIds: readonly ClaimId[];
  titleKey: string;
  titleParams: Readonly<Record<string, string | number>>;
  doorKey: string;
  target: ActionTarget;
  rankScore: number;
}

/** One of the caller's own matches against the scouted opponent — supplied by the API's EXISTING `selectOpponentMatches` (`apps/api/src/reports/generate.ts`). This module never re-derives opponent identity matching. */
export interface VodRef {
  matchId: string;
  opponentTag: string | null;
  opponentFighterId: number | null;
  lost: boolean;
}

export interface ActionInput {
  claims: readonly ClaimAtom[];
  vodRefs: readonly VodRef[];
}

/** True for a claim whose value abstained — an action never rests on an abstained claim (D-12's abstention edge). */
function isAbstainedClaim(claim: ClaimAtom): boolean {
  return claim.value.kind === 'abstained';
}

/** A claim's own losing-gap-then-games composite score. Shared by every kind's `rankScore` so the ranking law ("size of the gap, then countable games") is ONE implementation, not one per kind. A `record` value scores by its losing gap (0 when not losing) scaled far above the games term so the gap always dominates a tie; every other value kind (`rate`/`count`/`entity`) has no "losing gap" concept and scores by games alone. */
const RANK_GAP_SCALE = 1_000_000;
function intrinsicScore(claim: ClaimAtom): number {
  const games = claim.sample.eligibleDenominator;
  if (claim.value.kind === 'record') {
    const gap = Math.max(0, claim.value.losses - claim.value.wins);
    return gap * RANK_GAP_SCALE + games;
  }
  return games;
}

/** `titleParams` built generically from a claim's subject axes — the SAME construction for every kind, so a param name never drifts between kinds. Only non-null axes are included. */
function buildTitleParams(subject: ClaimSubject): Readonly<Record<string, string | number>> {
  const params: Record<string, string | number> = {};
  if (subject.opponentTag !== null) {
    params.opponentTag = subject.opponentTag;
  }
  if (subject.stageId !== null) {
    params.stageId = subject.stageId;
  }
  if (subject.opponentFighterId !== null) {
    params.opponentFighterId = subject.opponentFighterId;
  }
  if (subject.myFighterId !== null) {
    params.myFighterId = subject.myFighterId;
  }
  return Object.freeze(params);
}

/** True when `value` is an evidenced losing `record` at or above `minGames` countable games — the shared gate `matchup_practice` and the `stage_habit`/`matchup_punish` drill templates all apply. */
function isLosingRecordAtOrAboveFloor(value: ClaimValue, minGames: number): boolean {
  return (
    value.kind === 'record' && value.losses > value.wins && value.wins + value.losses >= minGames
  );
}

/** One `matchup_practice` candidate per qualifying claim (Task 1): an evidenced, losing `character_matchup_record` at or above `PRACTICE_MATCHUP_MIN_GAMES`. */
function makeMatchupPracticeCandidate(claim: ClaimAtom): ActionCandidate {
  return {
    id: ACTION_ID_VOCABULARY[0]!,
    kind: 'matchup_practice',
    claimIds: [claim.id],
    titleKey: 'reports.actions.matchupPractice.title',
    titleParams: buildTitleParams(claim.subject),
    doorKey: 'reports.actions.door.practiceMatchup',
    target: {
      kind: 'matchup',
      myFighterId: claim.subject.myFighterId,
      opponentFighterId: claim.subject.opponentFighterId,
      stageId: claim.subject.stageId,
      opponentTag: claim.subject.opponentTag,
      matchId: null,
    },
    rankScore: intrinsicScore(claim),
  };
}

// ---------------------------------------------------------------------------
// vod_review (Task 2)
// ---------------------------------------------------------------------------

/** True when a claim's opponent axes match a `VodRef`'s opponent axes — the ONE predicate `vod_review` candidate grouping runs through. Fighter-id identity is checked first (the stronger signal); tag identity is the fallback when either side lacks a fighter id. A claim with neither axis populated never matches anything (axis-free claims, e.g. `recent_form`, are never a vod_review's licensing claim). */
function matchesVodRef(subject: ClaimSubject, vodRef: VodRef): boolean {
  if (subject.opponentFighterId !== null && vodRef.opponentFighterId !== null) {
    return subject.opponentFighterId === vodRef.opponentFighterId;
  }
  if (subject.opponentTag !== null && vodRef.opponentTag !== null) {
    return subject.opponentTag === vodRef.opponentTag;
  }
  return false;
}

/** One `vod_review` candidate per claim with at least one matching LOST `VodRef` — `matchId` is set only when exactly one match resolves; several resolve to axes-only (`matchId: null`), letting the web layer route to a filtered list instead of guessing one match. */
function makeVodReviewCandidate(claim: ClaimAtom, matchedRefs: readonly VodRef[]): ActionCandidate {
  return {
    id: ACTION_ID_VOCABULARY[0]!,
    kind: 'vod_review',
    claimIds: [claim.id],
    titleKey: 'reports.actions.vodReview.title',
    titleParams: buildTitleParams(claim.subject),
    doorKey: 'reports.actions.door.watchGames',
    target: {
      kind: 'vod',
      myFighterId: claim.subject.myFighterId,
      opponentFighterId: claim.subject.opponentFighterId,
      stageId: claim.subject.stageId,
      opponentTag: claim.subject.opponentTag,
      matchId: matchedRefs.length === 1 ? matchedRefs[0]!.matchId : null,
    },
    rankScore: intrinsicScore(claim),
  };
}

// ---------------------------------------------------------------------------
// drill (Task 2, D-18): a FIXED, exported claim-shape -> drill-template
// table. The model never writes drill text — every row is engine-templated,
// and every drill candidate cites the claim that licensed it.
// ---------------------------------------------------------------------------

export type DrillTemplateId =
  'stage_habit' | 'matchup_punish' | 'character_familiarity' | 'vod_pattern';

/** Context a drill condition may need beyond its own claim — today only `vod_pattern` (a cross-claim "shares a match id" check) reads it. */
export interface DrillConditionContext {
  allClaims: readonly ClaimAtom[];
}

export type DrillCondition = (claim: ClaimAtom, context: DrillConditionContext) => boolean;

export interface DrillTemplateRow {
  id: DrillTemplateId;
  predicate: ClaimPredicate;
  condition: DrillCondition;
  titleKey: string;
  doorKey: string;
  targetKind: ActionTarget['kind'];
}

/** `stage_habit`: a losing `stage_record` at or above `PRACTICE_STAGE_MIN_GAMES` on a known stage. */
export function stageHabitCondition(claim: ClaimAtom): boolean {
  return (
    claim.predicate === 'stage_record' &&
    claim.subject.stageId !== null &&
    isLosingRecordAtOrAboveFloor(claim.value, PRACTICE_STAGE_MIN_GAMES)
  );
}

/** `matchup_punish`: a losing `character_matchup_record` at or above `PRACTICE_MATCHUP_MIN_GAMES` against a known opponent fighter. The SAME claim shape `matchup_practice` licenses — see the non-duplication rule in `rankActionCandidates`, which is what keeps this from being `matchup_practice` wearing a different icon. */
export function matchupPunishCondition(claim: ClaimAtom): boolean {
  return (
    claim.predicate === 'character_matchup_record' &&
    claim.subject.opponentFighterId !== null &&
    isLosingRecordAtOrAboveFloor(claim.value, PRACTICE_MATCHUP_MIN_GAMES)
  );
}

/** `character_familiarity`: an `opponent_character_usage` rate at least half the cohort, at or above `ABSTENTION_FLOOR_GAMES` games, against a known opponent fighter. */
export function characterFamiliarityCondition(claim: ClaimAtom): boolean {
  if (claim.predicate !== 'opponent_character_usage' || claim.subject.opponentFighterId === null) {
    return false;
  }
  if (claim.value.kind !== 'rate') {
    return false;
  }
  return (
    claim.value.denominator >= ABSTENTION_FLOOR_GAMES &&
    claim.value.numerator * 2 >= claim.value.denominator
  );
}

/** Extracts the `(matchId, seconds)` pair's `matchId` from a claim's first parseable `vod_annotation` evidence id, or `null` if none parses. */
function firstVodMatchId(claim: ClaimAtom): string | null {
  for (const evidenceId of claim.evidenceIds) {
    const parsed = parseVodEvidenceId(evidenceId);
    if (parsed !== null) {
      return parsed.matchId;
    }
  }
  return null;
}

/** `vod_pattern`: fires on a `vod_annotation` claim that shares its match id with at least one OTHER `vod_annotation` claim in the same claim set — "two or more `vod_annotation` claims sharing a match id" evaluated per-claim so every qualifying claim in the group is cited; the `rankActionCandidates` collapse step then unions the group into one candidate. */
export function vodPatternCondition(claim: ClaimAtom, context: DrillConditionContext): boolean {
  if (claim.predicate !== 'vod_annotation') {
    return false;
  }
  const matchId = firstVodMatchId(claim);
  if (matchId === null) {
    return false;
  }
  const groupSize = context.allClaims.filter(
    (other) => other.predicate === 'vod_annotation' && firstVodMatchId(other) === matchId,
  ).length;
  return groupSize >= 2;
}

/** The closed D-18 table — exactly these four rows, total over the four predicates it names. Adding a row here without a firing fixture fails `actions.test.ts`'s coverage battery. */
export const DRILL_TEMPLATE_TABLE: readonly DrillTemplateRow[] = Object.freeze([
  {
    id: 'stage_habit',
    predicate: 'stage_record',
    condition: stageHabitCondition,
    titleKey: 'reports.actions.drill.stageHabit',
    doorKey: 'reports.actions.door.openStage',
    targetKind: 'stage',
  },
  {
    id: 'matchup_punish',
    predicate: 'character_matchup_record',
    condition: matchupPunishCondition,
    titleKey: 'reports.actions.drill.matchupPunish',
    doorKey: 'reports.actions.door.practiceMatchup',
    targetKind: 'matchup',
  },
  {
    id: 'character_familiarity',
    predicate: 'opponent_character_usage',
    condition: characterFamiliarityCondition,
    titleKey: 'reports.actions.drill.characterFamiliarity',
    doorKey: 'reports.actions.door.practiceMatchup',
    targetKind: 'matchup',
  },
  {
    id: 'vod_pattern',
    predicate: 'vod_annotation',
    condition: vodPatternCondition,
    titleKey: 'reports.actions.drill.vodPattern',
    doorKey: 'reports.actions.door.watchGames',
    targetKind: 'vod',
  },
]);

function targetForDrill(claim: ClaimAtom, templateRow: DrillTemplateRow): ActionTarget {
  if (templateRow.targetKind === 'stage') {
    return {
      kind: 'stage',
      myFighterId: claim.subject.myFighterId,
      opponentFighterId: null,
      stageId: claim.subject.stageId,
      opponentTag: null,
      matchId: null,
    };
  }
  if (templateRow.targetKind === 'vod') {
    return {
      kind: 'vod',
      myFighterId: null,
      opponentFighterId: null,
      stageId: null,
      opponentTag: null,
      matchId: firstVodMatchId(claim),
    };
  }
  return {
    kind: 'matchup',
    myFighterId: claim.subject.myFighterId,
    opponentFighterId: claim.subject.opponentFighterId,
    stageId: null,
    opponentTag: claim.subject.opponentTag,
    matchId: null,
  };
}

function makeDrillCandidate(claim: ClaimAtom, templateRow: DrillTemplateRow): ActionCandidate {
  return {
    id: ACTION_ID_VOCABULARY[0]!,
    kind: 'drill',
    claimIds: [claim.id],
    titleKey: templateRow.titleKey,
    titleParams: buildTitleParams(claim.subject),
    doorKey: templateRow.doorKey,
    target: targetForDrill(claim, templateRow),
    rankScore: intrinsicScore(claim),
  };
}

/**
 * `buildActionCandidates` — `matchup_practice` (Task 1), `vod_review` and
 * `drill` (Task 2). Never surface-conditional, never a route literal, never
 * emits a candidate for an abstained claim.
 */
export function buildActionCandidates(input: ActionInput): readonly ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  const context: DrillConditionContext = { allClaims: input.claims };

  for (const claim of input.claims) {
    if (isAbstainedClaim(claim)) {
      continue;
    }

    if (
      claim.predicate === 'character_matchup_record' &&
      isLosingRecordAtOrAboveFloor(claim.value, PRACTICE_MATCHUP_MIN_GAMES)
    ) {
      candidates.push(makeMatchupPracticeCandidate(claim));
    }

    for (const templateRow of DRILL_TEMPLATE_TABLE) {
      if (claim.predicate === templateRow.predicate && templateRow.condition(claim, context)) {
        candidates.push(makeDrillCandidate(claim, templateRow));
      }
    }
  }

  for (const claim of input.claims) {
    if (isAbstainedClaim(claim)) {
      continue;
    }
    if (claim.subject.opponentFighterId === null && claim.subject.opponentTag === null) {
      continue;
    }
    const matchedRefs = input.vodRefs.filter(
      (vodRef) => vodRef.lost && matchesVodRef(claim.subject, vodRef),
    );
    if (matchedRefs.length === 0) {
      continue;
    }
    candidates.push(makeVodReviewCandidate(claim, matchedRefs));
  }

  return Object.freeze(candidates);
}

/** Total kind-order tiebreak: `matchup_practice` < `vod_review` < `drill`. */
const ACTION_KIND_ORDER: Readonly<Record<RecommendedActionKind, number>> = {
  matchup_practice: 0,
  vod_review: 1,
  drill: 2,
};

/** The ascending-minimum claim id among a candidate's (possibly unioned, post-collapse) `claimIds` — the tiebreak key, independent of insertion/union order. */
function firstClaimIdAscending(claimIds: readonly ClaimId[]): ClaimId {
  return [...claimIds].sort()[0]!;
}

/**
 * The TOTAL comparator: `rankScore` descending, then ascending first claim
 * id, then kind order. Total because, within one kind, `buildActionCandidates`
 * emits at most one candidate per claim and collapse only merges candidates
 * that already share a target (so two distinct post-collapse candidates of
 * the same kind never share a claim id, hence never share a first-claim-id
 * tiebreak key); across kinds, `ACTION_KIND_ORDER` resolves any remaining tie.
 */
function compareActionCandidates(a: ActionCandidate, b: ActionCandidate): number {
  if (a.rankScore !== b.rankScore) {
    return b.rankScore - a.rankScore;
  }
  const aFirst = firstClaimIdAscending(a.claimIds);
  const bFirst = firstClaimIdAscending(b.claimIds);
  if (aFirst !== bFirst) {
    return aFirst < bFirst ? -1 : 1;
  }
  return ACTION_KIND_ORDER[a.kind] - ACTION_KIND_ORDER[b.kind];
}

/**
 * The D-18 NON-DUPLICATION rule: a `drill` candidate is suppressed when its
 * claim id set intersects ANY `matchup_practice` candidate's claim id set in
 * the SAME input — order-independent (a global set membership check, not an
 * incremental "already kept while walking the sorted list"), so the result
 * never depends on candidate array order and stays correct under the
 * shuffled-input property test. This is what keeps `drill` from ever being
 * `matchup_practice` re-emitted under a different icon (D-18).
 */
function suppressDuplicateDrills(
  candidates: readonly ActionCandidate[],
): readonly ActionCandidate[] {
  const practiceLicensedClaimIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind === 'matchup_practice') {
      for (const claimId of candidate.claimIds) {
        practiceLicensedClaimIds.add(claimId);
      }
    }
  }
  return candidates.filter((candidate) => {
    if (candidate.kind !== 'drill') {
      return true;
    }
    return !candidate.claimIds.some((claimId) => practiceLicensedClaimIds.has(claimId));
  });
}

/**
 * Ranks and ID-assigns a raw candidate list: suppress duplicate drills
 * (D-18), sort by `compareActionCandidates`, keep at most
 * `ACTION_ID_VOCABULARY_SIZE` (assigning no id beyond the vocabulary), then
 * assign ids from `ACTION_ID_VOCABULARY` in rank order. Pure and idempotent:
 * calling this twice on the same candidate array produces byte-identical
 * output, including assigned ids.
 */
export function rankActionCandidates(
  candidates: readonly ActionCandidate[],
): readonly ActionCandidate[] {
  const deduped = suppressDuplicateDrills(candidates);
  const sorted = [...deduped].sort(compareActionCandidates);
  const bounded = sorted.slice(0, ACTION_ID_VOCABULARY_SIZE);

  return Object.freeze(
    bounded.map((candidate, index): ActionCandidate => ({
      ...candidate,
      id: ACTION_ID_VOCABULARY[index]!,
    })),
  );
}

/**
 * The surface contract: at most `limit` (default `MAX_RECOMMENDED_ACTIONS`)
 * candidates from an ALREADY-RANKED list. The free brief calls this
 * directly; a paid output receives the same ranked list and the model may
 * only choose and order at most `limit` of THOSE candidates — never a
 * different set.
 */
export function selectTopActions(
  candidates: readonly ActionCandidate[],
  limit: number = MAX_RECOMMENDED_ACTIONS,
): readonly ActionCandidate[] {
  return Object.freeze(candidates.slice(0, limit));
}
