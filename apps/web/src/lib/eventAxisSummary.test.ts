import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { describeEventAxisGames } from './eventAxisSummary';

const t = i18n.getFixedT('en');

function makeMatch(overrides: Partial<Match> & { id: string; time: number }): Match {
  return { fighter_id: 1, opponent_id: 10, win: true, opponent: 'rival', ...overrides } as Match;
}

describe('describeEventAxisGames (WR-03, 39.1-REVIEW)', () => {
  it('describes one parsed set by opponent and event, never by its set id', () => {
    const games = [1, 2, 3].map((g) =>
      makeMatch({ id: `g${g}`, time: g, eventName: 'Genesis', externalId: `sgg:78234561:g${g}` }),
    );
    const text = describeEventAxisGames(games, t);
    expect(text).toBe('Set vs rival at Genesis');
    expect(text).not.toContain('78234561');
  });

  it('describes one set with no event name without an "at" clause', () => {
    const games = [makeMatch({ id: 'a', time: 1, externalId: 'pgg-abc-g1' })];
    expect(describeEventAxisGames(games, t)).toBe('Set vs rival');
  });

  it('describes a single manual game by opponent and date, never game:<id>', () => {
    const at = Date.UTC(2024, 2, 5);
    const text = describeEventAxisGames([makeMatch({ id: '9f2c', time: at })], t);
    expect(text).toBe(`Game vs rival on ${new Date(at).toLocaleDateString()}`);
    expect(text).not.toContain('9f2c');
  });

  it('names a multi-set event block by its event name', () => {
    const games = [
      makeMatch({ id: 'a', time: 1, eventName: ' Genesis ', externalId: 'sgg:s1:g1' }),
      makeMatch({ id: 'b', time: 2, eventName: 'Genesis', externalId: 'sgg:s2:g1' }),
    ];
    expect(describeEventAxisGames(games, t)).toBe('Genesis');
  });

  it('falls back to the games date range for a session or calendar period', () => {
    const a = Date.UTC(2024, 0, 1);
    const b = Date.UTC(2024, 0, 20);
    const games = [makeMatch({ id: 'a', time: a }), makeMatch({ id: 'b', time: b })];
    expect(describeEventAxisGames(games, t)).toBe(
      `${new Date(a).toLocaleDateString()} – ${new Date(b).toLocaleDateString()}`,
    );
  });

  it('returns undefined for no games (a stale key) so the caller never prints the raw key', () => {
    expect(describeEventAxisGames([], t)).toBeUndefined();
  });
});
