import { describe, expect, it } from 'vitest';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { buildRecapSnapshot } from './buildRecapSnapshot.js';

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventName: 'Ultimate Singles',
    tournamentName: 'The Big House 9',
    entryKey: '99',
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
        vodTimestamps: [{ id: 'note-1', seconds: 10, note: 'a' }],
      }),
      makeSetMatch({
        id: 'm2',
        time: 2_000,
        win: false,
        externalId: 'sgg:set-2:g1',
        vodTimestamps: [
          { id: 'note-2', seconds: 5, note: 'b' },
          { id: 'note-3', seconds: 15, note: 'c' },
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
    expect(snapshot.entryKey).toBe('99');
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

describe('buildRecapSnapshot — walkthrough amendment (07-09): detail/tournamentUrl/sets', () => {
  it('defaults to detail "full" when the 5th arg is omitted, building the set timeline', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        roundText: 'Winners Round 3',
        opponent: 'RivalTag',
        map: { id: 3, name: 'Battlefield' },
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.detail).toBe('full');
    expect(snapshot.sets).toHaveLength(1);
    expect(snapshot.sets![0]!).toEqual({
      roundLabel: 'Winners Round 3',
      opponentName: 'RivalTag',
      wins: 1,
      losses: 0,
      win: true,
      stages: ['Battlefield'],
      games: [{ fighterId: 1, opponentFighterId: 2, stageName: 'Battlefield', win: true }],
    });
  });

  it('omits detail and sets entirely for an explicit "summary" generation', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches, undefined, 'summary');

    expect('detail' in snapshot).toBe(false);
    expect('sets' in snapshot).toBe(false);
  });

  it('falls back roundLabel to a positional "Set N" when the source has no round text', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
      makeSetMatch({ id: 'm2', time: 2_000, win: false, externalId: 'sgg:set-2:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets!.map((s) => s.roundLabel)).toEqual(['Set 1', 'Set 2']);
  });

  it('falls back opponentName to "Unknown opponent" when the source has no opponent tag', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        opponent: undefined,
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.opponentName).toBe('Unknown opponent');
  });

  it('dedupes stage names within a set and omits stage id 0 (no selection)', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        map: { id: 3, name: 'Battlefield' },
      }),
      makeSetMatch({
        id: 'm2',
        time: 1_100,
        win: true,
        externalId: 'sgg:set-1:g2',
        map: { id: 3, name: 'Battlefield' },
      }),
      makeSetMatch({
        id: 'm3',
        time: 1_200,
        win: false,
        externalId: 'sgg:set-1:g3',
        map: { id: 0, name: 'no selection' },
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.stages).toEqual(['Battlefield']);
  });

  it('omits the stages field entirely when no game in the set carried a real stage', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        map: undefined,
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('stages' in snapshot.sets![0]!).toBe(false);
  });

  it('populates per-game character+stage detail (07-10 walkthrough amendment round 2)', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        fighter_id: 1,
        opponent_id: 5,
        externalId: 'sgg:set-1:g1',
        map: { id: 3, name: 'Battlefield' },
      }),
      makeSetMatch({
        id: 'm2',
        time: 1_100,
        win: false,
        fighter_id: 1,
        opponent_id: 5,
        externalId: 'sgg:set-1:g2',
        map: { id: 0, name: 'no selection' },
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.games).toEqual([
      { fighterId: 1, opponentFighterId: 5, stageName: 'Battlefield', win: true },
      { fighterId: 1, opponentFighterId: 5, win: false },
    ]);
  });

  it('caps games at 10 per set (recapGameSchema.games array max)', () => {
    const entry = makeEntry();
    const matches: Match[] = Array.from({ length: 11 }, (_, i) =>
      makeSetMatch({
        id: `m${i + 1}`,
        time: 1_000 + i,
        win: i % 2 === 0,
        externalId: `sgg:set-1:g${i + 1}`,
      }),
    );

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.games).toHaveLength(10);
  });

  it("uses the set's own opponentPlacement when present, without consulting topStandings", () => {
    const entry = makeEntry({
      topStandings: [{ placement: 99, name: 'wrong-lookup', gamerTag: 'rivaltag' }],
    });
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        opponent: 'RivalTag',
        opponentPlacement: 7,
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.opponentPlacement).toBe(7);
  });

  it('falls back to a case-insensitive topStandings tag lookup when the set has no own opponentPlacement', () => {
    const entry = makeEntry({
      topStandings: [{ placement: 12, name: 'Rival Player', gamerTag: 'RivalTag' }],
    });
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:set-1:g1',
        opponent: 'rivaltag',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.opponentPlacement).toBe(12);
  });

  it('gracefully omits opponentPlacement when neither the set nor topStandings knows it (e.g. parry.gg)', () => {
    const entry = makeEntry({ source: 'parrygg', topStandings: undefined });
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'pgg-abc-g1',
        opponent: 'RivalTag',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('opponentPlacement' in snapshot.sets![0]!).toBe(false);
  });

  it('keeps the MOST RECENT 20 sets (chronological) when a run has more', () => {
    const entry = makeEntry();
    const matches: Match[] = Array.from({ length: 25 }, (_, i) =>
      makeSetMatch({
        id: `m${i}`,
        time: 1_000 + i * 100,
        win: true,
        externalId: `sgg:set-${i}:g1`,
      }),
    );

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets).toHaveLength(20);
    // The 25 sets are positionally labeled "Set 1".."Set 25" (no roundText
    // seeded here); keeping the LAST 20 means "Set 6".."Set 25" survive.
    expect(snapshot.sets![0]!.roundLabel).toBe('Set 6');
    expect(snapshot.sets![19]!.roundLabel).toBe('Set 25');
  });

  it('computes tournamentUrl from entry.eventSlug for a startgg entry', () => {
    const entry = makeEntry({
      eventSlug: 'tournament/the-big-house-9/event/ultimate-singles',
    });
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.tournamentUrl).toBe(
      'https://start.gg/tournament/the-big-house-9/event/ultimate-singles',
    );
  });

  // Walkthrough round 3 (07-11): a verified parry.gg bracket-URL shape
  // supersedes the earlier "never invent a parry.gg URL" stance — see
  // 07-CONTEXT.md's walkthrough round 3 and `buildRecapTournamentUrl`'s doc.
  it('builds a parrygg tournamentUrl when the registry stores real parry.gg slugs', () => {
    const entry = makeEntry({
      source: 'parrygg',
      slug: 'third-street-throwdown-summer-e3-019f5918',
      eventSlug: 'ultimate-singles',
    });
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'pgg-abc-g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.tournamentUrl).toBe(
      'https://parry.gg/third-street-throwdown-summer-e3-019f5918/ultimate-singles/main/bracket',
    );
  });

  it('omits tournamentUrl for a parrygg entry with no tournament-level slug synced yet', () => {
    const entry = makeEntry({ source: 'parrygg' });
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'pgg-abc-g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('tournamentUrl' in snapshot).toBe(false);
  });

  it('omits tournamentUrl regardless of detail when the entry has no slug at all', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches, undefined, 'summary');

    expect('tournamentUrl' in snapshot).toBe(false);
  });
});

