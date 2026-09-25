import { describe, expect, it } from 'vitest';
import { wilsonInterval } from './wilsonInterval.js';
import { wilsonLowerBound } from '../evidence/rank.js';

describe('wilsonInterval', () => {
  it('is { lower: 0, upper: 1 } for an empty sample', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it('matches wilsonLowerBound for its lower bound, to within 1e-12, across distinct known (w, t) pairs', () => {
    const pairs: Array<[number, number]> = [
      [1, 1],
      [12, 15],
      [50, 100],
      [8, 30],
    ];
    for (const [wins, total] of pairs) {
      const interval = wilsonInterval(wins, total);
      const lower = wilsonLowerBound(wins, total);
      expect(Math.abs(interval.lower - lower)).toBeLessThan(1e-12);
    }
  });

  it('is symmetric around the Wilson centre (before clamping) for a mid-range rate', () => {
    // p = 0.5, n = 100 keeps both bounds well inside [0, 1], so clamping never masks asymmetry.
    // The interval is symmetric around centre/denominator (Wilson's recentred midpoint), not
    // around the raw rate p — centre = p + z²/2n is itself offset from p.
    const wins = 50;
    const total = 100;
    const z = 1.96;
    const p = wins / total;
    const z2 = z * z;
    const denominator = 1 + z2 / total;
    const centre = p + z2 / (2 * total);
    const midpoint = centre / denominator;
    const { lower, upper } = wilsonInterval(wins, total, z);
    expect(upper - midpoint).toBeCloseTo(midpoint - lower, 9);
  });

  it('narrows as the sample grows for a fixed rate (monotonicity)', () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(50, 100);
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    expect(largeWidth).toBeLessThan(smallWidth);
  });
});
