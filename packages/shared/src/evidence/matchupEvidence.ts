import type { Match } from '../match.js';
import {
  effectiveFloor,
  confidenceTierFor,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
} from './policy.js';
import { gateBySampleSize } from './gate.js';
import { rankByWilson } from './rank.js';
import {
  getWinLossRecord,
  type MatchupStats,
  type StageRecord,
  type WinLossRecord,
} from './records.js';
import { getBestWorstStages } from './stageEvidence.js';
import { describeCohort, type CohortComposition } from './cohort.js';
import { isUnknownCharacter } from './predicate.js';
import type { EvidenceClaim, SampleMeta, UnknownBucket } from './types.js';

/**
 * `buildMatchupEvidence` and `rankMatchupsByEvidence` take NO `aliasMap`
 * (R1-BLOCKER-2). Their grouping key is `match.opponent_id` — the
 * opponent's FIGHTER id, never `match.opponent` — so canonicalizing the
 * opponent tag before grouping cannot move a single row. See
 * `opponentEvidence.ts` for the axis where the alias map is load-bearing.
 */

export interface RankedMatchup extends MatchupStats {
  /** Wilson lower bound (0-1) for this matchup's win rate. */
  wilson: number;
}

/**
 * Per-opponent-fighter records ranked by Wilson lower bound (best first),
 * gated at `effectiveFloor(minMatches)` — an explicitly passed sub-floor
 * threshold cannot reopen a below-floor row (D-07, R1-HIGH-1).
 */
export function rankMatchupsByEvidence(matches: Match[], minMatches?: number): RankedMatchup[] {
  const floor = effectiveFloor(minMatches);
  const byOpponent = new Map<number, Match[]>();
  for (const match of matches) {
    const group = byOpponent.get(match.opponent_id);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(match.opponent_id, [match]);
    }
  }
  const candidates: MatchupStats[] = [...byOpponent.entries()].map(([opponentFighterId, ms]) => {
    const wins = ms.filter((m) => m.win).length;
    const losses = ms.length - wins;
    const totalMatches = ms.length;
    const ratio = losses ? Math.round((wins / totalMatches) * 100) : 100;
    return { opponentFighterId, wins, losses, totalMatches, ratio };
  });
  const { evidenced } = gateBySampleSize(candidates, (row) => row.totalMatches, floor);
  return rankByWilson(
    evidenced,
    (row) => row.wins,
    (row) => row.totalMatches,
    (row) => row.opponentFighterId,
  );
}

export interface MatchupStageGuideRow {
  /** The opponent's fighter id (`opponent_id`). */
  opponentFighterId: number;
  record: WinLossRecord;
  bestStage: StageRecord | null;
  worstStage: StageRecord | null;
}

/**
 * For each opponent fighter actually faced in the given matches: the
 * win/loss record for that matchup plus the best and worst stage to fight
 * that opponent on, using `getBestWorstStages` with `minStageMatches` as the
 * per-stage qualification threshold (which itself routes through
 * `effectiveFloor`). Rows are sorted by sample size (total matches)
 * descending, then win rate descending, so the most-informed matchups lead.
 */
export function getMatchupStageGuide(
  matches: Match[],
  minStageMatches = 3,
): MatchupStageGuideRow[] {
  const byOpponent = new Map<number, Match[]>();
  for (const match of matches) {
    const group = byOpponent.get(match.opponent_id);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(match.opponent_id, [match]);
    }
  }

  return [...byOpponent.entries()]
    .map(([opponentFighterId, opponentMatches]) => ({
      opponentFighterId,
      record: getWinLossRecord(opponentMatches),
      ...getBestWorstStages(opponentMatches, minStageMatches),
    }))
    .map(({ opponentFighterId, record, best, worst }) => ({
      opponentFighterId,
      record,
      bestStage: best,
      worstStage: worst,
    }))
    .sort((a, b) =>
      b.record.total === a.record.total
        ? b.record.winRate - a.record.winRate
        : b.record.total - a.record.total,
    );
}

export interface MatchupEvidenceResult {
  claim: EvidenceClaim<RankedMatchup[]>;
  unknown: UnknownBucket | null;
  cohort: CohortComposition;
}

/**
 * The shared character-pair evidence claim (EVID-01, D-15): a Wilson-ranked
 * per-opponent-fighter list, gated at the abstention floor, plus the
 * cohort composition of the sample the query drew from (computed once per
 * query, not per ranked row — the composition describes the SAMPLE, not
 * any one row).
 *
 * Rows whose `fighter_id`/`opponent_id` doesn't map to a known roster
 * member (`predicate.ts`'s `isUnknownCharacter`) are bucketed into
 * `unknown` and excluded from the ranked list and from `eligibleDenominator`
 * — the same D-09/EVID-11 treatment `buildStageEvidence` already gives the
 * unknown-STAGE axis. D-25: no live ingestion path produces an
 * unknown-character row today (both sync pipelines drop it before it ever
 * reaches a `Match[]`); this branch is exercised only by
 * `testUtils/sparseWorkspaces.ts`'s `unknownCharacterOnlyWorkspace`.
 */
export function buildMatchupEvidence(input: {
  matches: Match[];
  refreshedAt: number;
  minMatches?: number;
}): MatchupEvidenceResult {
  const { matches, refreshedAt, minMatches } = input;
  const floor = effectiveFloor(minMatches);

  const rawSampleSize = matches.length;
  const knownCharacterMatches = matches.filter((m) => !isUnknownCharacter(m));
  const unknownCharacterMatches = matches.filter((m) => isUnknownCharacter(m));
  const eligibleDenominator = knownCharacterMatches.length;

  const times = knownCharacterMatches.map((m) => m.time);
  const dateRange =
    times.length > 0 ? { firstMs: Math.min(...times), lastMs: Math.max(...times) } : null;

  const sample: SampleMeta = {
    rawSampleSize,
    eligibleDenominator,
    knownFieldCoverage: rawSampleSize > 0 ? eligibleDenominator / rawSampleSize : 0,
    dateRange,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(eligibleDenominator),
  };

  const unknown: UnknownBucket | null =
    unknownCharacterMatches.length > 0
      ? {
          games: unknownCharacterMatches.length,
          wins: unknownCharacterMatches.filter((m) => m.win).length,
          losses: unknownCharacterMatches.filter((m) => !m.win).length,
        }
      : null;

  const cohort = describeCohort(matches);
  const ranked = rankMatchupsByEvidence(knownCharacterMatches, floor);

  if (ranked.length === 0) {
    return {
      claim: {
        kind: 'abstained',
        claimType: 'inference',
        reason: 'insufficient-sample',
        sample,
        gamesNeeded: Math.max(0, floor - eligibleDenominator),
      },
      unknown,
      cohort,
    };
  }

  return {
    claim: { kind: 'evidenced', claimType: 'inference', value: ranked, sample },
    unknown,
    cohort,
  };
}
