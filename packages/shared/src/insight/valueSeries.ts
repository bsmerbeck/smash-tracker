import { MARK_BOUND_LINE_POINTS } from './markBounds.js';
import { calendarBucketBounds } from './periodSeries.js';

/**
 * UI-SPEC §7.1 (value input) / DD-41-09: the value-series grain ladder — a numeric reading series
 * (GSP, estimated MMR, Glicko-2 rating) binned to a bounded number of close-of-period points.
 * Plan 41-01 landed the types and bound constants; plan 41-02 adds `buildValueSeries` to this same
 * file, so the insight barrel is touched once for the whole phase.
 *
 * The chart layer never bins: every grain decision, calibration flag and point identity is produced
 * here, and the chosen grain's points are final by the time a component reads them.
 *
 * Zone rule (resolves the UI-SPEC open item "readings at a period boundary"): `week`, `month` and
 * `quarter` buckets use `calendarBucketBounds` (UTC); `day` uses the host-local calendar day, matching
 * the GSP log's host-local dates. A click resolves rows by `memberIndexes`, so a reading on a bucket
 * boundary can never land on rows the close did not count.
 *
 * Grain rule (UAT 41 test 9 / F19): a reading-grain point is one instant; readings sharing an instant
 * are one close-of-instant point (`kind: 'close'`, value = the last of them), so no two points share
 * an x and every direct label sits on a vertex the line actually turns at.
 */

/**
 * The ladder's grains, finest first. A `reading`-grain point is one instant: readings that share an
 * instant are one close-of-instant point (UAT 41 test 9 / F19), never a zero-width spike at one x.
 */
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
  /**
   * True when `grain` fit the target (the `buildPeriodSeries` meaning, mirrored). False only when
   * even `quarter` exceeded it: the series is then cut to the newest `target` points and the older
   * closes are dropped, never silently drawn past the mark bound.
   */
  boundReached: boolean;
}

export interface BuildValueSeriesOptions {
  /** Defaults to `MARK_BOUND_LINE_POINTS` (60) — the default line-chart bound. */
  target?: number;
  /** Lets a host force a coarser grain (plan 41-07's shared grain across panels). */
  minGrain?: ValueSeriesGrain;
}

/** A reading with a non-finite time or value is skipped, never bucketed (T-41-05). */
function isUsable(reading: ValueSeriesReading): boolean {
  return Number.isFinite(reading.atMs) && Number.isFinite(reading.value);
}

interface Bucket {
  key: string;
  startMs: number;
  endMs: number;
  members: number[];
}

/** The host-local calendar day containing `ms` (the GSP log's own day), `[local midnight, next local midnight)`. */
function localDayBounds(ms: number): { key: string; startMs: number; endMs: number } {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();
  const label = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    key: `day:${label}`,
    startMs: new Date(year, month, day).getTime(),
    endMs: new Date(year, month, day + 1).getTime(),
  };
}

function bucketBoundsFor(
  grain: Exclude<ValueSeriesGrain, 'reading'>,
  ms: number,
): { key: string; startMs: number; endMs: number } {
  if (grain === 'day') return localDayBounds(ms);
  const { key, startMs, endMs } = calendarBucketBounds(grain, ms);
  return { key, startMs, endMs };
}

/**
 * Turns an ordered member list (chronological, ties by input index) into one point. The close is
 * the LAST member: its time is the point's `xMs` and its value the point's `value`.
 */
function toPoint(
  readings: readonly ValueSeriesReading[],
  grain: ValueSeriesGrain,
  bucket: Bucket,
): ValueSeriesPoint {
  const closeIndex = bucket.members[bucket.members.length - 1]!;
  const close = readings[closeIndex]!;
  const containsCalibration = bucket.members.some((index) => readings[index]!.calibration);
  // A multi-member reading-grain bucket is a same-instant close (F19): it routes as a period click.
  const kind: ValueSeriesPoint['kind'] =
    grain !== 'reading' || bucket.members.length > 1
      ? 'close'
      : close.calibration
        ? 'calibration'
        : 'reading';
  return {
    key: bucket.key,
    xMs: close.atMs,
    value: close.value,
    kind,
    n: bucket.members.length,
    memberIndexes: bucket.members,
    containsCalibration,
    startMs: bucket.startMs,
    endMs: bucket.endMs,
  };
}

