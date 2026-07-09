import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import {
  getRecordsByFighter,
  rankMatchupsByEvidence,
  rankStagesByEvidence,
  type WinLossRecord,
} from '@/lib/stats';
import { stagesById } from '@/data/stages';

/** How many opponent characters the coverage grid surfaces, ranked by how often the user faces them overall. */
export const COVERAGE_TOP_N = 12;
/** Below this many games, a coverage cell reads as "thin data" rather than a confident record. */
export const THIN_DATA_MAX_GAMES = 2;
/** Matchups need at least this many games before they can be called out as a "struggling vs X" practice recommendation. */
export const PRACTICE_MATCHUP_MIN_GAMES = 3;
/** Stages need at least this many games before they can be called out as a "you keep playing on Z" practice recommendation. */
export const PRACTICE_STAGE_MIN_GAMES = 3;
/** A coverage gap ("you face them often but have never played them") only fires once the meta opponent has been faced at least this many times account-wide. */
export const COVERAGE_GAP_MIN_META_GAMES = 3;

export type CoverageStatus = 'covered' | 'thin' | 'none';

export interface CoverageEntry {
  opponentFighterId: number;
  /** How often this opponent character is faced across the user's entire filtered dataset (all of the user's fighters), used to rank the top-N list. */
  metaGames: number;
  /** This SELECTED fighter's record against this opponent character, or null when there are zero games (status 'none'). */
  record: WinLossRecord | null;
  status: CoverageStatus;
}

/**
 * The top `COVERAGE_TOP_N` opponent characters across the user's ENTIRE
 * filtered dataset (every one of the user's fighters, not just the selected
 * one) — i.e. "the meta you actually face" — each annotated with the
 * SELECTED fighter's coverage against that character: their record when
 * there's at least one game, and a status flag distinguishing solid data
 * ('covered', 3+ games), thin data (1-2 games), and no data at all (0 games).
 */
export function buildMatchupCoverage(
  allFilteredMatches: Match[],
  fighterMatches: Match[],
): CoverageEntry[] {
  const metaOpponents = getRecordsByFighter(allFilteredMatches, (m) => m.opponent_id)
    .sort((a, b) => b.total - a.total)
    .slice(0, COVERAGE_TOP_N);

  const recordByOpponent = new Map(
    getRecordsByFighter(fighterMatches, (m) => m.opponent_id).map((r) => [r.fighterId, r]),
  );

  return metaOpponents.map((meta) => {
    const fighterRecord = recordByOpponent.get(meta.fighterId) ?? null;
    const status: CoverageStatus =
      !fighterRecord || fighterRecord.total === 0
        ? 'none'
        : fighterRecord.total <= THIN_DATA_MAX_GAMES
          ? 'thin'
          : 'covered';
    const record: WinLossRecord | null =
      fighterRecord && fighterRecord.total > 0
        ? {
            wins: fighterRecord.wins,
            losses: fighterRecord.losses,
            total: fighterRecord.total,
            winRate: fighterRecord.winRate,
          }
        : null;
    return {
      opponentFighterId: meta.fighterId,
      metaGames: meta.total,
      record,
      status,
    };
  });
}

export type PracticeRecKind = 'worst-matchup' | 'coverage-gap' | 'stage-habit';

export interface PracticeRecommendation {
  kind: PracticeRecKind;
  text: string;
}

/**
 * Up to 3 evidence-driven practice bullets for the selected fighter, each
 * omitted when its trigger condition isn't met:
 *
 * 1. Worst Wilson-ranked matchup with >= `PRACTICE_MATCHUP_MIN_GAMES` games
 *    ("struggling vs X: 2-7").
 * 2. Biggest coverage gap: the highest-`metaGames` coverage entry with
 *    `status === 'none'` that's been faced at least
 *    `COVERAGE_GAP_MIN_META_GAMES` times account-wide ("no games vs Y — you
 *    face them often").
 * 3. Worst ban-worthy stage habit: the lowest Wilson-ranked stage with >=
 *    `PRACTICE_STAGE_MIN_GAMES` games ("you keep playing on Z: 1-5").
 *
 * `nameForFighter`/`nameForStage` are injected so this module stays pure
 * (no sprite/stage-art imports needed beyond stage name lookup, which is
 * data, not rendering); `t` is injected the same way so the bullets come
 * out of the active locale.
 */
export function buildPracticeRecommendations(
  fighterMatches: Match[],
  coverage: CoverageEntry[],
  nameForFighter: (fighterId: number) => string,
  t: TFunction,
): PracticeRecommendation[] {
  const recs: PracticeRecommendation[] = [];

  const rankedMatchups = rankMatchupsByEvidence(fighterMatches, PRACTICE_MATCHUP_MIN_GAMES);
  const worstMatchup = rankedMatchups[rankedMatchups.length - 1];
  if (worstMatchup) {
    recs.push({
      kind: 'worst-matchup',
      text: t('fighterAnalysis.practice.struggling', {
        name: nameForFighter(worstMatchup.opponentFighterId),
        wins: worstMatchup.wins,
        losses: worstMatchup.losses,
      }),
    });
  }

  const gap = coverage
    .filter((entry) => entry.status === 'none' && entry.metaGames >= COVERAGE_GAP_MIN_META_GAMES)
    .sort((a, b) => b.metaGames - a.metaGames)[0];
  if (gap) {
    recs.push({
      kind: 'coverage-gap',
      text: t('fighterAnalysis.practice.noGames', {
        name: nameForFighter(gap.opponentFighterId),
      }),
    });
  }

  const rankedStages = rankStagesByEvidence(fighterMatches, PRACTICE_STAGE_MIN_GAMES);
  const worstStage = rankedStages[rankedStages.length - 1];
  if (worstStage) {
    const stageName = stagesById.get(worstStage.stageId)?.name ?? t('common.unknown');
    recs.push({
      kind: 'stage-habit',
      text: t('fighterAnalysis.practice.stageHabit', {
        stage: stageName,
        wins: worstStage.wins,
        losses: worstStage.losses,
      }),
    });
  }

  return recs;
}
