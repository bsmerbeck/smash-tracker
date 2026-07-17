import { describe, expect, it } from 'vitest';
import type { Match, TournamentEntry } from './index.js';
import {
  buildSetTimeline,
  formatOpponentEventContext,
  formatOrdinal,
  matchesForEntry,
  ordinalSuffix,
  parseExternalId,
} from './tournamentAggregation.js';

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
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    win: true,
    ...overrides,
  };
}

describe('matchesForEntry', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

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

describe('parseExternalId', () => {
  it('parses a well-formed sgg externalId', () => {
    expect(parseExternalId('sgg:12345:g2')).toEqual({ setId: '12345', game: 2 });
  });

  it('parses a well-formed pgg externalId', () => {
    expect(parseExternalId('pgg-abc123-g2')).toEqual({ setId: 'abc123', game: 2 });
  });

  it('returns null for a missing externalId', () => {
    expect(parseExternalId(undefined)).toBeNull();
  });

  it('returns null for a malformed externalId', () => {
    expect(parseExternalId('not-a-valid-id')).toBeNull();
    expect(parseExternalId('sgg:12345')).toBeNull();
    expect(parseExternalId('sgg:12345:gX')).toBeNull();
    expect(parseExternalId('manual-xyz')).toBeNull();
    expect(parseExternalId('pgg-abc123')).toBeNull();
    expect(parseExternalId('pgg-abc123-gX')).toBeNull();
  });
});

describe('buildSetTimeline', () => {
  it('groups games by parsed setId, ordering games within a set by game number', () => {
    const g2 = makeMatch({ id: 'm2', time: 200, externalId: 'sgg:100:g2', win: false });
    const g1 = makeMatch({ id: 'm1', time: 100, externalId: 'sgg:100:g1', win: true });
    const { sets } = buildSetTimeline([g2, g1]);

    expect(sets).toHaveLength(1);
    expect(sets[0]?.games.map((g) => g.match.id)).toEqual(['m1', 'm2']);
  });

  it('orders sets chronologically by their earliest game', () => {
    const set1g1 = makeMatch({ id: 'a', time: 500, externalId: 'sgg:200:g1' });
    const set2g1 = makeMatch({ id: 'b', time: 100, externalId: 'sgg:100:g1' });
    const { sets } = buildSetTimeline([set1g1, set2g1]);

    expect(sets.map((s) => s.setId)).toEqual(['100', '200']);
  });

  it('computes the derived set score and won flag from the constituent games', () => {
    const games = [
      makeMatch({ id: 'a', time: 100, externalId: 'sgg:1:g1', win: true }),
      makeMatch({ id: 'b', time: 200, externalId: 'sgg:1:g2', win: false }),
      makeMatch({ id: 'c', time: 300, externalId: 'sgg:1:g3', win: true }),
    ];
    const { sets } = buildSetTimeline(games);

    expect(sets[0]?.gamesWon).toBe(2);
    expect(sets[0]?.gamesLost).toBe(1);
    expect(sets[0]?.won).toBe(true);
  });

  it('marks a set as lost when games lost exceed games won', () => {
    const games = [
      makeMatch({ id: 'a', time: 100, externalId: 'sgg:1:g1', win: false }),
      makeMatch({ id: 'b', time: 200, externalId: 'sgg:1:g2', win: false }),
    ];
    const { sets } = buildSetTimeline(games);
    expect(sets[0]?.won).toBe(false);
  });

  it('reads roundText/bracketRound off whichever game carries them, tolerating absence', () => {
    const withMeta = makeMatch({
      id: 'a',
      time: 100,
      externalId: 'sgg:1:g1',
      roundText: 'Losers Round 2',
      bracketRound: -2,
    });
    const withoutMeta = makeMatch({ id: 'b', time: 200, externalId: 'sgg:1:g2' });
    const { sets } = buildSetTimeline([withoutMeta, withMeta]);

    expect(sets[0]?.roundText).toBe('Losers Round 2');
    expect(sets[0]?.bracketRound).toBe(-2);
  });

  it('leaves roundText/bracketRound undefined when no game in the set carries them', () => {
    const games = [makeMatch({ id: 'a', time: 100, externalId: 'sgg:1:g1' })];
    const { sets } = buildSetTimeline(games);
    expect(sets[0]?.roundText).toBeUndefined();
    expect(sets[0]?.bracketRound).toBeUndefined();
  });

  it('collects distinct opponent fighter ids in first-seen order', () => {
    const games = [
      makeMatch({ id: 'a', time: 100, externalId: 'sgg:1:g1', opponent_id: 5 }),
      makeMatch({ id: 'b', time: 200, externalId: 'sgg:1:g2', opponent_id: 9 }),
      makeMatch({ id: 'c', time: 300, externalId: 'sgg:1:g3', opponent_id: 5 }),
    ];
    const { sets } = buildSetTimeline(games);
    expect(sets[0]?.opponentFighterIds).toEqual([5, 9]);
  });

  it('puts matches with no parseable externalId into otherMatches, sorted chronologically', () => {
    const manual2 = makeMatch({ id: 'm2', time: 500 });
    const manual1 = makeMatch({ id: 'm1', time: 100 });
    const setGame = makeMatch({ id: 'g1', time: 300, externalId: 'sgg:1:g1' });
    const { sets, otherMatches } = buildSetTimeline([manual2, setGame, manual1]);

    expect(sets).toHaveLength(1);
    expect(otherMatches.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('returns empty sets and otherMatches for an empty input', () => {
    const { sets, otherMatches } = buildSetTimeline([]);
    expect(sets).toEqual([]);
    expect(otherMatches).toEqual([]);
  });

  it('reads opponentName/opponentSeed/opponentPlacement/opponentUserSlug off whichever game carries them', () => {
    const withMeta = makeMatch({
      id: 'a',
      time: 100,
      externalId: 'sgg:1:g1',
      opponent: 'rival',
      opponentSeed: 56,
      opponentPlacement: 129,
      opponentUserSlug: 'user/9fb774ae',
    });
    const withoutMeta = makeMatch({ id: 'b', time: 200, externalId: 'sgg:1:g2' });
    const { sets } = buildSetTimeline([withoutMeta, withMeta]);

    expect(sets[0]?.opponentName).toBe('rival');
    expect(sets[0]?.opponentSeed).toBe(56);
    expect(sets[0]?.opponentPlacement).toBe(129);
    expect(sets[0]?.opponentUserSlug).toBe('user/9fb774ae');
  });

  it('leaves opponent seed/placement/userSlug undefined when no game in the set carries them', () => {
    const games = [makeMatch({ id: 'a', time: 100, externalId: 'sgg:1:g1', opponent: undefined })];
    const { sets } = buildSetTimeline(games);
    expect(sets[0]?.opponentName).toBeUndefined();
    expect(sets[0]?.opponentSeed).toBeUndefined();
    expect(sets[0]?.opponentPlacement).toBeUndefined();
    expect(sets[0]?.opponentUserSlug).toBeUndefined();
  });

  describe('parry.gg set grouping', () => {
    it('groups pgg-{matchId}-g{n} games into one set, keyed on the matchId', () => {
      const g1 = makeMatch({ id: 'm1', time: 100, externalId: 'pgg-M1-g1', win: true });
      const g2 = makeMatch({ id: 'm2', time: 200, externalId: 'pgg-M1-g2', win: true });
      const { sets, otherMatches } = buildSetTimeline([g1, g2]);

      expect(sets).toHaveLength(1);
      expect(sets[0]?.setId).toBe('M1');
      expect(sets[0]?.games.map((g) => g.match.id)).toEqual(['m1', 'm2']);
      expect(otherMatches).toEqual([]);
    });

    it('computes correct gamesWon/gamesLost/won for a grouped parry.gg set', () => {
      const games = [
        makeMatch({ id: 'a', time: 100, externalId: 'pgg-M1-g1', win: true }),
        makeMatch({ id: 'b', time: 200, externalId: 'pgg-M1-g2', win: false }),
        makeMatch({ id: 'c', time: 300, externalId: 'pgg-M1-g3', win: true }),
      ];
      const { sets } = buildSetTimeline(games);

      expect(sets).toHaveLength(1);
      expect(sets[0]?.gamesWon).toBe(2);
      expect(sets[0]?.gamesLost).toBe(1);
      expect(sets[0]?.won).toBe(true);
    });

    it('keeps distinct parry.gg matchIds as separate sets', () => {
      const setA = makeMatch({ id: 'a', time: 100, externalId: 'pgg-M1-g1' });
      const setB = makeMatch({ id: 'b', time: 200, externalId: 'pgg-M2-g1' });
      const { sets } = buildSetTimeline([setA, setB]);

      expect(sets.map((s) => s.setId)).toEqual(['M1', 'M2']);
    });
  });
});

describe('ordinalSuffix', () => {
  it('returns "st" for numbers ending in 1 (except 11)', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(101)).toBe('st');
  });

  it('returns "nd" for numbers ending in 2 (except 12)', () => {
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(22)).toBe('nd');
  });

  it('returns "rd" for numbers ending in 3 (except 13)', () => {
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(23)).toBe('rd');
  });

  it('returns "th" for the 11-13 teens regardless of last digit', () => {
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
    expect(ordinalSuffix(111)).toBe('th');
    expect(ordinalSuffix(112)).toBe('th');
    expect(ordinalSuffix(113)).toBe('th');
  });

  it('returns "th" for everything else', () => {
    expect(ordinalSuffix(0)).toBe('th');
    expect(ordinalSuffix(4)).toBe('th');
    expect(ordinalSuffix(129)).toBe('th');
  });
});

describe('formatOrdinal', () => {
  it('formats a number with its ordinal suffix', () => {
    expect(formatOrdinal(1)).toBe('1st');
    expect(formatOrdinal(129)).toBe('129th');
    expect(formatOrdinal(2)).toBe('2nd');
    expect(formatOrdinal(3)).toBe('3rd');
  });
});

describe('formatOpponentEventContext', () => {
  it('formats both seed and placement when present', () => {
    expect(formatOpponentEventContext({ seed: 56, placement: 129 })).toBe('seed 56 · placed 129th');
  });

  it('formats seed alone when placement is absent', () => {
    expect(formatOpponentEventContext({ seed: 56 })).toBe('seed 56');
  });

  it('formats placement alone when seed is absent', () => {
    expect(formatOpponentEventContext({ placement: 129 })).toBe('placed 129th');
  });

  it('returns null when both are absent', () => {
    expect(formatOpponentEventContext({})).toBeNull();
  });
});
