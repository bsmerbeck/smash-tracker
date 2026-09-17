import { archetypeEdge, getFighterMeta } from './meta.js';
import {
  ABSTENTION_FLOOR_GAMES,
  CONFIDENCE_TIER_BOUNDS,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
  confidenceTierFor,
  effectiveFloor,
} from './evidence/policy.js';
import type { EvidenceClaim, SampleMeta } from './evidence/types.js';

/**
 * V9-B Feature 3: deterministic character-pick recommendations — ZERO added
 * AI cost. Pure functions only, so both the web `ScoutMatchupAdvisorCard`
 * and the API's `reports/generate.ts` payload assembly can call the exact
 * same logic and never disagree.
 *
 * The core idea: for a given opponent character, rank each of the user's
 * candidate fighters by a blended score that leans on the user's OWN
 * head-to-head record as it gets more reliable (more games played), and
 * falls back to tier-list + archetype-counter priors when that record is
 * thin or nonexistent. See `pickScore` for the exact blend.
 */

/** Raw W/L the user has for one of their own fighters against one opponent fighter. */
export interface MyCharacterRecordVsOpponent {
  fighterId: number;
  wins: number;
  losses: number;
}

/** Evidence backing one ranked pick, for display/grounding. */
export interface MatchupEvidence {
  /** "W-L" the user has with this fighter against the opponent character, when any games exist. */
  record?: string;
  tierScore: number;
  /** Archetype counter edge in [-1, 1]; positive favors the user's fighter. */
  archetypeEdge: number;
}

export interface MatchupPick {
  fighterId: number;
  /** Blended score in roughly [0, 1] — higher is a better pick. Not a win-probability estimate, just a ranking score. */
  score: number;
  evidence: MatchupEvidence;
}

export interface MatchupRanking {
  opponentFighterId: number;
  /** All candidate fighters, best first. */
  ranked: MatchupPick[];
  best: MatchupPick | null;
  worst: MatchupPick | null;
}

/**
 * How much the prior (tier score + archetype edge) is allowed to move the
 * blended score away from a neutral 0.5, at most. Priors are heuristics, not
 * certainties — even a "perfect" S+ vs. D+ matchup on paper shouldn't be
 * modeled as a mathematical guarantee, so the prior is compressed into
 * `[0.5 - PRIOR_SWING, 0.5 + PRIOR_SWING]` rather than the full `[0, 1]`.
 * This keeps a sufficiently large real sample ALWAYS able to outweigh the
 * prior, however extreme, once `sampleWeight` gets close enough to 1.
 */
const PRIOR_SWING = 0.25;

/** Converts a tier score (0-10) to a [0, 1] scale for blending. */
function normalizedTierScore(tierScore: number): number {
  return Math.min(Math.max(tierScore, 0), 10) / 10;
}

/** Converts an archetype edge ([-1, 1]) to a [0, 1] scale for blending. */
function normalizedArchetypeEdge(edge: number): number {
  return (edge + 1) / 2;
}

/**
 * Blended pick score in [0, 1] for one candidate fighter against one
 * opponent fighter:
 *
 * - `prior` = 70% tier-score comparison (the candidate's own tier score,
 *   normalized) + 30% archetype counter edge (normalized) — tier placement
 *   is the stronger, more character-specific signal; archetype counters fill
 *   in texture when two characters are tier-adjacent.
 * - `sampleWeight` = games / (games + CONFIDENCE_TIER_BOUNDS.medium) — 0 with
 *   no data, 0.5 at the half-sample point, asymptotically approaching 1 as
 *   the sample grows. This is the confidence-weighting: thin samples barely
 *   move the needle away from the prior; rich samples dominate it. 8 games
 *   (roughly two best-of-5 sets, `CONFIDENCE_TIER_BOUNDS.medium` from
 *   `evidence/policy.ts`) is enough to start meaning something in Smash,
 *   without demanding a huge sample before real data counts at all — and
 *   Phase 36 (R1-LOW-2) makes the "these two numbers happen to agree"
 *   alignment mechanical by importing the same constant rather than
 *   maintaining a second, unenforced `8`.
 * - final score = `sampleWeight * winRate + (1 - sampleWeight) * prior`.
 *
 * Degrades gracefully for an unmapped/unknown fighter id: `getFighterMeta`
 * always returns a mid-pack default rather than throwing, so an unrecognized
 * id still produces a valid (just uninformative) score.
 */
