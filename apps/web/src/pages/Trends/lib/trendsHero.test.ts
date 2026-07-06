import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { BEST_MONTH_MIN_GAMES, CURRENT_FORM_WINDOW, buildTrendsHero } from './trendsHero';

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

describe('buildTrendsHero', () => {
  it('returns nulls and zeroed form for no matches', () => {
    const hero = buildTrendsHero([]);
    expect(hero.currentRating).toBeNull();
    expect(hero.peakRating).toBeNull();
    expect(hero.bestMonth).toBeNull();
    expect(hero.currentFormWinRate).toBe(100);
    expect(hero.currentFormGames).toBe(0);
  });

  it('reports the current rating +/- RD once the rating history has periods', () => {
    const matches = Array.from({ length: 6 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );

    const hero = buildTrendsHero(matches);

    expect(hero.currentRating).not.toBeNull();
    expect(typeof hero.currentRating?.rating).toBe('number');
    expect(typeof hero.currentRating?.rd).toBe('number');
  });

  it('computes peak rating as the max across all rating periods', () => {
    const HOUR_MS = 60 * 60 * 1000;
    const matches = [
      // Session 1
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: HOUR_MS, win: true }),
      makeMatch({ id: '3', time: 2 * HOUR_MS, win: true }),
      // Gap > 3h default -> new session, all losses drags rating down.
      makeMatch({ id: '4', time: 10 * HOUR_MS, win: false }),
      makeMatch({ id: '5', time: 11 * HOUR_MS, win: false }),
      makeMatch({ id: '6', time: 12 * HOUR_MS, win: false }),
    ];

    const hero = buildTrendsHero(matches);

    expect(hero.peakRating).not.toBeNull();
    expect(hero.currentRating).not.toBeNull();
    // Peak should be at least as high as the current (post-losing-streak) rating.
    expect(hero.peakRating as number).toBeGreaterThanOrEqual(hero.currentRating!.rating);
  });

  it('picks the highest win-rate month among months meeting the minimum sample', () => {
    const matches = [
      // Jan 2021: 2 games, 100% win rate but below the minimum sample -> excluded.
      makeMatch({ id: '1', time: Date.UTC(2021, 0, 1), win: true }),
      makeMatch({ id: '2', time: Date.UTC(2021, 0, 2), win: true }),
      // Feb 2021: 5 games, 80% win rate -> eligible.
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `feb-${i}`, time: Date.UTC(2021, 1, i + 1), win: i !== 0 }),
      ),
      // Mar 2021: 5 games, 40% win rate -> eligible but worse.
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `mar-${i}`, time: Date.UTC(2021, 2, i + 1), win: i < 2 }),
      ),
    ];
    expect(BEST_MONTH_MIN_GAMES).toBe(5);

    const hero = buildTrendsHero(matches);

    expect(hero.bestMonth?.month).toBe('2021-02');
    expect(hero.bestMonth?.winRate).toBe(80);
  });

  it('returns null best month when no month has the minimum sample', () => {
    const matches = [
      makeMatch({ id: '1', time: Date.UTC(2021, 0, 1), win: true }),
      makeMatch({ id: '2', time: Date.UTC(2021, 0, 2), win: true }),
    ];

    const hero = buildTrendsHero(matches);

    expect(hero.bestMonth).toBeNull();
  });

  it('computes current form over the last CURRENT_FORM_WINDOW games only', () => {
    expect(CURRENT_FORM_WINDOW).toBe(20);
    // 15 losses followed by 20 wins -> last-20 window should be all wins (100%),
    // even though the account's all-time record is much worse.
    const matches = [
      ...Array.from({ length: 15 }, (_, i) => makeMatch({ id: `l${i}`, time: i, win: false })),
      ...Array.from({ length: 20 }, (_, i) =>
        makeMatch({ id: `w${i}`, time: 1000 + i, win: true }),
      ),
    ];

    const hero = buildTrendsHero(matches);

    expect(hero.currentFormGames).toBe(20);
    expect(hero.currentFormWinRate).toBe(100);
  });

  it('uses fewer than CURRENT_FORM_WINDOW games when the account has less history', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: false }),
      makeMatch({ id: '3', time: 3, win: true }),
    ];

    const hero = buildTrendsHero(matches);

    expect(hero.currentFormGames).toBe(3);
    expect(hero.currentFormWinRate).toBe(67);
  });
});
