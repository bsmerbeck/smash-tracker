import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The shared vitest config does not pin a zone; `day` buckets are host-local, so this file pins UTC
 * before the module loads (and restores it) — the zone-dependent cases live in
 * `valueSeries.timezone.test.ts`.
 */
const originalTz = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'UTC';
  return previous;
});

import { MARK_BOUND_LINE_POINTS } from './markBounds.js';
import { buildValueSeries, type ValueSeriesReading } from './valueSeries.js';

afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 0, 1, 12);

function reading(atMs: number, value: number, calibration = false): ValueSeriesReading {
  return { atMs, value, calibration };
}

/** `count` readings spread evenly over `spanDays` days, value rising with the index. */
function spread(count: number, spanDays: number): ValueSeriesReading[] {
  return Array.from({ length: count }, (_, i) =>
    reading(START_MS + Math.round((i * spanDays * DAY_MS) / count), 9_000_000 + i * 1000),
  );
}

describe('buildValueSeries (A1 / DD-41-01)', () => {
  it('keeps 40 readings at reading grain, one point each, identity by own index', () => {
    const readings = spread(40, 120);
    const series = buildValueSeries(readings);
    expect(series.grain).toBe('reading');
    expect(series.points).toHaveLength(40);
    series.points.forEach((point, i) => {
      expect(point.memberIndexes).toEqual([i]);
      expect(point.kind).toBe('reading');
      expect(point.n).toBe(1);
      expect(point.value).toBe(readings[i]!.value);
    });
    expect(series.boundReached).toBe(true);
  });

  it('bins 200 readings over 18 months to the first ladder grain within 60 points', () => {
    const readings = spread(200, 18 * 30);
    const series = buildValueSeries(readings);
    expect(series.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
    expect(series.grain).not.toBe('reading');
    expect(series.boundReached).toBe(true);

    const seen = series.points.flatMap((point) => point.memberIndexes);
    expect([...seen].sort((a, b) => a - b)).toEqual(readings.map((_, i) => i));
    for (const point of series.points) {
      expect(point.n).toBe(point.memberIndexes.length);
      expect(point.kind).toBe('close');
      const last = point.memberIndexes[point.memberIndexes.length - 1]!;
      expect(point.value).toBe(readings[last]!.value);
      expect(point.xMs).toBe(readings[last]!.atMs);
    }
  });

  it('is the FINEST grain that fits: the next-finer grain would have exceeded the target', () => {
    const readings = spread(200, 18 * 30);
    const series = buildValueSeries(readings);
    const finer = { day: 'reading', week: 'day', month: 'week', quarter: 'month' } as const;
    if (series.grain === 'reading') throw new Error('expected a binned grain');
    // An unbounded target returns the next-finer grain's own points: there must be too many.
    const tooFine = buildValueSeries(readings, {
      minGrain: finer[series.grain],
      target: Number.POSITIVE_INFINITY,
    });
    expect(tooFine.grain).toBe(finer[series.grain]);
    expect(tooFine.points.length).toBeGreaterThan(MARK_BOUND_LINE_POINTS);
  });

  it('flags a bucket containing a calibration reading, and a lone one at reading grain', () => {
    const readings = [
      reading(START_MS, 5_000_000),
      reading(START_MS + DAY_MS, 6_000_000, true),
      reading(START_MS + 2 * DAY_MS, 6_100_000),
    ];
    const fine = buildValueSeries(readings);
    expect(fine.points.map((p) => p.kind)).toEqual(['reading', 'calibration', 'reading']);
    expect(fine.points.map((p) => p.containsCalibration)).toEqual([false, true, false]);

    const month = buildValueSeries(readings, { minGrain: 'month' });
    expect(month.grain).toBe('month');
    expect(month.points).toHaveLength(1);
    expect(month.points[0]!.containsCalibration).toBe(true);
    expect(month.points[0]!.kind).toBe('close');
    expect(month.points[0]!.value).toBe(6_100_000);
  });

  it('forces a coarser grain with minGrain', () => {
    const series = buildValueSeries(spread(10, 10), { minGrain: 'week' });
    expect(['week', 'month', 'quarter']).toContain(series.grain);
  });

  it('takes the close by time, with ties on the later input index, regardless of input order', () => {
    const readings = [
      reading(START_MS + 5_000, 3),
      reading(START_MS + 1_000, 1),
      reading(START_MS + 5_000, 4),
    ];
    const series = buildValueSeries(readings, { minGrain: 'day' });
    expect(series.points).toHaveLength(1);
    expect(series.points[0]!.value).toBe(4);
    expect(series.points[0]!.memberIndexes).toEqual([1, 0, 2]);
  });

  it('skips a non-finite reading without breaking the series (T-41-05)', () => {
    const readings = [
      reading(START_MS, 1),
      reading(START_MS + DAY_MS, Number.NaN),
      reading(NaN, 2),
    ];
    const series = buildValueSeries(readings);
    expect(series.points).toHaveLength(1);
    expect(series.points[0]!.memberIndexes).toEqual([0]);
  });

  it('returns an empty series at the finest grain over no readings', () => {
    const series = buildValueSeries([]);
    expect(series).toEqual({ grain: 'reading', points: [], boundReached: true });
    expect(buildValueSeries([], { minGrain: 'month' }).grain).toBe('month');
  });

  it('cuts to the newest target points only when even quarter overflows', () => {
    const readings = Array.from({ length: 12 }, (_, i) =>
      reading(Date.UTC(2020 + Math.floor(i / 4), (i % 4) * 3, 5), i),
    );
    const series = buildValueSeries(readings, { target: 5 });
    expect(series.grain).toBe('quarter');
    expect(series.boundReached).toBe(false);
    expect(series.points).toHaveLength(5);
    expect(series.points[4]!.value).toBe(11);
  });

  it('is pure: the same input twice is deep-equal and the input is not mutated', () => {
    const readings = spread(200, 18 * 30).reverse();
    const snapshot = JSON.parse(JSON.stringify(readings)) as ValueSeriesReading[];
    const first = buildValueSeries(readings);
    const second = buildValueSeries(readings);
    expect(second).toEqual(first);
    expect(readings).toEqual(snapshot);
  });
});
