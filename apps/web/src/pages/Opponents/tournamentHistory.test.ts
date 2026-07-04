import { describe, expect, it } from 'vitest';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import {
  abbreviateStageName,
  getEncounterContext,
  groupIntoSets,
  groupTournamentBlocks,
  parseSetId,
  resolveTournamentEntry,
  TOURNAMENT_PROXIMITY_WINDOW_MS,
} from './tournamentHistory';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    source: 'startgg',
    ...overrides,
  };
}

describe('parseSetId', () => {
  it('extracts the set id from a well-formed externalId', () => {
    expect(parseSetId('sgg:12345:g1')).toBe('12345');
    expect(parseSetId('sgg:12345:g2')).toBe('12345');
  });

  it('handles set ids that themselves contain colons', () => {
    expect(parseSetId('sgg:abc:def:g3')).toBe('abc:def');
  });

  it('returns null for undefined or malformed ids', () => {
    expect(parseSetId(undefined)).toBeNull();
    expect(parseSetId('not-a-startgg-id')).toBeNull();
    expect(parseSetId('sgg:12345')).toBeNull();
  });
});

describe('abbreviateStageName', () => {
  it('takes initials for multi-word names, skipping "the"/"of"', () => {
    expect(abbreviateStageName('Battlefield')).toBe('BAT');
    expect(abbreviateStageName('Final Destination')).toBe('FD');
    expect(abbreviateStageName("Peach's Castle")).toBe('PC');
    expect(abbreviateStageName('Kingdom of the Winds')).toBe('KW');
  });

  it('returns an empty string for an empty name', () => {
    expect(abbreviateStageName('')).toBe('');
  });
});

describe('groupIntoSets', () => {
  it('groups games by parsed setId and derives the score from game wins/losses', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 1, win: true, externalId: 'sgg:100:g1' }),
      makeMatch({ id: 'g2', time: 2, win: false, externalId: 'sgg:100:g2' }),
      makeMatch({ id: 'g3', time: 3, win: true, externalId: 'sgg:100:g3' }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets).toHaveLength(1);
    expect(sets[0]!.setId).toBe('100');
    expect(sets[0]!.wins).toBe(2);
    expect(sets[0]!.losses).toBe(1);
    expect(sets[0]!.games).toHaveLength(3);
  });

  it('splits distinct set ids into separate sets and orders sets chronologically', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 10, win: true, externalId: 'sgg:200:g1' }),
      makeMatch({ id: 'g2', time: 1, win: true, externalId: 'sgg:100:g1' }),
      makeMatch({ id: 'g3', time: 2, win: false, externalId: 'sgg:100:g2' }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets.map((s) => s.setId)).toEqual(['100', '200']);
  });

  it('ignores games without a parseable externalId', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 1, win: true, externalId: 'sgg:100:g1' }),
      makeMatch({ id: 'g2', time: 2, win: true, source: undefined, externalId: undefined }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets).toHaveLength(1);
    expect(sets[0]!.games).toHaveLength(1);
  });

  it('uses roundText when present on any game in the set', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 1,
        win: true,
        externalId: 'sgg:100:g1',
        roundText: 'Winners Semi-Final',
        bracketRound: 3,
      }),
      makeMatch({ id: 'g2', time: 2, win: false, externalId: 'sgg:100:g2' }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets[0]!.roundLabel).toBe('Winners Semi-Final');
    expect(sets[0]!.bracketRound).toBe(3);
    expect(sets[0]!.isLosersSide).toBe(false);
  });

  it('falls back to "Set N" (1-based, chronological) when no game carries roundText', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 1, win: true, externalId: 'sgg:100:g1' }),
      makeMatch({ id: 'g2', time: 10, win: true, externalId: 'sgg:200:g1' }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets[0]!.roundLabel).toBe('Set 1');
    expect(sets[1]!.roundLabel).toBe('Set 2');
  });

  it('marks a set as losers-side when bracketRound is negative', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 1,
        win: false,
        externalId: 'sgg:100:g1',
        roundText: 'Losers Round 2',
        bracketRound: -2,
      }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets[0]!.isLosersSide).toBe(true);
  });

  it('derives stage abbreviation and falls back to "unknown" for the no-stage sentinel', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 1,
        win: true,
        externalId: 'sgg:100:g1',
        map: { id: 3, name: 'Final Destination' },
      }),
      makeMatch({
        id: 'g2',
        time: 2,
        win: false,
        externalId: 'sgg:100:g2',
        map: { id: 0, name: 'unknown' },
      }),
    ];

    const sets = groupIntoSets(matches);

    expect(sets[0]!.games[0]!.stageAbbr).toBe('FD');
    expect(sets[0]!.games[1]!.stageName).toBe('unknown');
  });
});

