import type { Match, PeriodGrain, PeriodSeries } from '@smash-tracker/shared';
import { buildPeriodSeries } from '@smash-tracker/shared';

/**
 * Plan 39.1-41 (sketch 003 A, MANIFEST 2026-09-25 "quarterly trend", PD-41-1):
 * a scoped pairing trend never bins finer than a quarter — the per-set
 * 0 / 33 / 67 / 100% points the ladder picked for a 102-game pairing were the
 * owner's "0/100 hollow noise". A pairing with fewer than 8 quarters shows
 * the locked trend.
 */
export const MATCHUP_TREND_MIN_GRAIN: PeriodGrain = 'quarter';

/**
 * Plan 39.1-41: the ONE scoped period series for a pairing — the shared
 * engine's ladder started at `MATCHUP_TREND_MIN_GRAIN` (the chart never
 * bins, VIZ-01). `MatchupsPage` plots this AND resolves its drill terminus
 * against it, so a clicked quarter narrows to exactly that quarter's games.
 */
export function buildMatchupPeriodSeries(matches: Match[]): PeriodSeries {
  return buildPeriodSeries({ matches, minGrain: MATCHUP_TREND_MIN_GRAIN });
}
