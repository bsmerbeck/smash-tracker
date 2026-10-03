import { describe, expect, it } from 'vitest';
import { tierGapTemplate } from './tierGap.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { INSIGHT_TEMPLATES } from './registry.js';
import { COHORT_MIN_SIDE_GAMES } from '../policy.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { InsightScope, InsightTierCohorts } from '../types.js';
import type { Match } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;

/** `count` games, the first `wins` of them won; ids are prefixed so cohorts never collide. */
function games(prefix: string, count: number, wins: number, startIndex = 0): Match[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    fighter_id: 8,
    opponent_id: 23,
    time: BASE_TIME_MS + (startIndex + i) * 60_000,
    win: i < wins,
    matchType: 'offline-tourney',
  }));
}

function tierScope(
  cohorts: Partial<InsightTierCohorts> & { a: Match[]; b: Match[] },
  key = 'tier:side-excluded',
  extraMatches: Match[] = [],
): { scope: InsightScope; matches: Match[] } {
  const matches = [...cohorts.a, ...cohorts.b, ...extraMatches];
  const ids = new Set([...cohorts.a, ...cohorts.b].map((m) => m.id));
  return {
    matches,
    scope: {
      kind: 'account',
      key,
      axes: {},
      filter: (all) => all.filter((m) => ids.has(m.id)),
      tierCohorts: {
        aEvents: cohorts.a.length > 0 ? 1 : 0,
        bEvents: cohorts.b.length > 0 ? 1 : 0,
        estimatedEvents: 0,
        knownEvents: cohorts.a.length + cohorts.b.length > 0 ? 2 : 0,
        ...cohorts,
      },
    },
  };
}

function build(scope: InsightScope, matches: Match[]) {
  const result = tierGapTemplate.build({ matches, scope, horizon: 'last30', nowMs: NOW_MS });
  return result.length > 0 ? result[0]! : null;
}

