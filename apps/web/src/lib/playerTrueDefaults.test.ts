import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  computeMostFacedOpponentId,
  computeMostUsedFighterId,
  orderFightersByUsage,
  rankFighterUsage,
  rankOpponentUsage,
} from './playerTrueDefaults';

/** Mirrors MatchupsPage.test.tsx's makeMatch helper so fixtures type-check against `Match`. */
function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

describe('rankFighterUsage', () => {
  it('orders by games played, descending', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: 1, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: 1, time: 2 }),
      makeMatch({ id: 'm3', fighter_id: 1, time: 3 }),
      makeMatch({ id: 'm4', fighter_id: 2, time: 4 }),
      makeMatch({ id: 'm5', fighter_id: 2, time: 5 }),
    ];

    expect(rankFighterUsage(matches).map((u) => u.id)).toEqual([1, 2]);
  });

  it('breaks a tied game count with the more recent game', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: 1, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: 2, time: 5 }),
    ];

    expect(rankFighterUsage(matches).map((u) => u.id)).toEqual([2, 1]);
  });

  it('breaks a tied count AND time with String(id) ascending (locked edge resolution)', () => {
    // Ids 9 and 10 are chosen deliberately: numeric ascending (9, 10) and
    // string ascending ("10", "9") disagree — this pins the locked
    // deterministic total order (D-01/D-09), not an accidental numeric sort.
    const matches = [
      makeMatch({ id: 'm1', fighter_id: 10, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: 9, time: 1 }),
    ];

    expect(rankFighterUsage(matches).map((u) => u.id)).toEqual([10, 9]);
  });

  it('returns an empty ranking for an empty array', () => {
    expect(rankFighterUsage([])).toEqual([]);
  });

  it('returns an empty ranking for a non-array input (unloaded, not empty)', () => {
    expect(rankFighterUsage(undefined as unknown as Match[])).toEqual([]);
  });
});

describe('rankOpponentUsage', () => {
  it('ranks only the opponents faced by the given fighter', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: 1, opponent_id: 10, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: 1, opponent_id: 10, time: 2 }),
      makeMatch({ id: 'm3', fighter_id: 1, opponent_id: 20, time: 3 }),
      // A different fighter's matches must never influence this ranking.
      makeMatch({ id: 'm4', fighter_id: 2, opponent_id: 30, time: 4 }),
    ];

    expect(rankOpponentUsage(matches, 1).map((u) => u.id)).toEqual([10, 20]);
  });

  it('returns an empty ranking when the fighter has no matches', () => {
    const matches = [makeMatch({ id: 'm1', fighter_id: 1, opponent_id: 10 })];

    expect(rankOpponentUsage(matches, 99)).toEqual([]);
  });
});

describe('computeMostUsedFighterId', () => {
  it('returns undefined for an empty array', () => {
    expect(computeMostUsedFighterId([])).toBeUndefined();
  });

  it("returns the single match's fighter_id for a one-match array", () => {
    const matches = [makeMatch({ id: 'm1', fighter_id: 42 })];

    expect(computeMostUsedFighterId(matches)).toBe(42);
  });

  it('returns undefined for a non-array input', () => {
    expect(computeMostUsedFighterId(undefined as unknown as Match[])).toBeUndefined();
  });
});

describe('computeMostFacedOpponentId', () => {
  it('counts only matches of the given fighter', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: 1, opponent_id: 10, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: 1, opponent_id: 10, time: 2 }),
      makeMatch({ id: 'm3', fighter_id: 2, opponent_id: 20, time: 3 }),
    ];

    expect(computeMostFacedOpponentId(matches, 1)).toBe(10);
  });

  it('returns undefined for a fighter with no matches', () => {
    const matches = [makeMatch({ id: 'm1', fighter_id: 1, opponent_id: 10 })];

    expect(computeMostFacedOpponentId(matches, 99)).toBeUndefined();
  });
});

describe('orderFightersByUsage', () => {
  it('orders the given fighters by the same comparator rankFighterUsage uses, preserving its head', () => {
    const fighters = [{ id: 3 }, { id: 1 }, { id: 2 }];
    const matches = [
      makeMatch({ id: 'm1', fighter_id: 1, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: 1, time: 2 }),
      makeMatch({ id: 'm3', fighter_id: 2, time: 3 }),
    ];

    const ordered = orderFightersByUsage(fighters, matches);

    expect(ordered.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(ordered[0]?.id).toBe(rankFighterUsage(matches)[0]?.id);
  });

  it('places a zero-game fighter last, in String(id) order among ties', () => {
    const fighters = [{ id: 5 }, { id: 1 }];
    const matches = [makeMatch({ id: 'm1', fighter_id: 1, time: 1 })];

    expect(orderFightersByUsage(fighters, matches).map((f) => f.id)).toEqual([1, 5]);
  });

  it('returns a NEW array, never mutating the input', () => {
    const fighters = [{ id: 2 }, { id: 1 }];
    const matches = [makeMatch({ id: 'm1', fighter_id: 1 })];

    const ordered = orderFightersByUsage(fighters, matches);

    expect(ordered).not.toBe(fighters);
    expect(fighters.map((f) => f.id)).toEqual([2, 1]);
  });
});
