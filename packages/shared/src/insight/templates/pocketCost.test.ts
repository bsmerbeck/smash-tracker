import { describe, expect, it } from 'vitest';
import { pocketCostTemplate } from './pocketCost.js';
import { ROSTER_MAIN_MIN_GAMES } from './rosterCore.js';
import { ROSTER_TEMPLATES } from './roster.js';
import { INSIGHT_TEMPLATES } from './registry.js';
import { rosterCoreTemplate } from './rosterCore.js';
import { rosterShiftTemplate } from './rosterShift.js';
import { secondaryPayoffTemplate } from './secondaryPayoff.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAIN_ID = 1;

function buildMainMatches(count: number, winRatio: number, idPrefix: string): Match[] {
  const wins = Math.round(count * winRatio);
  return Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${i}`,
    fighter_id: MAIN_ID,
    opponent_id: 23,
    time: NOW_MS - (count - i) * ONE_HOUR_MS,
    win: i < wins,
  }));
}

/** `count` distinct pocket fighters, `gamesEach` games apiece — every one individually well under both secondary floors (games and share). */
function buildPocketMatches(count: number, gamesEach: number, winRatio: number): Match[] {
  const wins = Math.round(gamesEach * winRatio);
  const matches: Match[] = [];
  for (let f = 0; f < count; f += 1) {
    const fighterId = 100 + f;
    for (let i = 0; i < gamesEach; i += 1) {
      matches.push({
        id: `pocket-${f}-${i}`,
        fighter_id: fighterId,
        opponent_id: 23,
        time: NOW_MS - (gamesEach - i) * ONE_HOUR_MS,
        win: i < wins,
      });
    }
  }
  return matches;
}

describe('pocketCostTemplate', () => {
  it('returns state === "hidden" below ROSTER_MAIN_MIN_GAMES pooled pocket games', () => {
    // pockets: 4 fighters, 5+5+5+4 = 19 games total — one below the floor.
    const matches: Match[] = [
      ...buildMainMatches(60, 0.75, 'main'),
      ...buildPocketMatches(3, 5, 0.5),
      ...buildPocketMatches(1, 4, 0.5).map((m, i) => ({ ...m, id: `pocket-extra-${i}` })),
    ];
    const [insight] = pocketCostTemplate.build({
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

  it('returns a non-hidden state at exactly ROSTER_MAIN_MIN_GAMES pooled pocket games', () => {
    expect(ROSTER_MAIN_MIN_GAMES).toBe(20);
    // pockets: 4 fighters, 5 games each = 20 games total — exactly the floor.
    const matches: Match[] = [
      ...buildMainMatches(60, 0.75, 'main'),
      ...buildPocketMatches(4, 5, 0.5),
    ];
    const [insight] = pocketCostTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).not.toBe('hidden');
    expect(['fact', 'steady']).toContain(insight!.state);
    expect(insight!.deltaPoints).toBeNull();
    expect(insight!.doors).toEqual([]);
  });

  it('returns an empty doors array in every state', () => {
    const hiddenCase = pocketCostTemplate.build({
      matches: [...buildMainMatches(60, 0.75, 'main'), ...buildPocketMatches(3, 5, 0.5)],
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    const nonHiddenCase = pocketCostTemplate.build({
      matches: [...buildMainMatches(60, 0.75, 'main'), ...buildPocketMatches(4, 5, 0.5)],
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    for (const [insight] of [hiddenCase, nonHiddenCase]) {
      expect(insight!.doors).toEqual([]);
    }
  });

  it('returns [] when no main is established', () => {
    const matches = buildMainMatches(10, 0.5, 'thin');
    const result = pocketCostTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('declares windowExpressible: false, assertsDirection: false, read from the built segment', () => {
    expect(pocketCostTemplate.windowExpressible).toBe(false);
    expect(pocketCostTemplate.assertsDirection).toBe(false);
  });
});

describe('ROSTER_TEMPLATES closure (Task 2 completes the segment)', () => {
  it('ROSTER_TEMPLATES has exactly 4 members: rosterCore, rosterShift, secondaryPayoff, pocketCost', () => {
    expect(ROSTER_TEMPLATES).toHaveLength(4);
    expect(ROSTER_TEMPLATES.map((t) => t.id)).toEqual([
      'rosterCore',
      'rosterShift',
      'secondaryPayoff',
      'pocketCost',
    ]);
  });

  it('INSIGHT_TEMPLATES (the composed registry) has exactly 17 members', () => {
    expect(INSIGHT_TEMPLATES).toHaveLength(17);
  });

  it('windowExpressible is set correctly across the whole roster segment', () => {
    expect(rosterCoreTemplate.windowExpressible).toBe(true);
    expect(rosterShiftTemplate.windowExpressible).toBe(true);
    expect(secondaryPayoffTemplate.windowExpressible).toBe(false);
    expect(pocketCostTemplate.windowExpressible).toBe(false);
  });
});
