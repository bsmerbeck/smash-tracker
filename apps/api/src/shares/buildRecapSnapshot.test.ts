import { describe, expect, it } from 'vitest';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { buildRecapSnapshot } from './buildRecapSnapshot.js';

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventName: 'Ultimate Singles',
    tournamentName: 'The Big House 9',
    firstSetAt: 1_000,
    lastSetAt: 5_000,
    setsPlayed: 3,
    ...overrides,
  };
}

function makeSetMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 2,
    time: 1_000,
    win: true,
    eventName: 'Ultimate Singles',
    tournamentName: 'The Big House 9',
    externalId: 'sgg:set-1:g1',
    ...overrides,
  };
}

describe('buildRecapSnapshot', () => {
  it('computes set record, notable win, and distinct characters from a mix of sets', () => {
    const entry = makeEntry({ seed: 8, placement: 3 });
    const matches: Match[] = [
      // Won set vs seed 1 (fighter 1)
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        fighter_id: 1,
        externalId: 'sgg:set-1:g1',
        opponentSeed: 1,
        opponent: 'RivalOne',
      }),
      // Won set vs seed 5 (fighter 5 -- new character)
      makeSetMatch({
        id: 'm2',
        time: 2_000,
        win: true,
        fighter_id: 5,
        externalId: 'sgg:set-2:g1',
        opponentSeed: 5,
        opponent: 'RivalTwo',
      }),
      // Lost set vs seed 2
      makeSetMatch({
        id: 'm3',
        time: 3_000,
        win: false,
        fighter_id: 1,
        externalId: 'sgg:set-3:g1',
        opponentSeed: 2,
        opponent: 'RivalThree',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.setRecordWins).toBe(2);
    expect(snapshot.setRecordLosses).toBe(1);
    expect(snapshot.notableWin).toEqual({ opponentName: 'RivalOne', opponentSeed: 1 });
    expect(snapshot.characterFighterIds).toEqual([1, 5]);
    expect(snapshot.placement).toBe(3);
    expect(snapshot.seed).toBe(8);
  });

  it('tie-breaks two won sets against the same opponentSeed on the LATER set by time', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        opponentSeed: 4,
        opponent: 'Earlier',
      }),
      makeSetMatch({
        id: 'm2',
        time: 2_000,
        win: true,
        externalId: 'sgg:set-2:g1',
        opponentSeed: 4,
        opponent: 'Later',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.notableWin).toEqual({ opponentName: 'Later', opponentSeed: 4 });
  });

  it('omits notableWin entirely when there are zero won sets', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: false,
        externalId: 'sgg:set-1:g1',
        opponentSeed: 1,
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('notableWin' in snapshot).toBe(false);
    expect(snapshot.setRecordWins).toBe(0);
    expect(snapshot.setRecordLosses).toBe(1);
  });

  it('omits notableWin entirely when no won set has a known opponentSeed', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('notableWin' in snapshot).toBe(false);
  });

  it('omits seed/placement/numEntrants entirely (never null) when the entry lacks them', () => {
    const entry = makeEntry({ seed: undefined, placement: undefined, numEntrants: undefined });
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('seed' in snapshot).toBe(false);
    expect('placement' in snapshot).toBe(false);
    expect('numEntrants' in snapshot).toBe(false);
  });

  it('always writes reviewedMomentsCount, including 0', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.reviewedMomentsCount).toBe(0);
  });

  it('sums vodTimestamps across the entry matches for reviewedMomentsCount', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        vodTimestamps: [{ seconds: 10, note: 'a' }],
      }),
      makeSetMatch({
        id: 'm2',
        time: 2_000,
        win: false,
        externalId: 'sgg:set-2:g1',
        vodTimestamps: [
          { seconds: 5, note: 'b' },
          { seconds: 15, note: 'c' },
        ],
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.reviewedMomentsCount).toBe(3);
  });

  it('falls back tournamentName to entry.eventName when the entry has no tournamentName', () => {
    const entry = makeEntry({ tournamentName: undefined });
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.tournamentName).toBe('Ultimate Singles');
  });

  it('stamps kind recap, source from entry.source (default startgg), tournamentDate from firstSetAt', () => {
    const entry = makeEntry({ source: 'parrygg', firstSetAt: 4_242 });
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'pgg-abc-g1',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.kind).toBe('recap');
    expect(snapshot.source).toBe('parrygg');
    expect(snapshot.tournamentDate).toBe(4_242);
    expect(snapshot.uid).toBe('uid-1');
  });

  it('defaults source to startgg when the entry has no source field', () => {
    const entry = makeEntry({ source: undefined });
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.source).toBe('startgg');
  });

  it('includes ownerDisplayName only when provided', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const withName = buildRecapSnapshot('uid-1', entry, matches, 'Some Player');
    expect(withName.ownerDisplayName).toBe('Some Player');

    const withoutName = buildRecapSnapshot('uid-1', entry, matches);
    expect('ownerDisplayName' in withoutName).toBe(false);
  });
});