function pickScore(
  candidateFighterId: number,
  opponentFighterId: number,
  record: MyCharacterRecordVsOpponent | undefined,
): MatchupPick {
  const mine = getFighterMeta(candidateFighterId);
  const theirs = getFighterMeta(opponentFighterId);

  const edge = archetypeEdge(mine.archetypes, theirs.archetypes);
  const rawPrior = 0.7 * normalizedTierScore(mine.tierScore) + 0.3 * normalizedArchetypeEdge(edge);
  // Compress into [0.5 - PRIOR_SWING, 0.5 + PRIOR_SWING] — see PRIOR_SWING doc.
  const prior = 0.5 + (rawPrior - 0.5) * (2 * PRIOR_SWING);

  const games = (record?.wins ?? 0) + (record?.losses ?? 0);
  const winRate = games > 0 ? (record?.wins ?? 0) / games : prior;
  const sampleWeight = games / (games + CONFIDENCE_TIER_BOUNDS.medium);

  const score = sampleWeight * winRate + (1 - sampleWeight) * prior;

  return {
    fighterId: candidateFighterId,
    score,
    evidence: {
      ...(games > 0 ? { record: `${record?.wins ?? 0}-${record?.losses ?? 0}` } : {}),
      tierScore: mine.tierScore,
      archetypeEdge: edge,
    },
  };
}

/**
 * Ranks the user's candidate fighters against ONE opponent fighter, best
 * pick first. `myFighterIds` should be de-duplicated by the caller (e.g. the
 * union of primary/secondary + most-played); an empty list yields an empty
 * ranking (no candidates to recommend).
 *
 * Phase 36 (D-05, first application to the character advisor): this is the
 * INNER, UNGATED primitive — it has no abstention floor and will happily
 * rank a candidate against a 0-game or 2-game opponent-character sample,
 * falling back to the tier/archetype prior. `rankMatchupWithGate` below
 * wraps this unchanged blend with the engine's hard floor; reach for that
 * one for any new caller that renders a recommendation to a user. This
 * primitive stays exported for the API report payload path (plan 36-03).
 */
export function rankMatchup(
  opponentFighterId: number,
  myFighterIds: number[],
  myRecordsVsOpponent: MyCharacterRecordVsOpponent[],
): MatchupRanking {
  const recordByFighterId = new Map(myRecordsVsOpponent.map((r) => [r.fighterId, r]));

  const ranked = myFighterIds
    .map((fighterId) => pickScore(fighterId, opponentFighterId, recordByFighterId.get(fighterId)))
    .sort((a, b) => b.score - a.score);

  return {
    opponentFighterId,
    ranked,
    best: ranked[0] ?? null,
    worst: ranked.length > 1 ? (ranked[ranked.length - 1] ?? null) : null,
  };
}

/**
 * Ranks every opponent fighter id in `opponentFighterIds` (typically the
 * scouted player's top characters). `myRecordsVsOpponent` maps opponent
 * fighter id -> the user's per-character records against that specific
 * opponent character (raw counts, one entry per one of the user's own
 * fighters).
 *
 * Phase 36 (D-05): the INNER, UNGATED primitive — see `rankMatchup`'s doc
 * comment. `buildMatchupAdvisorWithGate` below wraps it with the floor.
 */
export function buildMatchupAdvisor(
  opponentFighterIds: number[],
  myFighterIds: number[],
  myRecordsVsOpponent: Map<number, MyCharacterRecordVsOpponent[]>,
): MatchupRanking[] {
  return opponentFighterIds.map((opponentFighterId) =>
    rankMatchup(opponentFighterId, myFighterIds, myRecordsVsOpponent.get(opponentFighterId) ?? []),
  );
}