describe('buildRecapSnapshot — walkthrough round 3 (07-11): opponentUrl/setUrl', () => {
  it('populates opponentUrl (start.gg profile link) and setUrl (start.gg set page) for a startgg set', () => {
    const entry = makeEntry({
      eventSlug: 'tournament/the-big-house-9/event/ultimate-singles',
    });
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'sgg:123456:g1',
        opponent: 'RivalTag',
        opponentUserSlug: 'user/07dc2239',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.opponentUrl).toBe('https://start.gg/user/07dc2239');
    expect(snapshot.sets![0]!.setUrl).toBe(
      'https://start.gg/tournament/the-big-house-9/event/ultimate-singles/set/123456/summary',
    );
  });

  it('omits opponentUrl/setUrl entirely when the underlying fields are absent', () => {
    const entry = makeEntry();
    const matches: Match[] = [
      makeSetMatch({ id: 'm1', time: 1_000, win: true, externalId: 'sgg:set-1:g1' }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect('opponentUrl' in snapshot.sets![0]!).toBe(false);
    expect('setUrl' in snapshot.sets![0]!).toBe(false);
  });

  it('populates opponentUrl (parry.gg profile link), never setUrl, for a parrygg set', () => {
    const entry = makeEntry({ source: 'parrygg' });
    const matches: Match[] = [
      makeSetMatch({
        id: 'm1',
        time: 1_000,
        win: true,
        externalId: 'pgg-abc-g1',
        opponent: 'RivalTag',
        opponentParryUserId: '3f9a1c2e-1234-4abc-89ef-abcdef012345',
      }),
    ];

    const snapshot = buildRecapSnapshot('uid-1', entry, matches);

    expect(snapshot.sets![0]!.opponentUrl).toBe(
      'https://parry.gg/profile/3f9a1c2e-1234-4abc-89ef-abcdef012345',
    );
    expect('setUrl' in snapshot.sets![0]!).toBe(false);
  });
});