describe('groupTournamentBlocks', () => {
  it('excludes matches without an eventName', () => {
    const matches = [makeMatch({ id: 'g1', time: 1, win: true, eventName: undefined })];
    expect(groupTournamentBlocks(matches)).toEqual([]);
  });

  it('groups by tournamentName falling back to eventName, and computes the block record', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 1,
        win: true,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        externalId: 'sgg:100:g1',
      }),
      makeMatch({
        id: 'g2',
        time: 2,
        win: false,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        externalId: 'sgg:200:g1',
      }),
      makeMatch({
        id: 'g3',
        time: 3,
        win: true,
        eventName: 'Ultimate Doubles',
        externalId: 'sgg:300:g1',
      }),
    ];

    const blocks = groupTournamentBlocks(matches);

    expect(blocks).toHaveLength(2);
    const tbh = blocks.find((b) => b.displayName === 'The Big House 9')!;
    expect(tbh.wins).toBe(1);
    expect(tbh.losses).toBe(1);
    expect(tbh.sets).toHaveLength(2);
    const doubles = blocks.find((b) => b.displayName === 'Ultimate Doubles')!;
    expect(doubles.wins).toBe(1);
  });

  it('splits same-named groups into separate blocks when sets are further apart than the proximity window', () => {
    const base = Date.parse('2021-01-01T00:00:00Z');
    const matches = [
      makeMatch({
        id: 'g1',
        time: base,
        win: true,
        eventName: 'Weekly',
        externalId: 'sgg:100:g1',
      }),
      makeMatch({
        id: 'g2',
        time: base + TOURNAMENT_PROXIMITY_WINDOW_MS + 1,
        win: false,
        eventName: 'Weekly',
        externalId: 'sgg:200:g1',
      }),
    ];

    const blocks = groupTournamentBlocks(matches);

    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.displayName === 'Weekly')).toBe(true);
  });

  it('keeps same-named sets within the proximity window in a single block', () => {
    const base = Date.parse('2021-01-01T00:00:00Z');
    const matches = [
      makeMatch({
        id: 'g1',
        time: base,
        win: true,
        eventName: 'Weekly',
        externalId: 'sgg:100:g1',
      }),
      makeMatch({
        id: 'g2',
        time: base + TOURNAMENT_PROXIMITY_WINDOW_MS - 1,
        win: false,
        eventName: 'Weekly',
        externalId: 'sgg:200:g1',
      }),
    ];

    const blocks = groupTournamentBlocks(matches);

    expect(blocks).toHaveLength(1);
  });

  it('sorts blocks by endTime descending (most recent first)', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 1,
        win: true,
        eventName: 'Older Event',
        externalId: 'sgg:100:g1',
      }),
      makeMatch({
        id: 'g2',
        time: 1000,
        win: true,
        eventName: 'Newer Event',
        externalId: 'sgg:200:g1',
      }),
    ];

    const blocks = groupTournamentBlocks(matches);

    expect(blocks.map((b) => b.displayName)).toEqual(['Newer Event', 'Older Event']);
  });
});

describe('resolveTournamentEntry', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BASE = Date.parse('2021-01-01T00:00:00Z');

  function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
    return {
      eventId: 987,
      eventName: 'Ultimate Singles',
      firstSetAt: BASE,
      lastSetAt: BASE + DAY_MS,
      setsPlayed: 5,
      ...overrides,
    };
  }

  it('matches an entry by eventName when the block falls within its time window', () => {
    const block = {
      displayName: 'The Big House 9',
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      sets: [],
      startTime: BASE + 1000,
      endTime: BASE + DAY_MS - 1000,
      wins: 2,
      losses: 1,
    };
    const entries = [makeEntry()];

    expect(resolveTournamentEntry(block, entries)).toEqual(entries[0]);
  });

  it('returns null when eventName does not match any entry', () => {
    const block = {
      displayName: 'X',
      eventName: 'Ultimate Doubles',
      sets: [],
      startTime: BASE + 1000,
      endTime: BASE + DAY_MS - 1000,
      wins: 0,
      losses: 0,
    };
    expect(resolveTournamentEntry(block, [makeEntry()])).toBeNull();
  });

  it('returns null when the eventName matches but the time window does not', () => {
    const block = {
      displayName: 'X',
      eventName: 'Ultimate Singles',
      sets: [],
      startTime: BASE + 30 * DAY_MS,
      endTime: BASE + 31 * DAY_MS,
      wins: 0,
      losses: 0,
    };
    expect(resolveTournamentEntry(block, [makeEntry()])).toBeNull();
  });

  it('picks the matching entry among several candidates with the same eventName', () => {
    const block = {
      displayName: 'X',
      eventName: 'Ultimate Singles',
      sets: [],
      startTime: BASE + 10 * DAY_MS + 1000,
      endTime: BASE + 10 * DAY_MS + 2000,
      wins: 0,
      losses: 0,
    };
    const entries = [
      makeEntry({ eventId: 1, firstSetAt: BASE, lastSetAt: BASE + DAY_MS }),
      makeEntry({ eventId: 2, firstSetAt: BASE + 10 * DAY_MS, lastSetAt: BASE + 11 * DAY_MS }),
    ];

    expect(resolveTournamentEntry(block, entries)?.eventId).toBe(2);
  });
});

describe('getEncounterContext', () => {
  it('reports zero tournaments and a null span when there are no blocks', () => {
    expect(getEncounterContext([])).toEqual({ tournamentCount: 0, span: null });
  });

  it('reports the count and overall span across blocks', () => {
    const blocks = [
      {
        displayName: 'A',
        eventName: 'A',
        sets: [],
        startTime: 100,
        endTime: 200,
        wins: 1,
        losses: 0,
      },
      {
        displayName: 'B',
        eventName: 'B',
        sets: [],
        startTime: 500,
        endTime: 900,
        wins: 0,
        losses: 1,
      },
    ];

    expect(getEncounterContext(blocks)).toEqual({
      tournamentCount: 2,
      span: { start: 100, end: 900 },
    });
  });
});