/**
 * D-05/D-07's first application to the character advisor: sums countable
 * games (`wins + losses`) across `myRecordsVsOpponent` and abstains below
 * `floor` — the unchanged `rankMatchup` blend above never runs on a
 * below-floor sample. `floor` defaults to `ABSTENTION_FLOOR_GAMES` and is
 * routed through `effectiveFloor` so an explicit sub-floor argument can
 * never weaken the gate (R1-HIGH-1's engine-wide invariant), matching
 * `rankStagesByEvidence`/`rankMatchupsByEvidence`'s own contract. The
 * abstained arm's `sample` still carries provenance: character-pair
 * identity is always known (mirrors `buildMatchupEvidence`'s own comment),
 * so `rawSampleSize` and `eligibleDenominator` are both the summed count and
 * there is no separate "known-field" concept to track here.
 */
export function rankMatchupWithGate(
  opponentFighterId: number,
  myFighterIds: number[],
  myRecordsVsOpponent: MyCharacterRecordVsOpponent[],
  floor = ABSTENTION_FLOOR_GAMES,
): EvidenceClaim<MatchupRanking> {
  const countable = myRecordsVsOpponent.reduce((sum, r) => sum + r.wins + r.losses, 0);
  const effective = effectiveFloor(floor);
  const sample: SampleMeta = {
    rawSampleSize: countable,
    eligibleDenominator: countable,
    knownFieldCoverage: countable > 0 ? 1 : 0,
    dateRange: null,
    refreshedAt: Date.now(),
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(countable),
  };

  if (countable < effective) {
    return {
      kind: 'abstained',
      claimType: 'recommendation',
      reason: 'insufficient-sample',
      sample,
      gamesNeeded: effective - countable,
    };
  }

  return {
    kind: 'evidenced',
    claimType: 'recommendation',
    value: rankMatchup(opponentFighterId, myFighterIds, myRecordsVsOpponent),
    sample,
  };
}

/**
 * `rankMatchupWithGate` over every opponent fighter id in
 * `opponentFighterIds` — one claim per opponent character, same shape as
 * `buildMatchupAdvisor` but gated. Nothing in Phase 36 calls this yet (the
 * web card calls `rankMatchupWithGate` directly, one opponent at a time);
 * it exists as the batch entry point a future report/summary consumer
 * reaches for instead of re-deriving the per-opponent loop.
 */
export function buildMatchupAdvisorWithGate(
  opponentFighterIds: number[],
  myFighterIds: number[],
  myRecordsVsOpponent: Map<number, MyCharacterRecordVsOpponent[]>,
  floor?: number,
): EvidenceClaim<MatchupRanking>[] {
  return opponentFighterIds.map((opponentFighterId) =>
    rankMatchupWithGate(
      opponentFighterId,
      myFighterIds,
      myRecordsVsOpponent.get(opponentFighterId) ?? [],
      floor,
    ),
  );
}

const DEFAULT_TOP_CHARACTERS_COUNT = 5;

/**
 * Selects the candidate fighter ids the advisor should rank against a given
 * opponent: the union of the user's primary/secondary selections and their
 * own top-N most-played characters (by games played, from `myFighterIdsPlayed`
 * — one entry per game, e.g. `matches.map(m => m.fighter_id)`). Shared so the
 * web `ScoutMatchupAdvisorCard` and the API's `reports/generate.ts` payload
 * assembly compute the EXACT same candidate list from equivalent inputs,
 * rather than maintaining two implementations of the same "what do I play"
 * heuristic that could quietly drift apart.
 */
export function selectMyCandidateFighterIds(
  myFighterIdsPlayed: number[],
  primaryFighterIds: number[],
  secondaryFighterIds: number[],
  topCount = DEFAULT_TOP_CHARACTERS_COUNT,
): number[] {
  const gamesPlayedByFighterId = new Map<number, number>();
  for (const fighterId of myFighterIdsPlayed) {
    gamesPlayedByFighterId.set(fighterId, (gamesPlayedByFighterId.get(fighterId) ?? 0) + 1);
  }
  const myTopFighterIds = [...gamesPlayedByFighterId.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topCount)
    .map(([fighterId]) => fighterId);

  return [...new Set<number>([...primaryFighterIds, ...secondaryFighterIds, ...myTopFighterIds])];
}
