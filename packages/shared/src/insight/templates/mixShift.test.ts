import { describe, expect, it } from 'vitest';
import { mixShiftTemplate } from './mixShift.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match, MatchType } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;

function matchesOfType(count: number, matchType: MatchType, startIndex: number): Match[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${matchType}-${startIndex + i}`,
    fighter_id: 8,
    opponent_id: 23,
    time: BASE_TIME_MS + (startIndex + i) * 60_000,
    win: i % 2 === 0,
    matchType,
  }));
}

function buildInsight(matches: Match[]) {
  const result = mixShiftTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('mixShiftTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'mixShift');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(mixShiftTemplate);
  });

  it('is hidden when the recent window is below the medium tier (< 8 games)', () => {
    // Only 5 games total -> recent window (last30) is 5 games, below the
    // medium confidence tier.
    const matches = matchesOfType(5, 'offline-tourney', 0);
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('hidden');
  });

  it('is hidden one point below MIX_SHIFT_MIN_POINTS even with n >= 8', () => {
    // Lifetime: 50 online-tourney, 50 offline-tourney (50/50 split).
    // Recent 30 (last30): 16 online, 14 offline -> recent onlineShare
    // 53.3%, a ~3.3pt shift, comfortably under any real MIX_SHIFT_MIN_POINTS
    // floor.
    const lifetimeOlder = [
      ...matchesOfType(35, 'online-tourney', 0),
      ...matchesOfType(35, 'offline-tourney', 1000),
    ];
    const recent = [
      ...matchesOfType(16, 'online-tourney', 2000),
      ...matchesOfType(14, 'offline-tourney', 3000),
    ];
    const matches = [...lifetimeOlder, ...recent];
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('hidden');
    expect(insight.deltaPoints).toBeNull();
  });

  it('asserts a Fact when the recent window is all one match type and lifetime is mixed', () => {
    const lifetimeOlder = [
      ...matchesOfType(30, 'online-tourney', 0),
      ...matchesOfType(30, 'offline-tourney', 1000),
    ];
    const recent = matchesOfType(30, 'offline-tourney', 2000);
    const matches = [...lifetimeOlder, ...recent];
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('fact');
    expect(insight.deltaPoints).toBeNull();
    expect(insight.copy.values.matchType).toBe('offline-tourney');
  });

  it('deltaPoints is always null (a direction-free Fact)', () => {
    const hidden = buildInsight(matchesOfType(5, 'offline-tourney', 0))!;
    expect(hidden.deltaPoints).toBeNull();
    const asserting = buildInsight([
      ...matchesOfType(30, 'online-tourney', 0),
      ...matchesOfType(30, 'offline-tourney', 1000),
      ...matchesOfType(30, 'offline-tourney', 2000),
    ])!;
    expect(asserting.deltaPoints).toBeNull();
  });

  it('windowExpressible is true — the recent window is contiguous', () => {
    expect(mixShiftTemplate.windowExpressible).toBe(true);
  });

  it('assertsDirection is false — MixShift is a direction-free FACT', () => {
    expect(mixShiftTemplate.assertsDirection).toBe(false);
  });
});
