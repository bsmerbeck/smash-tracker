import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { rankLikelyOpponentSuggestions } from './likelyOpponentSuggestions';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * DAY_MS;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    ...overrides,
  };
}

describe('rankLikelyOpponentSuggestions', () => {
  it('ranks an opponent with 3 matches in the 90-day window above one with 2, regardless of last-played date', () => {
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: NOW - 1 * DAY_MS, win: true, opponent: 'alice' }),
      makeMatch({ id: 'a2', time: NOW - 2 * DAY_MS, win: true, opponent: 'alice' }),
      makeMatch({ id: 'a3', time: NOW - 3 * DAY_MS, win: true, opponent: 'alice' }),
      // bob's single match is more RECENT than any of alice's, but bob only has 2 total.
      makeMatch({ id: 'b1', time: NOW - 30 * DAY_MS, win: true, opponent: 'bob' }),
      makeMatch({ id: 'b2', time: NOW - 31 * DAY_MS, win: true, opponent: 'bob' }),
    ];

    const result = rankLikelyOpponentSuggestions(matches, NOW);

    expect(result.map((r) => r.opponent)).toEqual(['alice', 'bob']);
    expect(result[0]!.last90DayCount).toBe(3);
    expect(result[1]!.last90DayCount).toBe(2);
  });

  it('breaks equal 90-day counts (including two opponents at zero) by most-recent match time descending', () => {
    const matches: Match[] = [
      // Both older than 90 days -> last90DayCount 0 for both.
      makeMatch({ id: 'c1', time: NOW - 200 * DAY_MS, win: true, opponent: 'carol' }),
      makeMatch({ id: 'd1', time: NOW - 100 * DAY_MS, win: true, opponent: 'dave' }),
    ];

    const result = rankLikelyOpponentSuggestions(matches, NOW);

    expect(result.map((r) => r.opponent)).toEqual(['dave', 'carol']);
    expect(result[0]!.last90DayCount).toBe(0);
    expect(result[1]!.last90DayCount).toBe(0);
  });

  it('breaks equal count AND equal last-played time by canonical name ascending', () => {
    const sharedTime = NOW - 5 * DAY_MS;
    const matches: Match[] = [
      makeMatch({ id: 'z1', time: sharedTime, win: true, opponent: 'zeta' }),
      makeMatch({ id: 'a1', time: sharedTime, win: true, opponent: 'alpha' }),
    ];

    const result = rankLikelyOpponentSuggestions(matches, NOW);

    expect(result.map((r) => r.opponent)).toEqual(['alpha', 'zeta']);
  });

  it('ignores matches with no opponent value entirely', () => {
    const matches: Match[] = [
      makeMatch({ id: 'n1', time: NOW - 1 * DAY_MS, win: true }),
      makeMatch({ id: 'n2', time: NOW - 1 * DAY_MS, win: false, opponent: undefined }),
      makeMatch({ id: 'e1', time: NOW - 1 * DAY_MS, win: true, opponent: 'erin' }),
    ];

    const result = rankLikelyOpponentSuggestions(matches, NOW);

    expect(result.map((r) => r.opponent)).toEqual(['erin']);
  });

  it('still lists an opponent whose only matches are older than the window, with last90DayCount 0 — never truncated to recent players only', () => {
    const matches: Match[] = [
      makeMatch({ id: 'f1', time: NOW - 400 * DAY_MS, win: true, opponent: 'fred' }),
    ];

    const result = rankLikelyOpponentSuggestions(matches, NOW);

    expect(result).toEqual([
      { opponent: 'fred', last90DayCount: 0, lastPlayedAt: NOW - 400 * DAY_MS, totalCount: 1 },
    ]);
  });

  it('treats a match at exactly the 90-day cutoff as INSIDE the window (inclusive boundary)', () => {
    const matches: Match[] = [
      makeMatch({ id: 'g1', time: NOW - NINETY_DAYS_MS, win: true, opponent: 'grace' }),
    ];

    const result = rankLikelyOpponentSuggestions(matches, NOW);

    expect(result[0]!.last90DayCount).toBe(1);
  });

  it('is pure: does not mutate the input array and returns an equal result across two calls', () => {
    const matches: Match[] = [
      makeMatch({ id: 'h1', time: NOW - 1 * DAY_MS, win: true, opponent: 'holly' }),
      makeMatch({ id: 'h2', time: NOW - 40 * DAY_MS, win: false, opponent: 'holly' }),
      makeMatch({ id: 'i1', time: NOW - 2 * DAY_MS, win: true, opponent: 'ivan' }),
    ];
    const snapshot = [...matches];

    const first = rankLikelyOpponentSuggestions(matches, NOW);
    const second = rankLikelyOpponentSuggestions(matches, NOW);

    expect(matches).toEqual(snapshot);
    expect(first).toEqual(second);
  });
});
