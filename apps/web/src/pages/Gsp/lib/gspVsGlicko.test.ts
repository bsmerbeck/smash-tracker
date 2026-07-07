import { describe, expect, it } from 'vitest';
import type { GspPoint } from '@smash-tracker/shared';
import type { RatingPeriodResult } from '@/lib/glicko';
import { buildGspVsGlickoData, minMaxNormalize } from './gspVsGlicko';

describe('minMaxNormalize', () => {
  it('returns an empty array for empty input', () => {
    expect(minMaxNormalize([])).toEqual([]);
  });

  it('maps min to 0 and max to 100', () => {
    const result = minMaxNormalize([1000, 2000, 3000]);
    expect(result[0]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(100);
    expect(result[1]).toBeCloseTo(50);
  });

  it('returns a flat 50 line when every value is identical (zero range)', () => {
    expect(minMaxNormalize([500, 500, 500])).toEqual([50, 50, 50]);
  });

  it('handles a single value as a flat 50', () => {
    expect(minMaxNormalize([42])).toEqual([50]);
  });
});

describe('buildGspVsGlickoData', () => {
  function ratingPeriod(overrides: Partial<RatingPeriodResult>): RatingPeriodResult {
    return { start: 0, end: 0, games: 1, rating: 1500, rd: 100, volatility: 0.06, ...overrides };
  }

  it('normalizes both series independently and pairs each with its own time value', () => {
    const gspSeries: GspPoint[] = [
      { time: 10, gsp: 1_000_000, win: true },
      { time: 20, gsp: 2_000_000, win: true },
    ];
    const ratingPeriods: RatingPeriodResult[] = [
      ratingPeriod({ end: 15, rating: 1400 }),
      ratingPeriod({ end: 25, rating: 1600 }),
    ];

    const data = buildGspVsGlickoData(gspSeries, ratingPeriods);

    expect(data.gsp).toEqual([
      { time: 10, value: 0 },
      { time: 20, value: 100 },
    ]);
    expect(data.glicko).toEqual([
      { time: 15, value: 0 },
      { time: 25, value: 100 },
    ]);
  });

  it('returns empty arrays for empty input series', () => {
    const data = buildGspVsGlickoData([], []);
    expect(data.gsp).toEqual([]);
    expect(data.glicko).toEqual([]);
  });
});
