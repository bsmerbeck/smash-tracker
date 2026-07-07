import type { GspPoint } from '@smash-tracker/shared';
import type { RatingPeriodResult } from '@/lib/glicko';

/** Minimum points required in EITHER series before the "GSP vs Glicko-2" card renders. */
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
  gsp: NormalizedPoint[];
  glicko: NormalizedPoint[];
}

/**
 * Builds the two normalized series for the "GSP vs Glicko-2" overlay: the
 * selected fighter's GSP readings vs. the player's overall Glicko-2 rating
 * history (ALL fighters — see `computeRatingHistory`), each independently
 * min-max normalized to 0-100 so they're comparable on one axis despite being
 * on wildly different scales (GSP in the millions, Glicko ~1000-2000).
 * `glicko` uses each rating period's END time (`RatingPeriodResult.end`) as
 * its x-value, since a period covers a whole session rather than one instant.
 */
export function buildGspVsGlickoData(
  gspSeries: GspPoint[],
  ratingPeriods: RatingPeriodResult[],
): GspVsGlickoData {
  const gspValues = minMaxNormalize(gspSeries.map((p) => p.gsp));
  const glickoValues = minMaxNormalize(ratingPeriods.map((p) => p.rating));

  return {
    gsp: gspSeries.map((p, i) => ({ time: p.time, value: gspValues[i]! })),
    glicko: ratingPeriods.map((p, i) => ({ time: p.end, value: glickoValues[i]! })),
  };
}
