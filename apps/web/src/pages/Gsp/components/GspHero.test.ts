import { describe, expect, it } from 'vitest';
import type { GspPoint } from '@smash-tracker/shared';
import { getRecentGspWinRate } from './GspHero';

describe('getRecentGspWinRate', () => {
  it('returns null for an empty series', () => {
    expect(getRecentGspWinRate([])).toBeNull();
  });

  it('computes the win rate over the whole series when shorter than the window', () => {
    const series: GspPoint[] = [
      { time: 1, gsp: 1000, win: true },
      { time: 2, gsp: 1100, win: false },
    ];
    expect(getRecentGspWinRate(series)).toBeCloseTo(0.5);
  });

  it('restricts to the trailing window size', () => {
    const series: GspPoint[] = [
      { time: 1, gsp: 1000, win: false },
      { time: 2, gsp: 1100, win: false },
      { time: 3, gsp: 1200, win: true },
      { time: 4, gsp: 1300, win: true },
    ];
    // window of 2 -> only the last two (both wins) count.
    expect(getRecentGspWinRate(series, 2)).toBeCloseTo(1);
  });

  it('excludes calibration points (win: null) before windowing', () => {
    const series: GspPoint[] = [
      { time: 1, gsp: 1000, win: true },
      { time: 2, gsp: 1500, win: null },
      { time: 3, gsp: 1510, win: false },
    ];
    // One win, one loss — the calibration point is not a game.
    expect(getRecentGspWinRate(series)).toBeCloseTo(0.5);
    // A window of 2 must still see [win, loss], not [null, loss].
    expect(getRecentGspWinRate(series, 2)).toBeCloseTo(0.5);
  });

  it('returns null for a calibration-only series', () => {
    const series: GspPoint[] = [{ time: 1, gsp: 1000, win: null }];
    expect(getRecentGspWinRate(series)).toBeNull();
  });
});
