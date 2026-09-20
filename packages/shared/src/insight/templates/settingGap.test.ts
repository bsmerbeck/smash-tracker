import { describe, expect, it } from 'vitest';
import { settingGapTemplate } from './settingGap.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match, MatchType } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;

function matchesOfType(count: number, matchType: MatchType, wins: number, startIndex = 0): Match[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${matchType}-${startIndex + i}`,
    fighter_id: 8,
    opponent_id: 23,
    time: BASE_TIME_MS + (startIndex + i) * 60_000,
    win: i < wins,
    matchType,
  }));
}

function buildInsight(matches: Match[]) {
  const result = settingGapTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('settingGapTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'settingGap');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(settingGapTemplate);
  });

  it('7 offline games (online >= 8) returns the locked/abstained key naming offline and count 7', () => {
    const matches = [
      ...matchesOfType(20, 'online-tourney', 12, 0),
      ...matchesOfType(7, 'offline-tourney', 3, 100),
    ];
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('locked');
    expect(insight.copy.values.shortSide).toBe('offline');
    expect(insight.copy.values.offlineCount).toBe(7);
    expect(insight.gamesNeeded).toBe(1);
  });

  it('8 games on both sides runs the notability test instead of locking', () => {
    const matches = [
      ...matchesOfType(20, 'online-tourney', 12, 0),
      ...matchesOfType(8, 'offline-tourney', 4, 100),
    ];
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).not.toBe('locked');
    expect(insight.state).not.toBe('thin');
  });

  it('zero offline games in the window returns the thin-window key with no rate for the empty side', () => {
    const matches = matchesOfType(20, 'online-tourney', 12, 0);
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('thin');
    expect(insight.copy.values.offlineRate).toBeUndefined();
    expect(insight.copy.values.onlineRate).toBeDefined();
  });

  it('emits online keys before offline keys in copy.values even when offline is ahead', () => {
    const matches = [
      ...matchesOfType(20, 'online-tourney', 6, 0), // online 30%
      ...matchesOfType(20, 'offline-tourney', 16, 100), // offline 80% — offline is ahead
    ];
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    const keys = Object.keys(insight.copy.values);
    const firstOnlineIndex = keys.findIndex((k) => k.toLowerCase().startsWith('online'));
    const firstOfflineIndex = keys.findIndex((k) => k.toLowerCase().startsWith('offline'));
    expect(firstOnlineIndex).toBeGreaterThanOrEqual(0);
    expect(firstOfflineIndex).toBeGreaterThanOrEqual(0);
    expect(firstOnlineIndex).toBeLessThan(firstOfflineIndex);
  });

  it('windowExpressible is true — a setting cohort is a contiguous scoped window the existing axes express', () => {
    expect(settingGapTemplate.windowExpressible).toBe(true);
  });
});
