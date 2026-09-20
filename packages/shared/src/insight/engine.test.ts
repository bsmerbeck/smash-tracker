import { describe, expect, it } from 'vitest';
import { computeInsights } from './engine.js';
import { ACCOUNT_SCOPE } from './types.js';
import type { Match } from '../match.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';

const NOW_MS = 1_700_100_000_000;

/**
 * FIXT-02: the base 8k fixture at its plain, constant `winRate` (0.55) does
 * NOT produce a trend by itself — the recent-30 vs. baseline-8000 sample
 * happens to land within the recent window's own Wilson interval for this
 * seed (verified by hand at authoring time). To make the non-vacuity
 * assertion below genuinely non-vacuous (never passing because the engine
 * simply returned nothing), a deliberately-skewed 30-game tail (winRate
 * 0.95) is appended after the base fixture's last timestamp, so the
 * `last30` window is dominated by the skewed tail while the 8030-game
 * baseline stays close to the base fixture's own rate — a robust,
 * deterministic trend (both seeds are fixed literals; two calls with the
 * same options always produce the same `Match[]`, per `syntheticMatches.ts`).
 */
function buildShiftedFormFixture(): Match[] {
  const base = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
  const lastTime = Math.max(...base.map((m) => m.time));
  const bump = generateSyntheticMatches({
    seed: 424_242,
    count: 30,
    startMs: lastTime + 4 * 60 * 60 * 1000,
    winRate: 0.95,
    sessionGapMs: 60 * 1000,
    sessionSizeRange: [30, 30],
  });
  return [...base, ...bump];
}

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

describe('FIXT-02 conformance: no insight asserts a direction on any thin fixture (INS-04)', () => {
  const thinFixtures: Array<[string, () => Match[]]> = [
    ['emptyWorkspace', emptyWorkspace],
    ['oneGameWorkspace', oneGameWorkspace],
    ['twoGameWorkspace', twoGameWorkspace],
    ['unknownStageOnlyWorkspace', unknownStageOnlyWorkspace],
    ['unknownCharacterOnlyWorkspace', unknownCharacterOnlyWorkspace],
  ];

  it.each(thinFixtures)(
    '%s: no trend/suggestion state and no non-null deltaPoints',
    (_name, build) => {
      const results = computeInsights({
        matches: build(),
        scopes: [ACCOUNT_SCOPE],
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      for (const insight of results) {
        expect(insight.state).not.toBe('trend');
        expect(insight.state).not.toBe('suggestion');
        expect(insight.deltaPoints).toBeNull();
      }
    },
  );

  it('a deliberately thin ~40-game fixture asserts no direction either', () => {
    const matches = generateSyntheticMatches({ seed: 40, count: 40 });
    const results = computeInsights({
      matches,
      scopes: [ACCOUNT_SCOPE],
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    for (const insight of results) {
      expect(insight.state).not.toBe('trend');
      expect(insight.state).not.toBe('suggestion');
      expect(insight.deltaPoints).toBeNull();
    }
  });

  it('non-vacuity companion: the identical assertion over a robustly-shifted 8k-shaped fixture finds at least one non-null deltaPoints', () => {
    const matches = buildShiftedFormFixture();
    const results = computeInsights({
      matches,
      scopes: [ACCOUNT_SCOPE],
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(results.some((insight) => insight.deltaPoints !== null)).toBe(true);
  });
});
