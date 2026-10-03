/**
 * UI-SPEC §7.1 (value input) / DD-41-09: the contract of the value-series grain ladder — a numeric
 * reading series (GSP, estimated MMR, Glicko-2 rating) binned to a bounded number of close-of-period
 * points. Interface-first (plan 41-01): this module holds the final exported types and bound
 * constants only; plan 41-02 adds `buildValueSeries` to this same file, so the insight barrel is
 * touched once for the whole phase.
 *
 * The chart layer never bins: every grain decision, calibration flag and point identity is produced
 * here, and the chosen grain's points are final by the time a component reads them.
 *
 * Zone rule (resolves the UI-SPEC open item "readings at a period boundary"): `week`, `month` and
 * `quarter` buckets use `calendarBucketBounds` (UTC); `day` uses the host-local calendar day, matching
 * the GSP log's host-local dates. A click resolves rows by `memberIndexes`, so a reading on a bucket
 * boundary can never land on rows the close did not count.
 */

/** The ladder's grains, finest first. `reading` is one point per input row (no binning). */
export type ValueSeriesGrain = 'reading' | 'day' | 'week' | 'month' | 'quarter';

/** The grain ladder in escalation order — the builder walks it until the point count fits its target. */
export const VALUE_SERIES_GRAIN_LADDER: readonly ValueSeriesGrain[] = [
  'reading',
  'day',
  'week',
  'month',
  'quarter',
];

/** One input row. Its identity is its index in the input array. */
export interface ValueSeriesReading {
  atMs: number;
  value: number;
  /** True for a manually set (calibration) reading rather than one derived from play. */
  calibration: boolean;
}

/**
 * One output point. `memberIndexes` (indices into the input array) is the point's identity —
 * `[startMs, endMs]` is NOT (CR-02, mirrored from `PeriodPoint.matchIds`): two adjacent buckets can
 * share a boundary instant, but never a member. `xMs` is the close reading's time and `value` is the
 * close-of-period value.
 */
export interface ValueSeriesPoint {
  key: string;
  xMs: number;
  value: number;
  kind: 'reading' | 'calibration' | 'close';
  /** Number of input readings the point summarises. */
  n: number;
  memberIndexes: number[];
  containsCalibration: boolean;
  startMs: number;
  endMs: number;
}

export interface ValueSeries {
  grain: ValueSeriesGrain;
  points: ValueSeriesPoint[];
  /** True when the coarsest grain still exceeded the target and the series was truncated to it. */
  boundReached: boolean;
}

export interface BuildValueSeriesOptions {
  /** Defaults to `MARK_BOUND_LINE_POINTS` (60) — the default line-chart bound. */
  target?: number;
  /** Lets a host force a coarser grain (plan 41-07's shared grain across panels). */
  minGrain?: ValueSeriesGrain;
}
