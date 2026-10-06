import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { describeEventAxisGames } from './eventAxisSummary';

const t = i18n.getFixedT('en');
const EN = 'en-US';
const DE = 'de-DE';

function makeMatch(overrides: Partial<Match> & { id: string; time: number }): Match {
  return { fighter_id: 1, opponent_id: 10, win: true, opponent: 'rival', ...overrides } as Match;
}

describe('describeEventAxisGames (WR-03, 39.1-REVIEW)', () => {
  it('describes one parsed set by opponent and event, never by its set id', () => {
    const games = [1, 2, 3].map((g) =>
      makeMatch({ id: `g${g}`, time: g, eventName: 'Genesis', externalId: `sgg:78234561:g${g}` }),
    );
    const text = describeEventAxisGames(games, t, EN);
    expect(text).toBe('Set vs rival at Genesis');
    expect(text).not.toContain('78234561');
  });

  it('describes one set with no event name without an "at" clause', () => {
    const games = [
      makeMatch({ id: 'a', time: 1, externalId: 'pgg-abc-g1' }),
      makeMatch({ id: 'b', time: 2, externalId: 'pgg-abc-g2' }),
    ];
    expect(describeEventAxisGames(games, t, EN)).toBe('Set vs rival');
  });

  // Iteration 2 WR-03: a game-grain trend point (or a one-game slice of a
  // set) resolves to ONE start.gg game. Describing it as the whole set named
  // games the list does not show.
  it('describes a single start.gg game as a game, never as its whole set', () => {
    const at = Date.UTC(2024, 2, 5, 12);
    const text = describeEventAxisGames(
      [makeMatch({ id: 'g2', time: at, eventName: 'Genesis', externalId: 'sgg:78234561:g2' })],
      t,
      EN,
    );
    expect(text).toBe('Game vs rival on 3/5/2024');
  });

  it('describes a single manual game by opponent and date, never game:<id>', () => {
    const at = Date.UTC(2024, 2, 5, 12);
    const text = describeEventAxisGames([makeMatch({ id: '9f2c', time: at })], t, EN);
    expect(text).toBe('Game vs rival on 3/5/2024');
    expect(text).not.toContain('9f2c');
  });

  it('names a multi-set event block by its event name', () => {
    const games = [
      makeMatch({ id: 'a', time: 1, eventName: ' Genesis ', externalId: 'sgg:s1:g1' }),
      makeMatch({ id: 'b', time: 2, eventName: 'Genesis', externalId: 'sgg:s2:g1' }),
    ];
    expect(describeEventAxisGames(games, t, EN)).toBe('Genesis');
  });

  it('falls back to the games date range for a session or calendar period', () => {
    const a = Date.UTC(2024, 0, 1);
    const b = Date.UTC(2024, 0, 20);
    const games = [makeMatch({ id: 'a', time: a }), makeMatch({ id: 'b', time: b })];
    const text = describeEventAxisGames(games, t, EN);
    expect(text).toMatch(/^1\/1\/2024\s.\s1\/20\/2024$/);
  });

  // I18N-01 (41-08): the summary follows the app language, never the OS default.
  it('formats the single-game date and the date range in the app language', () => {
    const at = Date.UTC(2024, 2, 5, 12);
    expect(describeEventAxisGames([makeMatch({ id: 'x', time: at })], t, EN)).toContain('3/5/2024');
    expect(describeEventAxisGames([makeMatch({ id: 'x', time: at })], t, DE)).toContain('5.3.2024');
    const a = Date.UTC(2024, 0, 1, 12);
    const b = Date.UTC(2024, 0, 20, 12);
    const range = describeEventAxisGames(
      [makeMatch({ id: 'a', time: a }), makeMatch({ id: 'b', time: b })],
      t,
      DE,
    );
    // German day.month.year order, never the en-US month/day/year the OS default would print.
    expect(range).toMatch(/20\.0?1\.2024/);
    expect(range).not.toContain('/');
  });

  it('returns undefined for no games (a stale key) so the caller never prints the raw key', () => {
    expect(describeEventAxisGames([], t, EN)).toBeUndefined();
  });
});

describe('describeEventAxisGames — calendar-period keys (UAT 39.1-27a F4)', () => {
  const games = [1, 2, 3, 4, 5, 6, 7].map((g) =>
    makeMatch({
      id: `q${g}`,
      time: Date.UTC(2024, 3, g * 3, 12),
      eventName: 'Ultimate Singles',
      opponent: `rival${g}`,
    }),
  );

  it('names a quarter drill by its period, never by the event name the games share', () => {
    const text = describeEventAxisGames(games, t, EN, 'quarter:2024-Q2');
    expect(text).toBe('2024 Q2');
    expect(text).not.toContain('Ultimate Singles');
  });

  it('keeps the shared event name for a named-event key', () => {
    expect(describeEventAxisGames(games, t, EN, 'eventSession:Ultimate Singles')).toBe(
      'Ultimate Singles',
    );
  });
});
