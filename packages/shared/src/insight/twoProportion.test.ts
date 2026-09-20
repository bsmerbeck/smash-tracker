import { describe, expect, it } from 'vitest';
import { twoProportionZ, isNotableCohortGap } from './twoProportion.js';
import { COHORT_MIN_SIDE_GAMES } from './policy.js';

describe('twoProportionZ', () => {
  it('matches a hand-computed pair: 60/100 vs 40/100 -> z = sqrt(8)', () => {
    // pooled = 100/200 = 0.5; SE = sqrt(0.5*0.5*(1/100+1/100)) = sqrt(0.005);
    // z = 0.2 / sqrt(0.005) = sqrt(0.04/0.005) = sqrt(8).
    const z = twoProportionZ(60, 100, 40, 100);
    expect(z).toBeCloseTo(Math.sqrt(8), 9);
  });

  it('is 0 when either total is 0', () => {
    expect(twoProportionZ(0, 0, 5, 10)).toBe(0);
    expect(twoProportionZ(5, 10, 0, 0)).toBe(0);
  });
});

describe('isNotableCohortGap', () => {
  it('is false when either side is one game below COHORT_MIN_SIDE_GAMES, even with a huge gap', () => {
    const belowFloor = COHORT_MIN_SIDE_GAMES - 1;
    expect(
      isNotableCohortGap({ wins: belowFloor, total: belowFloor }, { wins: 0, total: belowFloor }),
    ).toBe(false);
    expect(
      isNotableCohortGap({ wins: 0, total: belowFloor }, { wins: belowFloor, total: belowFloor }),
    ).toBe(false);
  });

  it('is true at exactly COHORT_MIN_SIDE_GAMES on both sides for a clearly separated pair', () => {
    expect(
      isNotableCohortGap(
        { wins: COHORT_MIN_SIDE_GAMES, total: COHORT_MIN_SIDE_GAMES },
        { wins: 0, total: COHORT_MIN_SIDE_GAMES },
      ),
    ).toBe(true);
  });
});
