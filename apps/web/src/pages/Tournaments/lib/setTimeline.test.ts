import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { buildSetTimeline, parseExternalId } from './setTimeline';

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

describe('parseExternalId', () => {
  it('parses a well-formed sgg externalId', () => {
    expect(parseExternalId('sgg:12345:g2')).toEqual({ setId: '12345', game: 2 });
  });

  it('returns null for a missing externalId', () => {
    expect(parseExternalId(undefined)).toBeNull();
  });

  it('returns null for a malformed externalId', () => {
    expect(parseExternalId('not-a-valid-id')).toBeNull();
    expect(parseExternalId('sgg:12345')).toBeNull();
    expect(parseExternalId('sgg:12345:gX')).toBeNull();
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
});
