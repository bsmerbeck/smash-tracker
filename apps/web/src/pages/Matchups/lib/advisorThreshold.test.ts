import { describe, expect, it } from 'vitest';
import { advisorThreshold } from './advisorThreshold';

/**
 * D-13 layer 1 (plan 37-05): sub-floor inputs are unreachable through the
 * real picker (`isValidMinStageMatches` admits only 3/5/10), which is
 * exactly why this function must be tested directly rather than only through
 * a rendered component.
 */
describe('advisorThreshold', () => {
  it('raises a sub-floor input to the floor', () => {
    expect(advisorThreshold(1)).toBe(3);
    expect(advisorThreshold(2)).toBe(3);
  });

  it('returns an at-or-above-floor input unchanged', () => {
    expect(advisorThreshold(5)).toBe(5);
    expect(advisorThreshold(7)).toBe(7);
  });

  it('defaults to the floor when no input is given', () => {
    expect(advisorThreshold(undefined)).toBe(3);
  });
});
