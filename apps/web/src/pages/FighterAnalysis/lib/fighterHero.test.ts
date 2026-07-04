import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { buildFighterHero } from './fighterHero';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('buildFighterHero', () => {
  it('computes the overall record for the given fighter matches', () => {
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: false }),
    ];

    const hero = buildFighterHero(fighterMatches, fighterMatches);

    expect(hero.record).toEqual({ wins: 2, losses: 1, total: 3, winRate: 67 });
  });

  it('computes the share of the total (unfiltered) games as a rounded percentage', () => {
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
    ];
    // 2 of this fighter's matches out of 8 total across the account -> 25%.
    const allMatches = [
      ...fighterMatches,
      ...Array.from({ length: 6 }, (_, i) =>
        makeMatch({ id: `other-${i}`, time: 10 + i, win: true, fighter_id: 99 }),
      ),
    ];

    const hero = buildFighterHero(fighterMatches, allMatches);

    expect(hero.sharePct).toBe(25);
  });

  it('rounds the share percentage to the nearest whole number', () => {
    const fighterMatches = [makeMatch({ id: 'm1', time: 1, win: true })];
    const allMatches = [
      ...fighterMatches,
      ...Array.from({ length: 2 }, (_, i) =>
        makeMatch({ id: `other-${i}`, time: 10 + i, win: true, fighter_id: 99 }),
      ),
    ]; // 1 of 3 -> 33.33... -> rounds to 33
    expect(buildFighterHero(fighterMatches, allMatches).sharePct).toBe(33);
  });

  it('reports a 0% share when the user has no matches at all', () => {
    expect(buildFighterHero([], []).sharePct).toBe(0);
  });

  it('surfaces the current streak count and direction as a chip payload', () => {
    // Chronological: L, W, W -> current streak is 2 wins.
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: false }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: true }),
    ];

    const hero = buildFighterHero(fighterMatches, fighterMatches);

    expect(hero.streak).toEqual({ count: 2, isWin: true });
  });

  it('surfaces a loss streak with isWin false', () => {
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
      makeMatch({ id: 'm3', time: 3, win: false }),
    ];

    expect(buildFighterHero(fighterMatches, fighterMatches).streak).toEqual({
      count: 2,
      isWin: false,
    });
  });

  it('produces a rolling win-rate sparkline in chronological order', () => {
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
      makeMatch({ id: 'm3', time: 3, win: true }),
    ];

    const hero = buildFighterHero(fighterMatches, fighterMatches);

    expect(hero.sparkline).toHaveLength(3);
    expect(hero.sparkline.map((p) => p.index)).toEqual([1, 2, 3]);
    // Window 10 with only 3 matches: rolling window == all matches so far.
    expect(hero.sparkline[2]?.winRate).toBeCloseTo((2 / 3) * 100);
  });

  it('handles an empty fighter match set gracefully', () => {
    const hero = buildFighterHero([], [makeMatch({ id: 'm1', time: 1, win: true })]);

    expect(hero.record.total).toBe(0);
    expect(hero.sharePct).toBe(0);
    expect(hero.sparkline).toEqual([]);
    // No matches -> streak defaults to a 0-length win streak (getStreakSummary's empty default).
    expect(hero.streak).toEqual({ count: 0, isWin: true });
  });
});
