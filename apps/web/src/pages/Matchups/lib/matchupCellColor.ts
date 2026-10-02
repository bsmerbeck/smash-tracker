import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { CHART_TOKENS } from '@/components/charts/tokens';

/**
 * Heat scale for the matchup matrix (plan 39.1-47, sketch 003 A `matrixCard`,
 * brief §5 M13 / M15). Pure and independently testable: given a cell's raw
 * win rate (0-1) and sample size, returns an inline `background-color`.
 *
 * The heat is the identity series-1 hue — `color-mix(in oklch, <series-1> N%,
 * transparent)` with N = 8 + win rate (0-100) x 0.5, so a 0% pairing sits at
 * a faint 8% wash and a 100% pairing at 58% — and nothing at all under the
 * 3-game abstention floor (`transparent`; the matrix outlines such a cell
 * instead, so a thin sample is never read as a strong colour). Win / loss
 * hues belong to win / loss marks only: the former red -> grey -> emerald
 * interpolation and its sample-size opacity band are gone.
 *
 * The 58% ceiling keeps `text-foreground` at >= 4.5:1 on every composited
 * cell (`matchupCellColor.test.ts`'s committed contrast oracle). The colour
 * comes from `CHART_TOKENS.series1` (a CSS custom property reference), never a
 * literal, so the palette guard's token validation covers it.
 */

/** N at a 0% win rate — the faintest wash a floor-clearing cell can have. */
const HEAT_BASE_PERCENT = 8;
/** Extra percent per point of win rate (0-100): a 100% cell reaches 58%. */
const HEAT_PERCENT_PER_RATE_POINT = 0.5;

/** CSS `background-color` for a matrix cell with this raw win rate (0-1) and sample size. */
export function matchupCellBackground(winRate: number, total: number): string {
  if (total < ABSTENTION_FLOOR_GAMES) {
    return 'transparent';
  }
  const ratePoints = Math.max(0, Math.min(1, winRate)) * 100;
  const percent = Math.round(HEAT_BASE_PERCENT + ratePoints * HEAT_PERCENT_PER_RATE_POINT);
  return `color-mix(in oklch, ${CHART_TOKENS.series1} ${percent}%, transparent)`;
}
