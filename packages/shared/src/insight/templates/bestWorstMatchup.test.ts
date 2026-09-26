import { describe, expect, it } from 'vitest';
import {
  bestMatchupTemplate,
  buildMatchupBackfillInsights,
  worstMatchupTemplate,
} from './bestWorstMatchup.js';
import { getFighterById } from '../../fighterData.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { InsightScope } from '../types.js';
import type { Match } from '../../match.js';

const SUBJECT_FIGHTER_ID = 8;
const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function subjectScope(): InsightScope {
  return {
    kind: 'character',
    key: `character:${SUBJECT_FIGHTER_ID}`,
    axes: { fighter: SUBJECT_FIGHTER_ID },
    filter: (matches) => matches.filter((m) => m.fighter_id === SUBJECT_FIGHTER_ID),
  };
}

function buildMatchupBlock(
  opponentFighterId: number,
  wins: number,
  losses: number,
  idPrefix: string,
): Match[] {
  const matches: Match[] = [];
  const total = wins + losses;
  for (let i = 0; i < total; i += 1) {
    matches.push({
      id: `${idPrefix}-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: opponentFighterId,
      time: NOW_MS - (total - i) * ONE_HOUR_MS,
      win: i < wins,
      matchType: 'offline-tourney',
    });
  }
  return matches;
}

describe('bestMatchupTemplate / worstMatchupTemplate (Task 3: direction-free back-fill facts)', () => {
  it('declares windowExpressible: true and assertsDirection: false on both templates', () => {
    expect(bestMatchupTemplate.windowExpressible).toBe(true);
    expect(bestMatchupTemplate.assertsDirection).toBe(false);
    expect(worstMatchupTemplate.windowExpressible).toBe(true);
    expect(worstMatchupTemplate.assertsDirection).toBe(false);
  });

  it('picks the 41-6 matchup over a lucky 5-0, ranking by Wilson lower bound not raw rate', () => {
    const matches = [
      ...buildMatchupBlock(2, 5, 0, 'lucky'),
      ...buildMatchupBlock(3, 41, 6, 'proven'),
    ];
    const insights = bestMatchupTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    // Review finding CR-A03: this test used to lock in the raw numeric fighter
    // id (`toBe(3)`) as the correct behaviour — `copy.values.vs` must instead
    // be the resolved, human-readable fighter NAME (mirrors every other
    // template's `fighterNameFor` treatment), never a bare id.
    expect(insights[0]!.copy.values.vs).toBe(getFighterById(3)!.name);
    expect(typeof insights[0]!.copy.values.vs).toBe('string');
    expect(insights[0]!.copy.values.record).toBe('41–6');
  });

  it.each([
    ['empty', []],
    ['below floor', buildMatchupBlock(2, 1, 0, 'floor1')],
    ['5-0 lucky', buildMatchupBlock(2, 5, 0, 'lucky2')],
    ['41-6 proven', buildMatchupBlock(3, 41, 6, 'proven2')],
  ] as const)('deltaPoints is always null (%s fixture)', (_label, matches) => {
    for (const template of [bestMatchupTemplate, worstMatchupTemplate]) {
      const insights = template.build({
        matches: matches as Match[],
        scope: subjectScope(),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      for (const insight of insights) {
        expect(insight.deltaPoints).toBeNull();
      }
    }
  });

  it('with every matchup below the abstention floor, both templates return locked with a positive gamesNeeded', () => {
    const matches = [...buildMatchupBlock(2, 1, 0, 'low1'), ...buildMatchupBlock(3, 0, 1, 'low2')];
    for (const template of [bestMatchupTemplate, worstMatchupTemplate]) {
      const insights = template.build({
        matches,
        scope: subjectScope(),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      expect(insights).toHaveLength(1);
      expect(insights[0]!.state).toBe('locked');
      expect(insights[0]!.gamesNeeded).toBeGreaterThan(0);
    }
  });

  it('worstMatchup picks the 38-41 record over a lucky 0-2, ranking by the losses-side Wilson lower bound', () => {
    // Plan 39.1-40: a third, clearly better eligible matchup (30-2). Without it
    // the 38-41 opponent is the ONLY eligible matchup, so it is also the best
    // record, and the engine's same-opponent suppression (a Best and a
    // Toughest card never name the same opponent) would build no toughest
    // read. The intent is unchanged: a sub-floor 0-2 never outranks a proven
    // 38-41.
    const matches = [
      ...buildMatchupBlock(4, 0, 2, 'unlucky'),
      ...buildMatchupBlock(5, 38, 41, 'toughmatchup'),
      ...buildMatchupBlock(6, 30, 2, 'bestmatchup'),
    ];
    const insights = worstMatchupTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.copy.values.vs).toBe(getFighterById(5)!.name);
  });
});

/**
 * Plan 39.1-40 (D-14, INS-01): the scope-agnostic back-fill core. Account
 * scope is the Trends rail's; the two templates keep their character guard.
 */
describe('buildMatchupBackfillInsights (39.1-40: account-scope core, same-opponent suppression)', () => {
  function accountBlock(opponentFighterId: number, wins: number, losses: number, idPrefix: string) {
    // Two fighters on the account — the account scope counts both.
    return buildMatchupBlock(opponentFighterId, wins, losses, idPrefix).map((m, i) => ({
      ...m,
      fighter_id: i % 2 === 0 ? SUBJECT_FIGHTER_ID : 22,
    }));
  }

  it('at ACCOUNT_SCOPE on a two-opponent fixture returns a best and a toughest fact naming different opponents, both deltaPoints null', () => {
    const matches = [
      ...accountBlock(2, 30, 10, 'acc-best'),
      ...accountBlock(3, 12, 28, 'acc-worst'),
    ];
    const insights = buildMatchupBackfillInsights({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights.map((i) => i.id)).toEqual([
      'bestMatchup:account:last30',
      'worstMatchup:account:last30',
    ]);
    const [best, worst] = insights;
    expect(best!.state).toBe('fact');
    expect(worst!.state).toBe('fact');
    expect(best!.deltaPoints).toBeNull();
    expect(worst!.deltaPoints).toBeNull();
    expect(best!.copy.values.vs).toBe(getFighterById(2)!.name);
    expect(worst!.copy.values.vs).toBe(getFighterById(3)!.name);
    expect(best!.copy.values.vs).not.toBe(worst!.copy.values.vs);
    expect(best!.countedMatchIds).toHaveLength(40);
    expect(worst!.countedMatchIds).toHaveLength(40);
  });

  it('returns the best only when both rankings pick the same opponent character (never a Best and a Toughest card on one opponent)', () => {
    // Opponent 3 is the only eligible matchup (opponent 2 is below the floor),
    // so both the wins-side and the losses-side ranking pick it.
    const matches = [...accountBlock(2, 1, 0, 'acc-floor'), ...accountBlock(3, 41, 6, 'acc-only')];
    const insights = buildMatchupBackfillInsights({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights.map((i) => i.templateId)).toEqual(['bestMatchup']);
    expect(insights[0]!.copy.values.vs).toBe(getFighterById(3)!.name);
  });

  it('bestMatchupTemplate / worstMatchupTemplate at ACCOUNT_SCOPE still return [] (their character guard is kept)', () => {
    const matches = [...accountBlock(2, 30, 10, 'g-best'), ...accountBlock(3, 12, 28, 'g-worst')];
    for (const template of [bestMatchupTemplate, worstMatchupTemplate]) {
      expect(
        template.build({ matches, scope: ACCOUNT_SCOPE, horizon: 'last30', nowMs: NOW_MS }),
      ).toEqual([]);
    }
  });

  it('the character-scope templates suppress the toughest read when it would repeat the best', () => {
    const matches = [
      ...buildMatchupBlock(2, 1, 0, 'c-floor'),
      ...buildMatchupBlock(3, 41, 6, 'c-only'),
    ];
    const input = { matches, scope: subjectScope(), horizon: 'last30' as const, nowMs: NOW_MS };
    expect(bestMatchupTemplate.build(input)).toHaveLength(1);
    expect(worstMatchupTemplate.build(input)).toEqual([]);
  });
});
