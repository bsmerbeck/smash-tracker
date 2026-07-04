import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { rankStagesByEvidence, type RankedStage } from '@/lib/stats';
import { buildSetTimeline, type TournamentSet } from './setTimeline';

/** Stages need at least this many recorded pre-tournament games in the pairing to be graded — mirrors CounterpickAdvisor's `MIN_GAMES`. */
const MIN_GAMES = 2;
/** Top/bottom split size — mirrors CounterpickAdvisor's `PICK_BAN_COUNT`. */
const PICK_BAN_COUNT = 3;

export type PickClassification = 'followed' | 'against' | 'neutral' | 'no-data';

export interface ClassifiedGame {
  match: Match;
  classification: PickClassification;
  /** The advisor's recommended picks (stage ids) at the time this game was played, empty when no-data. */
  recommendedStageIds: number[];
  /** The advisor's ban-worthy stages (stage ids) at the time this game was played, empty when no-data. */
  banStageIds: number[];
}

export interface RetrospectiveSetRow {
  set: TournamentSet;
  games: ClassifiedGame[];
}

export interface AdherenceSummary {
  /** Count of games classified as 'followed' or 'against' (i.e. excluding neutral/no-data) — the denominator for adherence. */
  classifiable: number;
  followed: number;
  against: number;
  neutral: number;
  noData: number;
  /** followed / classifiable, as a whole-number percentage. `null` when classifiable is 0. */
  adherenceRate: number | null;
  /** Win rate (0-100) among 'followed' games. `null` when there are zero followed games. */
  followedWinRate: number | null;
  /** Win rate (0-100) among 'against' games. `null` when there are zero against games. */
  againstWinRate: number | null;
}

export interface Retrospective {
  rows: RetrospectiveSetRow[];
  /** Classified games outside any set (the "other matches" bucket), same shape as set rows' games. */
  otherGames: ClassifiedGame[];
  summary: AdherenceSummary;
}

/**
 * Splits evidence-ranked stages into "picks" (top 3) and "bans" (bottom 3,
 * worst-first), using the exact convention from
 * `apps/web/src/pages/Matchups/components/CounterpickAdvisor.tsx`: the ban
 * slice is capped so it never overlaps the pick slice, and is empty when the
 * ranked list is too short to have a disjoint tail.
 */
function pickBanFromRanked(ranked: RankedStage[]): { picks: RankedStage[]; bans: RankedStage[] } {
  const picks = ranked.slice(0, PICK_BAN_COUNT);
  const banCount = Math.min(PICK_BAN_COUNT, ranked.length - picks.length);
  const bans = banCount > 0 ? ranked.slice(ranked.length - banCount).reverse() : [];
  return { picks, bans };
}

/**
 * Classifies one game against the advisor's recommendation for its pairing,
 * computed from ONLY matches strictly before `entry.firstSetAt` (the state
 * of knowledge a player would have had walking into the tournament), scoped
 * to the same fighter_id/opponent_id pairing as the game itself. A stage id
 * of 0 ("no selection"/unknown) can't be graded and is treated as no-data at
 * the call site (see `buildRetrospective`), not here.
 */
function classifyGame(game: Match, preMatches: Match[]): ClassifiedGame {
  const pairingPre = preMatches.filter(
    (m) => m.fighter_id === game.fighter_id && m.opponent_id === game.opponent_id,
  );
  const ranked = rankStagesByEvidence(pairingPre, MIN_GAMES);

  if (ranked.length === 0) {
    return { match: game, classification: 'no-data', recommendedStageIds: [], banStageIds: [] };
  }

  const { picks, bans } = pickBanFromRanked(ranked);
  const recommendedStageIds = picks.map((s) => s.stageId);
  const banStageIds = bans.map((s) => s.stageId);
  const stageId = game.map?.id ?? 0;

  let classification: PickClassification;
  if (recommendedStageIds.includes(stageId)) {
    classification = 'followed';
  } else if (banStageIds.includes(stageId)) {
    classification = 'against';
  } else {
    classification = 'neutral';
  }

  return { match: game, classification, recommendedStageIds, banStageIds };
}

/**
 * Grades every game in the games with a known stage and known pairing
 * against what the Counterpick Advisor would have recommended using only
 * pre-tournament evidence. Games with an unknown stage (`map.id === 0` or
 * missing `map`) are always 'no-data' — there's nothing to grade. Pure
 * builder; the UI (`AdvisorRetrospective.tsx`) only renders this structure.
 *
 * @param allMatches every match the user has (used to derive pre-tournament evidence).
 * @param entryMatches the matches belonging to this specific tournament entry (via `matchesForEntry`).
 * @param entry the tournament entry being graded.
 */
export function buildRetrospective(
  allMatches: Match[],
  entryMatches: Match[],
  entry: TournamentEntry,
): Retrospective {
  const preMatches = allMatches.filter((m) => m.time < entry.firstSetAt);
  const { sets, otherMatches } = buildSetTimeline(entryMatches);

  const classify = (match: Match): ClassifiedGame => {
    const stageId = match.map?.id ?? 0;
    if (stageId === 0) {
      return { match, classification: 'no-data', recommendedStageIds: [], banStageIds: [] };
    }
    return classifyGame(match, preMatches);
  };

  const rows: RetrospectiveSetRow[] = sets.map((set) => ({
    set,
    games: set.games.map((g) => classify(g.match)),
  }));
  const otherGames = otherMatches.map((match) => classify(match));

  const allGames = [...rows.flatMap((r) => r.games), ...otherGames];

  let followed = 0;
  let against = 0;
  let neutral = 0;
  let noData = 0;
  let followedWins = 0;
  let againstWins = 0;

  for (const g of allGames) {
    switch (g.classification) {
      case 'followed':
        followed += 1;
        if (g.match.win) {
          followedWins += 1;
        }
        break;
      case 'against':
        against += 1;
        if (g.match.win) {
          againstWins += 1;
        }
        break;
      case 'neutral':
        neutral += 1;
        break;
      case 'no-data':
        noData += 1;
        break;
    }
  }

  const classifiable = followed + against;

  const summary: AdherenceSummary = {
    classifiable,
    followed,
    against,
    neutral,
    noData,
    adherenceRate: classifiable > 0 ? Math.round((followed / classifiable) * 100) : null,
    followedWinRate: followed > 0 ? Math.round((followedWins / followed) * 100) : null,
    againstWinRate: against > 0 ? Math.round((againstWins / against) * 100) : null,
  };

  return { rows, otherGames, summary };
}
