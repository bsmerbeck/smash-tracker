import type { Match } from '@smash-tracker/shared';
import {
  getRollingWinRate,
  getStreakSummary,
  getWinLossRecord,
  type RollingWinRatePoint,
  type WinLossRecord,
} from '@/lib/stats';

const ROLLING_WINDOW = 10;
const FORM_LIMIT = 10;

export interface FighterHeroStreak {
  count: number;
  isWin: boolean;
}

export interface FighterHeroData {
  record: WinLossRecord;
  /** Share of the user's ENTIRE (unfiltered) match history played as this fighter, 0-100 rounded to the nearest whole percent. `0` when the user has no matches at all. */
  sharePct: number;
  streak: FighterHeroStreak;
  /** Rolling win-rate sparkline series (window 10), chronological. */
  sparkline: RollingWinRatePoint[];
}

/**
 * Pure computations backing the Fighter Analysis hero region: overall
 * record, this fighter's share of the user's total games, the current
 * streak (magnitude + direction), and a rolling win-rate sparkline. `
 * fighterMatches` should already be filtered to the selected fighter (and to
 * the global analytics filter); `allMatches` is the user's entire,
 * completely unfiltered match history — the share % denominator is
 * intentionally NOT affected by the global filter, so "38% of your games"
 * always answers "of everything you've ever logged".
 */
export function buildFighterHero(fighterMatches: Match[], allMatches: Match[]): FighterHeroData {
  const record = getWinLossRecord(fighterMatches);
  const { currentStreak, currentStreakIsWin } = getStreakSummary(fighterMatches);
  const sharePct =
    allMatches.length === 0 ? 0 : Math.round((fighterMatches.length / allMatches.length) * 100);

  return {
    record,
    sharePct,
    streak: { count: currentStreak, isWin: currentStreakIsWin },
    sparkline: getRollingWinRate(fighterMatches, ROLLING_WINDOW),
  };
}

export { FORM_LIMIT };
