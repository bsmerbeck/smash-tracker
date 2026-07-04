import { describe, expect, it } from 'vitest';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { matchesForEntry } from './matchesForEntry';

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_000_000,
    lastSetAt: 2_000_000,
    setsPlayed: 3,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('matchesForEntry', () => {
  it('includes a match with matching eventName and time inside the entry window', () => {
    const entry = makeEntry();
    const match = makeMatch({ id: 'm1', time: 1_500_000, eventName: 'Ultimate Singles' });
    expect(matchesForEntry([match], entry)).toEqual([match]);
  });

  it('excludes a match with a different eventName', () => {
    const entry = makeEntry();
    const match = makeMatch({ id: 'm1', time: 1_500_000, eventName: 'Doubles' });
    expect(matchesForEntry([match], entry)).toEqual([]);
  });

  it('excludes a same-named-event match outside the padded time window (name collision, different window)', () => {
    // Two different weeklies both ran "Ultimate Singles"; this match shares
    // the name but happened weeks before this entry's window.
    const entry = makeEntry({ firstSetAt: 10_000_000, lastSetAt: 11_000_000 });
    const farBefore = 10_000_000 - DAY_MS * 30;
    const match = makeMatch({ id: 'm1', time: farBefore, eventName: 'Ultimate Singles' });
    expect(matchesForEntry([match], entry)).toEqual([]);
  });

  it('includes a match just inside the 24h padding before firstSetAt', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000, lastSetAt: 2_000_000 });
    const match = makeMatch({
      id: 'm1',
      time: 1_000_000 - DAY_MS + 1,
      eventName: 'Ultimate Singles',
    });
    expect(matchesForEntry([match], entry)).toEqual([match]);
  });

  it('includes a match just inside the 24h padding after lastSetAt', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000, lastSetAt: 2_000_000 });
    const match = makeMatch({
      id: 'm1',
      time: 2_000_000 + DAY_MS - 1,
      eventName: 'Ultimate Singles',
    });
    expect(matchesForEntry([match], entry)).toEqual([match]);
  });

  it('excludes a match just outside the padded window', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000, lastSetAt: 2_000_000 });
    const tooEarly = makeMatch({
      id: 'm1',
      time: 1_000_000 - DAY_MS - 1,
      eventName: 'Ultimate Singles',
    });
    const tooLate = makeMatch({
      id: 'm2',
      time: 2_000_000 + DAY_MS + 1,
      eventName: 'Ultimate Singles',
    });
    expect(matchesForEntry([tooEarly, tooLate], entry)).toEqual([]);
  });

  it('when entry.tournamentName is null, accepts matches regardless of their tournamentName', () => {
    const entry = makeEntry({ tournamentName: undefined });
    const withName = makeMatch({
      id: 'm1',
      time: 1_500_000,
      eventName: 'Ultimate Singles',
      tournamentName: 'Some Weekly',
    });
    const withoutName = makeMatch({ id: 'm2', time: 1_600_000, eventName: 'Ultimate Singles' });
    expect(matchesForEntry([withName, withoutName], entry)).toEqual([withName, withoutName]);
  });

  it('when entry.tournamentName is set, requires an exact tournamentName match', () => {
    const entry = makeEntry({ tournamentName: 'The Big House 9' });
    const matching = makeMatch({
      id: 'm1',
      time: 1_500_000,
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
    });
    const differentTournament = makeMatch({
      id: 'm2',
      time: 1_600_000,
      eventName: 'Ultimate Singles',
      tournamentName: 'Genesis 9',
    });
    const missingTournament = makeMatch({
      id: 'm3',
      time: 1_700_000,
      eventName: 'Ultimate Singles',
    });
    expect(matchesForEntry([matching, differentTournament, missingTournament], entry)).toEqual([
      matching,
    ]);
  });

  it('returns an empty array when no matches qualify', () => {
    const entry = makeEntry();
    expect(matchesForEntry([], entry)).toEqual([]);
  });
});
