import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * E3 period boundary (41-UI-SPEC "readings at a period boundary"): `day` buckets follow the HOST-local
 * calendar day, `week` / `month` / `quarter` follow UTC (`calendarBucketBounds`). The zone is pinned
 * before the module loads and restored afterwards (the `periodTicks.timezone.test.ts` pattern).
 */
const originalTz = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  return previous;
});

import { buildValueSeries, type ValueSeriesReading } from './valueSeries.js';

afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

/** 2026-03-01T06:00Z is Feb 28 22:00 in Los Angeles; 09:00Z is Mar 1 01:00 PST. */
const EARLY = Date.UTC(2026, 2, 1, 6);
const LATE = Date.UTC(2026, 2, 1, 9);
const READINGS: ValueSeriesReading[] = [
  { atMs: EARLY, value: 1, calibration: false },
  { atMs: LATE, value: 2, calibration: false },
];

describe('buildValueSeries — time-zone rule', () => {
  it('splits two readings three UTC hours apart across host-local days', () => {
    const series = buildValueSeries(READINGS, { minGrain: 'day' });
    expect(series.grain).toBe('day');
    expect(series.points).toHaveLength(2);
    expect(series.points.map((point) => point.memberIndexes)).toEqual([[0], [1]]);
    expect(series.points[0]!.key).toBe('day:2026-02-28');
    expect(series.points[1]!.key).toBe('day:2026-03-01');
  });

  it('keeps the same two readings in one UTC month at month grain', () => {
    const series = buildValueSeries(READINGS, { minGrain: 'month' });
    expect(series.grain).toBe('month');
    expect(series.points).toHaveLength(1);
    expect(series.points[0]!.key).toBe('month:2026-03');
    expect(series.points[0]!.memberIndexes).toEqual([0, 1]);
  });

  it('a click identity is the member list, never the bucket span: boundary readings stay with the close that counted them', () => {
    const boundary = Date.UTC(2026, 2, 1); // exactly the UTC month boundary
    const series = buildValueSeries(
      [
        { atMs: boundary - 1, value: 1, calibration: false },
        { atMs: boundary, value: 2, calibration: false },
      ],
      { minGrain: 'month' },
    );
    expect(series.points.map((point) => point.memberIndexes)).toEqual([[0], [1]]);
    // The two buckets share the boundary instant but no member.
    expect(series.points[0]!.endMs).toBe(series.points[1]!.startMs);
  });
});
