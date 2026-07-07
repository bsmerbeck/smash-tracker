import type { GspPoint, TCalibration } from '@smash-tracker/shared';
import type { RatingPeriodResult } from '@/lib/glicko';
import { toMmrSeries } from './gspMmrModel';

/** Minimum points required in EITHER series before the "MMR vs Glicko-2" card renders. */
export const GSP_VS_GLICKO_MIN_POINTS = 3;

/** One point in the normalized overlay series, keyed by time so both lines share an x-axis. */
export interface NormalizedPoint {
  time: number;
  /** Min-max normalized to 0-100 within its own series. */
  value: number;
}

/**
 * Min-max normalizes `values` to the 0-100 range. When every value is
 * identical (zero range), returns 50 for every point (a flat mid-line) rather
 * than dividing by zero.
 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return values.map(() => 50);
  }
  return values.map((v) => ((v - min) / range) * 100);
}

export interface GspVsGlickoData {
  mmr: NormalizedPoint[];
  glicko: NormalizedPoint[];
}

/**
 * Builds the two normalized series for the "MMR vs Glicko-2" overlay: the
 * selected fighter's GSP readings CONVERTED TO ESTIMATED MMR (V10.1 — see
 * ../lib/gspMmrModel.ts) vs. the player's overall Glicko-2 rating history
 * (ALL fighters — see `computeRatingHistory`).
 *
 * V10.1 note on normalization: both series are still independently min-max
 * normalized to 0-100. The units remain unrelated (Nintendo's hidden MMR
 * scale vs. Glicko-2's rating scale), so a shared raw axis would be
 * arbitrary — but the comparison is far more honest than V10's raw-GSP
 * version: MMR is a drift-free rating like Glicko, whereas raw GSP inflated
 * over time (a rising series even at flat skill) and its normal-CDF shape
 * compressed changes near the ceiling. Normalizing two RATINGS compares
 * their shapes; normalizing a rating against an inflating percentile-ish
 * count distorted them.
 *
 * `glicko` uses each rating period's END time (`RatingPeriodResult.end`) as
 * its x-value, since a period covers a whole session rather than one instant.
 */
export function buildGspVsGlickoData(
  gspSeries: GspPoint[],
  ratingPeriods: RatingPeriodResult[],
  calibration?: TCalibration,
): GspVsGlickoData {
  const mmrSeries = toMmrSeries(gspSeries, calibration);
  const mmrValues = minMaxNormalize(mmrSeries.map((p) => p.mmr));
  const glickoValues = minMaxNormalize(ratingPeriods.map((p) => p.rating));

  return {
    mmr: mmrSeries.map((p, i) => ({ time: p.time, value: mmrValues[i]! })),
    glicko: ratingPeriods.map((p, i) => ({ time: p.end, value: glickoValues[i]! })),
  };
}
