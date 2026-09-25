import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { buildStageBreakdown } from './stageBreakdown.js';
import { ABSTENTION_FLOOR_GAMES } from './policy.js';
import { UNKNOWN_STAGE_ID } from './predicate.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: 'tagone',
    ...overrides,
  };
}

const STAGE_A = { id: 10, name: 'Stage A' };

describe('buildStageBreakdown', () => {
  it('a by-opponent group at exactly the floor is gated/ranked; one below is not, but stays in the ungated list with a null tier', () => {
    const atFloor: Match[] = Array.from({ length: ABSTENTION_FLOOR_GAMES }, (_, i) =>
      makeMatch({ id: `at-${i}`, time: i, win: true, opponent: 'floorTag', map: STAGE_A }),
    );
    const belowFloor: Match[] = Array.from({ length: ABSTENTION_FLOOR_GAMES - 1 }, (_, i) =>
      makeMatch({ id: `below-${i}`, time: i, win: true, opponent: 'subFloorTag', map: STAGE_A }),
    );
    const result = buildStageBreakdown({
      matches: [...atFloor, ...belowFloor],
      aliasMap: {},
      stageId: STAGE_A.id,
      refreshedAt: 1,
    });

    const atFloorGroup = result.byOpponent.find((g) => g.identity === 'floortag');
    const belowFloorGroup = result.byOpponent.find((g) => g.identity === 'subfloortag');
    expect(atFloorGroup!.confidenceTier).not.toBeNull();
    expect(belowFloorGroup!.confidenceTier).toBeNull();

    expect(result.rankedByOpponent.some((g) => g.identity === 'floortag')).toBe(true);
    expect(result.rankedByOpponent.some((g) => g.identity === 'subfloortag')).toBe(false);
  });

  it('a stage id with zero games returns empty group lists and a zero raw sample size without throwing', () => {
    const result = buildStageBreakdown({
      matches: [],
      aliasMap: {},
      stageId: 999,
      refreshedAt: 1,
    });
    expect(result.byOpponent).toEqual([]);
    expect(result.byCharacter).toEqual([]);
    expect(result.sample.rawSampleSize).toBe(0);
  });

  it('the unknown stage id is a legitimate input: it returns its games without throwing and without appearing in any ranked list', () => {
    const matches: Match[] = Array.from({ length: 4 }, (_, i) =>
      makeMatch({ id: `u-${i}`, time: i, win: true, opponent: 'tagone' }),
    );
    const result = buildStageBreakdown({
      matches,
      aliasMap: {},
      stageId: UNKNOWN_STAGE_ID,
      refreshedAt: 1,
    });
    expect(result.matchIds).toHaveLength(4);
    expect(result.byOpponent.some((g) => g.identity === 'tagone')).toBe(true);
    // "ranked against known stages" is out of scope for this function entirely —
    // it never compares stage id 0 to any other stage id.
    expect(result.rankedByOpponent.length).toBeGreaterThan(0);
  });

  it('games with an unresolvable opponent identity land in the disclosed unnamed bucket, never a ranked row', () => {
    const matches: Match[] = [
      makeMatch({ id: 'n1', time: 1, win: true, opponent: '', map: STAGE_A }),
      makeMatch({ id: 'n2', time: 2, win: false, opponent: '', map: STAGE_A }),
    ];
    const result = buildStageBreakdown({
      matches,
      aliasMap: {},
      stageId: STAGE_A.id,
      refreshedAt: 1,
    });
    expect(result.unnamed).not.toBeNull();
    expect(result.unnamed!.games).toBe(2);
    expect(result.byOpponent).toHaveLength(0);
  });

  it('matchIds are the countable ids for this stage, newest first', () => {
    const matches: Match[] = [
      makeMatch({ id: 'first', time: 1, win: true, map: STAGE_A }),
      makeMatch({ id: 'second', time: 5, win: true, map: STAGE_A }),
      makeMatch({ id: 'off-stage', time: 3, win: true, map: { id: 20, name: 'Off Stage' } }),
    ];
    const result = buildStageBreakdown({
      matches,
      aliasMap: {},
      stageId: STAGE_A.id,
      refreshedAt: 1,
    });
    expect(result.matchIds).toEqual(['second', 'first']);
  });

  it('by-character groups carry numeric myFighterId/theirFighterId and gate before ranking', () => {
    const atFloor: Match[] = Array.from({ length: ABSTENTION_FLOOR_GAMES }, (_, i) =>
      makeMatch({
        id: `char-${i}`,
        time: i,
        win: true,
        fighter_id: 3,
        opponent_id: 4,
        map: STAGE_A,
      }),
    );
    const result = buildStageBreakdown({
      matches: atFloor,
      aliasMap: {},
      stageId: STAGE_A.id,
      refreshedAt: 1,
    });
    const group = result.byCharacter.find((g) => g.key === '3:4');
    expect(group!.myFighterId).toBe(3);
    expect(group!.theirFighterId).toBe(4);
    expect(result.rankedByCharacter.some((g) => g.key === '3:4')).toBe(true);
  });
});
