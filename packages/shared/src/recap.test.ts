import { describe, expect, it } from 'vitest';
import { recapGameSchema, recapSetSchema, recapSnapshotSchema } from './recap.js';

function makeSet(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    roundLabel: 'Winners Round 3',
    opponentName: 'RivalTag',
    wins: 3,
    losses: 1,
    win: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uid: 'uid-1',
    entryKey: '99',
    createdAt: 1000,
    kind: 'recap' as const,
    source: 'startgg' as const,
    tournamentName: 'The Big House 9',
    tournamentDate: 500,
    setRecordWins: 2,
    setRecordLosses: 1,
    characterFighterIds: [1, 5],
    reviewedMomentsCount: 0,
    ...overrides,
  };
}

describe('recapSetSchema', () => {
  it('parses a minimal set (no opponentPlacement/stages)', () => {
    const parsed = recapSetSchema.parse(makeSet());
    expect(parsed.roundLabel).toBe('Winners Round 3');
    expect('opponentPlacement' in parsed).toBe(false);
    expect('stages' in parsed).toBe(false);
  });

  it('parses a fully-populated set with opponentPlacement + stages', () => {
    const parsed = recapSetSchema.parse(
      makeSet({ opponentPlacement: 5, stages: ['Battlefield', "Yoshi's Story"] }),
    );
    expect(parsed.opponentPlacement).toBe(5);
    expect(parsed.stages).toEqual(['Battlefield', "Yoshi's Story"]);
  });

  it('rejects an empty opponentName', () => {
    const result = recapSetSchema.safeParse(makeSet({ opponentName: '' }));
    expect(result.success).toBe(false);
  });
});

describe('recapGameSchema (07-10 walkthrough amendment round 2)', () => {
  it('parses a fully-populated game', () => {
    const parsed = recapGameSchema.parse({
      fighterId: 1,
      opponentFighterId: 5,
      stageName: 'Battlefield',
      win: true,
    });
    expect(parsed).toEqual({
      fighterId: 1,
      opponentFighterId: 5,
      stageName: 'Battlefield',
      win: true,
    });
  });

  it('parses an empty game (every field omitted)', () => {
    const parsed = recapGameSchema.parse({});
    expect('fighterId' in parsed).toBe(false);
    expect('opponentFighterId' in parsed).toBe(false);
    expect('stageName' in parsed).toBe(false);
    expect('win' in parsed).toBe(false);
  });
});

describe('recapSetSchema.games (07-10 walkthrough amendment round 2)', () => {
  it('parses a set with a populated games array, in game order', () => {
    const parsed = recapSetSchema.parse(
      makeSet({
        games: [
          { fighterId: 1, opponentFighterId: 5, stageName: 'Battlefield', win: true },
          { fighterId: 1, opponentFighterId: 5, stageName: "Yoshi's Story", win: false },
        ],
      }),
    );
    expect(parsed.games).toHaveLength(2);
    expect(parsed.games?.[0]).toMatchObject({ stageName: 'Battlefield', win: true });
    expect(parsed.games?.[1]).toMatchObject({ stageName: "Yoshi's Story", win: false });
  });

  it('omits games (not []) for a pre-07-10 stored set', () => {
    const parsed = recapSetSchema.parse(makeSet());
    expect('games' in parsed).toBe(false);
  });

  it('rejects more than 10 games in one set', () => {
    const games = Array.from({ length: 11 }, () => ({ win: true }));
    const result = recapSetSchema.safeParse(makeSet({ games }));
    expect(result.success).toBe(false);
  });
});

describe('recapSetSchema.opponentUrl/setUrl (07-11 walkthrough round 3)', () => {
  it('parses a set carrying both opponentUrl and setUrl', () => {
    const parsed = recapSetSchema.parse(
      makeSet({
        opponentUrl: 'https://start.gg/user/07dc2239',
        setUrl: 'https://start.gg/tournament/x/event/y/set/12345/summary',
      }),
    );
    expect(parsed.opponentUrl).toBe('https://start.gg/user/07dc2239');
    expect(parsed.setUrl).toBe('https://start.gg/tournament/x/event/y/set/12345/summary');
  });

  it('parses a parry.gg opponentUrl (profile link), never a setUrl', () => {
    const parsed = recapSetSchema.parse(
      makeSet({ opponentUrl: 'https://parry.gg/profile/3f9a1c2e-1234-4abc-89ef-abcdef012345' }),
    );
    expect(parsed.opponentUrl).toBe(
      'https://parry.gg/profile/3f9a1c2e-1234-4abc-89ef-abcdef012345',
    );
    expect('setUrl' in parsed).toBe(false);
  });

  it('omits opponentUrl/setUrl (not null) when neither is derivable', () => {
    const parsed = recapSetSchema.parse(makeSet());
    expect('opponentUrl' in parsed).toBe(false);
    expect('setUrl' in parsed).toBe(false);
  });

  it('rejects an invalid opponentUrl/setUrl', () => {
    expect(recapSetSchema.safeParse(makeSet({ opponentUrl: 'not-a-url' })).success).toBe(false);
    expect(recapSetSchema.safeParse(makeSet({ setUrl: 'not-a-url' })).success).toBe(false);
  });
});

describe('recapSnapshotSchema (07-09 walkthrough amendment fields)', () => {
  it('an old-style snapshot with no detail/tournamentUrl/sets still parses (backward compatible)', () => {
    const parsed = recapSnapshotSchema.parse(makeSnapshot());
    expect(parsed.detail).toBeUndefined();
    expect(parsed.tournamentUrl).toBeUndefined();
    expect(parsed.sets).toBeUndefined();
  });

  it('parses a "summary" generation (detail/tournamentUrl/sets all absent)', () => {
    const parsed = recapSnapshotSchema.parse(makeSnapshot());
    expect('detail' in parsed).toBe(false);
    expect('sets' in parsed).toBe(false);
  });

  it('parses a "full" generation with detail:"full", tournamentUrl, and a populated sets array', () => {
    const parsed = recapSnapshotSchema.parse(
      makeSnapshot({
        detail: 'full',
        tournamentUrl: 'https://start.gg/tournament/big-house-9/event/ultimate-singles',
        sets: [makeSet(), makeSet({ roundLabel: 'Grand Finals', win: false, wins: 1, losses: 3 })],
      }),
    );
    expect(parsed.detail).toBe('full');
    expect(parsed.tournamentUrl).toBe(
      'https://start.gg/tournament/big-house-9/event/ultimate-singles',
    );
    expect(parsed.sets).toHaveLength(2);
  });

  it('rejects an invalid tournamentUrl', () => {
    const result = recapSnapshotSchema.safeParse(
      makeSnapshot({ tournamentUrl: 'not-a-valid-url' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 sets', () => {
    const sets = Array.from({ length: 21 }, (_, i) => makeSet({ roundLabel: `Set ${i + 1}` }));
    const result = recapSnapshotSchema.safeParse(makeSnapshot({ detail: 'full', sets }));
    expect(result.success).toBe(false);
  });
});
