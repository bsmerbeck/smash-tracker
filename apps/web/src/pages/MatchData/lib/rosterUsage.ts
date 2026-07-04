import type { Fighter, Match } from '@smash-tracker/shared';
import { getWinLossRecord } from '@/lib/stats';

export interface RosterUsageRow {
  fighter: Fighter;
  games: number;
  /** Share of total games played (0-100), rounded to the nearest whole percent — used as the usage bar width. */
  usagePercent: number;
  wins: number;
  losses: number;
  /** Win rate as a whole-number percentage (0-100). 100 when there are no losses, matching `getWinLossRecord`. */
  winRate: number;
}

/** Win-rate chip tone thresholds, matching the house convention (emerald=good, destructive=bad, neutral otherwise) used across the app (WinLossPips, MatchupInsights, HeroStats). */
export type WinRateTone = 'positive' | 'neutral' | 'negative';

export function winRateTone(winRate: number): WinRateTone {
  if (winRate >= 55) return 'positive';
  if (winRate < 45) return 'negative';
  return 'neutral';
}

/**
 * Builds the roster usage breakdown: one row per fighter the user has
 * actually played (games > 0), ordered by usage (games) descending, ties
 * broken by fighter name for stable output. Replaces FighterPieChart's
 * doughnut chart per user feedback ("huge and doesn't give much insight").
 *
 * `fighterSprites` is the user's primary+secondary selection (same source
 * FighterPieChart used) so unplayed selected fighters are simply omitted
 * rather than shown with a zero-length bar.
 */
export function buildRosterUsage(matches: Match[], fighterSprites: Fighter[]): RosterUsageRow[] {
  const totalGames = matches.length;
  const rows: RosterUsageRow[] = [];

  for (const fighter of fighterSprites) {
    const fighterMatches = matches.filter((m) => m.fighter_id === fighter.id);
    if (fighterMatches.length === 0) continue;

    const { wins, losses, winRate } = getWinLossRecord(fighterMatches);
    rows.push({
      fighter,
      games: fighterMatches.length,
      usagePercent: totalGames > 0 ? Math.round((fighterMatches.length / totalGames) * 100) : 0,
      wins,
      losses,
      winRate,
    });
  }

  return rows.sort((a, b) => b.games - a.games || a.fighter.name.localeCompare(b.fighter.name));
}
