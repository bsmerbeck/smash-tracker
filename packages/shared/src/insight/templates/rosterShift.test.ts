import { describe, expect, it } from 'vitest';
import { rosterShiftTemplate } from './rosterShift.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const X_ID = 1;
const OTHER_ID = 2;

/**
 * Builds a two-fighter (`X_ID`/`OTHER_ID`) timeline: `oldTotal` chronologically
 * OLDER games followed by `recentTotal` chronologically NEWER games, so
 * `resolveWindow`'s `last30` horizon returns exactly the newer block when
 * `recentTotal === 30`. `oldXCount`/`recentXCount` control fighter X's game
 * count in each block — everything else in each block goes to `OTHER_ID`.
 */
function buildRosterShiftFixture(params: {
  oldXCount: number;
  recentXCount: number;
  oldTotal?: number;
  recentTotal?: number;
}): Match[] {
  const { oldXCount, recentXCount, oldTotal = 270, recentTotal = 30 } = params;
  const matches: Match[] = [];
  for (let i = 0; i < oldTotal; i += 1) {
    const fighterId = i < oldXCount ? X_ID : OTHER_ID;
    matches.push({
      id: `old-${i}`,
      fighter_id: fighterId,
      opponent_id: 23,
      time: NOW_MS - (oldTotal + recentTotal - i) * ONE_HOUR_MS,
      win: true,
    });
  }
  for (let i = 0; i < recentTotal; i += 1) {
    const fighterId = i < recentXCount ? X_ID : OTHER_ID;
    matches.push({
      id: `recent-${i}`,
      fighter_id: fighterId,
      opponent_id: 23,
      time: NOW_MS - (recentTotal - i) * ONE_HOUR_MS,
      win: true,
    });
  }
  return matches;
}

describe('rosterShiftTemplate', () => {
  it('returns state === "hidden" on a fixture whose horizons collapse', () => {
    // total = 10 games, all inside the last30 window (< 30 games total) —
    // recent === baseline exactly, so the D-06 collapse ratio always fires.
    const matches = buildRosterShiftFixture({
      oldXCount: 0,
      recentXCount: 5,
      oldTotal: 0,
      recentTotal: 10,
    });
    const [insight] = rosterShiftTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('hidden');
    expect(insight!.deltaPoints).toBeNull();
    expect(insight!.doors).toEqual([]);
  });

  it('asserts a shift at exactly ROSTER_SHIFT_MIN_POINTS (15)', () => {
    // baseline (300 games): X has 55 (18.33%). recent (last 30): X has 10
    // (33.33%). Shift = 33.33 - 18.33 = +15.0 exactly.
    const matches = buildRosterShiftFixture({ oldXCount: 45, recentXCount: 10 });
    const [insight] = rosterShiftTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('trend');
    expect(insight!.kind).toBe('inference');
    expect(insight!.deltaPoints).toBe(15);
    expect(insight!.doors).toHaveLength(1);
    expect(insight!.doors[0]!.kind).toBe('games');
  });

  it('resolves copy.values.fighter to the localizable fighter name, never the raw id (Rule 1 fix, T-39.1-16)', () => {
    // X_ID (1) is Mario in the real fighter data — the locale string
    // `insights.rosterShift.up` interpolates `{{fighter}}` expecting a name,
    // not the numeric id the template used to supply.
    const matches = buildRosterShiftFixture({ oldXCount: 45, recentXCount: 10 });
    const [insight] = rosterShiftTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight!.copy.values.fighter).toBe('Mario');
  });

  it('does not assert one point below the threshold (14)', () => {
    // baseline (300 games): X has 58 (19.33%). recent: X has 10 (33.33%).
    // Shift = 33.33 - 19.33 = +14.0 exactly — below the 15-point floor.
    const matches = buildRosterShiftFixture({ oldXCount: 48, recentXCount: 10 });
    const [insight] = rosterShiftTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('steady');
    expect(insight!.deltaPoints).toBeNull();
  });

  it('returns [] for a non-account scope', () => {
    const matches = buildRosterShiftFixture({ oldXCount: 45, recentXCount: 10 });
    const result = rosterShiftTemplate.build({
      matches,
      scope: {
        kind: 'character',
        key: 'character:1',
        axes: { fighter: 1 },
        filter: (ms) => ms.filter((m) => m.fighter_id === 1),
      },
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('returns [] for zero games in scope', () => {
    const result = rosterShiftTemplate.build({
      matches: [],
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('declares windowExpressible: true, read from the built segment', () => {
    expect(rosterShiftTemplate.windowExpressible).toBe(true);
    expect(rosterShiftTemplate.assertsDirection).toBe(true);
  });
});
