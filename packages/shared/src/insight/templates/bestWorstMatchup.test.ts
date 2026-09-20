import { describe, expect, it } from 'vitest';
import { bestMatchupTemplate, worstMatchupTemplate } from './bestWorstMatchup.js';
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
    expect(insights[0]!.copy.values.vs).toBe(3);
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
    const matches = [
      ...buildMatchupBlock(4, 0, 2, 'unlucky'),
      ...buildMatchupBlock(5, 38, 41, 'toughmatchup'),
    ];
    const insights = worstMatchupTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.copy.values.vs).toBe(5);
  });
});