/** Chronological order, ties by input index — the one order every bucket's members and the reading grain share. */
function chronologicalIndexes(readings: readonly ValueSeriesReading[]): number[] {
  const indexes: number[] = [];
  readings.forEach((reading, index) => {
    if (isUsable(reading)) indexes.push(index);
  });
  return indexes.sort((a, b) => readings[a]!.atMs - readings[b]!.atMs || a - b);
}

function pointsForGrain(
  readings: readonly ValueSeriesReading[],
  ordered: readonly number[],
  grain: ValueSeriesGrain,
): ValueSeriesPoint[] {
  const buckets: Bucket[] = [];
  if (grain === 'reading') {
    // Readings that share one instant are ONE close-of-instant point (UAT 41 test 9 / F19): `ordered`
    // is chronological with ties by input index, so the group's last member is the instant's close
    // (in `getGspSeries` order, a calibration reading after that instant's matches).
    for (const index of ordered) {
      const atMs = readings[index]!.atMs;
      const previous = buckets[buckets.length - 1];
      if (previous && previous.startMs === atMs) {
        previous.members.push(index);
      } else {
        buckets.push({
          key: `reading:${atMs}:${index}`,
          startMs: atMs,
          endMs: atMs,
          members: [index],
        });
      }
    }
  } else {
    const byKey = new Map<string, Bucket>();
    for (const index of ordered) {
      const bounds = bucketBoundsFor(grain, readings[index]!.atMs);
      const existing = byKey.get(bounds.key);
      if (existing) {
        existing.members.push(index);
      } else {
        const bucket: Bucket = { ...bounds, members: [index] };
        byKey.set(bounds.key, bucket);
        buckets.push(bucket);
      }
    }
  }
  return (
    buckets
      .map((bucket) => toPoint(readings, grain, bucket))
      // Ties break on the first member's input index — numeric, never a string compare of keys.
      .sort((a, b) => a.xMs - b.xMs || a.memberIndexes[0]! - b.memberIndexes[0]!)
  );
}

/**
 * A1 / DD-41-01: bins `readings` onto the FINEST grain of `reading → day → week → month → quarter`
 * (starting at `minGrain`) whose point count is at or below `target` (default
 * `MARK_BOUND_LINE_POINTS`). The same ladder rule as `buildPeriodSeries`, one binning algorithm for
 * every numeric series. Each point is a close-of-period: the value and time of the period's last
 * reading. A non-finite reading is skipped (T-41-05). Pure — no module state, no `Intl`; the input
 * is never mutated, and hosts memoise.
 *
 * Over zero usable readings it returns an empty series at the finest permitted grain with
 * `boundReached: true` — a named grain and no synthetic point, never a throw.
 */
export function buildValueSeries(
  readings: readonly ValueSeriesReading[],
  options: BuildValueSeriesOptions = {},
): ValueSeries {
  const { target = MARK_BOUND_LINE_POINTS, minGrain } = options;
  const ordered = chronologicalIndexes(readings);
  const ladder = VALUE_SERIES_GRAIN_LADDER.slice(
    minGrain ? VALUE_SERIES_GRAIN_LADDER.indexOf(minGrain) : 0,
  );
  let grain: ValueSeriesGrain = ladder[0]!;
  let points: ValueSeriesPoint[] = [];
  for (const candidate of ladder) {
    grain = candidate;
    points = pointsForGrain(readings, ordered, candidate);
    if (points.length <= target) {
      return { grain, points, boundReached: true };
    }
  }
  return { grain, points: points.slice(points.length - target), boundReached: false };
}