describe('tierGapTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES and in the composed registry (19 templates)', () => {
    expect(COHORT_TEMPLATES.filter((t) => t.id === 'tierGap')).toEqual([tierGapTemplate]);
    expect(INSIGHT_TEMPLATES.filter((t) => t.id === 'tierGap')).toHaveLength(1);
    expect(INSIGHT_TEMPLATES).toHaveLength(19);
  });

  it('declares its DD-11 metadata: account scope, asserts a direction, not window-expressible', () => {
    expect(tierGapTemplate.scopeKind).toBe('account');
    expect(tierGapTemplate.assertsDirection).toBe(true);
    expect(tierGapTemplate.windowExpressible).toBe(false);
  });

  it('returns nothing when the scope carries no tier cohorts, so no other page renders it', () => {
    const matches = games('any', 40, 20);
    expect(
      tierGapTemplate.build({ matches, scope: ACCOUNT_SCOPE, horizon: 'last30', nowMs: NOW_MS }),
    ).toEqual([]);
  });

  it('both cohorts clear the floor and the gap is notable: an up Trend (A higher) with the points gap', () => {
    const { scope, matches } = tierScope({ a: games('a', 40, 32), b: games('b', 40, 12, 100) });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('trend');
    expect(insight.kind).toBe('inference');
    expect(insight.copy.key).toBe('insights.tierGap.up');
    expect(insight.deltaPoints).toBe(50);
    expect(insight.copy.values.points).toBe(50);
    expect(insight.copy.values.aRate).toBe('80%');
    expect(insight.copy.values.bRate).toBe('30%');
    expect(insight.copy.values.aRecord).toBe('32–8');
    expect(insight.copy.values.bGames).toBe(40);
  });

  it('a notable gap the other way is a down Trend', () => {
    const { scope, matches } = tierScope({ a: games('a', 40, 12), b: games('b', 40, 32, 100) });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('trend');
    expect(insight.copy.key).toBe('insights.tierGap.down');
    expect(insight.deltaPoints).toBe(-50);
    expect(insight.copy.values.points).toBe(50);
  });

  it('both cohorts clear the floor but the gap is not notable: a steady Fact with a null delta', () => {
    const { scope, matches } = tierScope({ a: games('a', 40, 21), b: games('b', 40, 20, 100) });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('steady');
    expect(insight.kind).toBe('fact');
    expect(insight.copy.key).toBe('insights.tierGap.steady');
    expect(insight.deltaPoints).toBeNull();
  });

  it('cohort A at 5 games abstains as a non-assertive Fact naming its count, with a null delta', () => {
    const { scope, matches } = tierScope({ a: games('a', 5, 5), b: games('b', 40, 5, 100) });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('locked');
    expect(insight.kind).toBe('fact');
    expect(insight.copy.key).toBe('insights.tierGap.abstained');
    expect(insight.copy.values.count).toBe(5);
    expect(insight.gamesNeeded).toBe(COHORT_MIN_SIDE_GAMES - 5);
    expect(insight.deltaPoints).toBeNull();
  });

  it('cohort B at 3 games with A cleared abstains with the smaller-events variant', () => {
    const { scope, matches } = tierScope({ a: games('a', 40, 30), b: games('b', 3, 0, 100) });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('locked');
    expect(insight.copy.key).toBe('insights.tierGap.abstainedSmaller');
    expect(insight.copy.values.count).toBe(3);
    expect(insight.deltaPoints).toBeNull();
  });

  it('no known tier at all is the noTiers thin Fact: no counted games, no assertion, a null delta', () => {
    const { scope, matches } = tierScope({ a: [], b: [] });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('thin');
    expect(insight.kind).toBe('fact');
    expect(insight.copy.key).toBe('insights.tierGap.noTiers');
    expect(insight.countedMatchIds).toEqual([]);
    expect(insight.window.games).toBe(0);
    expect(insight.deltaPoints).toBeNull();
  });

  it('known events with no linked games abstain (A = 0) rather than claim no event has a tier', () => {
    const { scope, matches } = tierScope({ a: [], b: [], knownEvents: 3 });
    const insight = build(scope, matches)!;
    expect(insight.state).toBe('locked');
    expect(insight.copy.key).toBe('insights.tierGap.abstained');
    expect(insight.copy.values.count).toBe(0);
  });

  it('sets every param on every state (the copy-param lesson), with the fixed A-then-B key order', () => {
    const expectedOrder = [
      'aRate',
      'aRecord',
      'aGames',
      'bRate',
      'bRecord',
      'bGames',
      'count',
      'points',
      'estimatedEvents',
    ];
    const fixtures = [
      tierScope({ a: games('a', 40, 32), b: games('b', 40, 12, 100) }),
      tierScope({ a: games('a', 40, 21), b: games('b', 40, 20, 100) }),
      tierScope({ a: games('a', 5, 5), b: games('b', 40, 5, 100) }),
      tierScope({ a: games('a', 40, 30), b: games('b', 3, 0, 100) }),
      tierScope({ a: [], b: [] }),
    ];
    const states = new Set<string>();
    for (const { scope, matches } of fixtures) {
      const insight = build(scope, matches)!;
      states.add(insight.state);
      expect(Object.keys(insight.copy.values)).toEqual(expectedOrder);
      for (const value of Object.values(insight.copy.values)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(40);
        }
      }
    }
    expect(states).toEqual(new Set(['trend', 'steady', 'locked', 'thin']));
  });

  it('countedMatchIds is exactly cohort A union cohort B, newest first and duplicate-free', () => {
    const a = games('a', 10, 8);
    const b = games('b', 12, 4, 500);
    const { scope, matches } = tierScope({ a, b });
    const insight = build(scope, matches)!;
    expect(new Set(insight.countedMatchIds)).toEqual(new Set([...a, ...b].map((m) => m.id)));
    expect(insight.countedMatchIds).toHaveLength(22);
    expect(insight.window.games).toBe(22);
    const times = insight.countedMatchIds.map((id) => matches.find((m) => m.id === id)!.time);
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('a game outside both cohorts (an Unknown-tier or side-event game) is never counted', () => {
    const unknown = games('unknown', 30, 30, 900);
    const { scope, matches } = tierScope(
      { a: games('a', 10, 8), b: games('b', 12, 4, 500) },
      'tier:side-excluded',
      unknown,
    );
    const insight = build(scope, matches)!;
    expect(insight.countedMatchIds.some((id) => id.startsWith('unknown-'))).toBe(false);
    expect(insight.window.games).toBe(22);
  });

  it('never leaks an id the scope filter does not admit, even if a cohort lists it', () => {
    const a = games('a', 10, 8);
    const b = games('b', 12, 4, 500);
    const { scope, matches } = tierScope({ a, b });
    const narrowed: InsightScope = {
      ...scope,
      filter: (all) => all.filter((m) => m.id !== 'a-0'),
    };
    const insight = build(narrowed, matches)!;
    expect(insight.countedMatchIds).not.toContain('a-0');
    expect(insight.window.games).toBe(21);
  });

  it('the scope key names the side flag, so a side=include claim id differs from the excluded one', () => {
    const cohorts = { a: games('a', 10, 8), b: games('b', 12, 4, 500) };
    const excluded = build(tierScope(cohorts, 'tier:side-excluded').scope, [
      ...cohorts.a,
      ...cohorts.b,
    ])!;
    const included = build(tierScope(cohorts, 'tier:side-included').scope, [
      ...cohorts.a,
      ...cohorts.b,
    ])!;
    expect(excluded.id).toBe('tierGap:tier:side-excluded:last30');
    expect(included.id).toBe('tierGap:tier:side-included:last30');
    expect(excluded.id).not.toBe(included.id);
  });

  it('carries the estimated-event count through to the copy values', () => {
    const { scope, matches } = tierScope({
      a: games('a', 10, 8),
      b: games('b', 12, 4, 500),
      estimatedEvents: 4,
    });
    expect(build(scope, matches)!.copy.values.estimatedEvents).toBe(4);
  });

  it('emits no counted-games door of its own (the web builds it from countedMatchIds)', () => {
    const { scope, matches } = tierScope({ a: games('a', 40, 32), b: games('b', 40, 12, 100) });
    expect(build(scope, matches)!.doors).toEqual([]);
  });
});
