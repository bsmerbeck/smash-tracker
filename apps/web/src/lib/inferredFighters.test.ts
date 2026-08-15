import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { inferFighterIdsFromMatches } from './inferredFighters';

function makeMatch(fighterId: number, id: string): Match {
  return {
    id,
    fighter_id: fighterId,
    opponent_id: 99,
    time: 1000,
    win: true,
  } as Match;
}

describe('inferFighterIdsFromMatches', () => {
  it('returns unique fighter ids ordered most-played first', () => {
    const matches = [
      makeMatch(5, 'a'),
      makeMatch(3, 'b'),
      makeMatch(5, 'c'),
      makeMatch(7, 'd'),
      makeMatch(5, 'e'),
      makeMatch(3, 'f'),
    ];
    expect(inferFighterIdsFromMatches(matches)).toEqual([5, 3, 7]);
  });

  it('breaks usage ties by ascending fighter id for a stable order', () => {
    const matches = [makeMatch(9, 'a'), makeMatch(2, 'b')];
    expect(inferFighterIdsFromMatches(matches)).toEqual([2, 9]);
  });

  it('infers nothing from an empty history — no fabricated default', () => {
    expect(inferFighterIdsFromMatches([])).toEqual([]);
  });
});
