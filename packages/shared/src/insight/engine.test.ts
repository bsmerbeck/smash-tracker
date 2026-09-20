import { describe, expect, it } from 'vitest';
import { computeInsights } from './engine.js';
import { ACCOUNT_SCOPE } from './types.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';

const NOW_MS = 1_700_100_000_000;

describe('computeInsights (Task 1 tracer)', () => {
  it('returns [] over zero matches and does not throw', () => {
    expect(() =>
      computeInsights({
        matches: emptyWorkspace(),
        scopes: [ACCOUNT_SCOPE],
        horizon: 'last30',
        nowMs: NOW_MS,
      }),
    ).not.toThrow();

    const result = computeInsights({
      matches: emptyWorkspace(),
      scopes: [ACCOUNT_SCOPE],
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('returns one locked Insight over one game', () => {
    const result = computeInsights({
      matches: oneGameWorkspace(),
      scopes: [ACCOUNT_SCOPE],
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe('locked');
  });

  it('drops a dismissed id from the result', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const first = computeInsights({
      matches,
      scopes: [ACCOUNT_SCOPE],
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(first).toHaveLength(1);
    const dismissed = computeInsights({
      matches,
      scopes: [ACCOUNT_SCOPE],
      horizon: 'last30',
      nowMs: NOW_MS,
      dismissedIds: [first[0]!.id],
    });
    expect(dismissed).toEqual([]);
  });
});
