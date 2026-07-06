import { describe, expect, it } from 'vitest';
import type { ScoutReportData } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  assembleReportPayload,
  generateScoutReport,
  ReportGenerationError,
  type AnthropicLikeClient,
} from './generate.js';

const UID = 'test-uid-123';

const SCOUT: ScoutReportData = {
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  sampledSets: 10,
  sampledGames: 20,
  characters: [
    { fighterId: 8, games: 12, wins: 8 }, // Fox
    { fighterId: 22, games: 8, wins: 4 }, // Falco
  ],
  stages: [{ stageId: 1, games: 20, wins: 12 }],
  recentEvents: [],
  commonOpponents: [],
};

describe('assembleReportPayload', () => {
  it('returns empty head-to-head, zeroed userContext, and null notes with no data', async () => {
    const database = new FakeDatabase();
    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.scout).toBe(SCOUT);
    expect(payload.headToHead).toEqual([]);
    expect(payload.userContext.vsTopCharacters).toEqual([
      { opponentCharacter: 'Fox', wins: 0, losses: 0, topStages: [] },
      { opponentCharacter: 'Falco', wins: 0, losses: 0, topStages: [] },
    ]);
    expect(payload.userContext.recentForm).toEqual({ wins: 0, losses: 0, sampleSize: 0 });
    expect(payload.notes).toBeNull();
    expect(payload.userContext.myFighters).toEqual({ primary: [], secondary: [] });
    expect(payload.userContext.myCharacterRecords).toEqual([]);
  });

  it('maps myFighters sprite ids to character names', async () => {
    const database = new FakeDatabase();
    database.seed(`primaryFighters/${UID}`, [8]); // Fox
    database.seed(`secondaryFighters/${UID}`, [22]); // Falco

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.myFighters).toEqual({ primary: ['Fox'], secondary: ['Falco'] });
  });

  it('builds myCharacterRecords for the union of selections and top-played characters, vs. the opponent’s top characters', async () => {
    const database = new FakeDatabase();
    database.seed(`primaryFighters/${UID}`, [1]); // Mario (the user's main)
    database.seed(`secondaryFighters/${UID}`, []);
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1, // Mario
        opponent_id: 8, // Fox
        time: 3,
        win: true,
        opponent: 'a',
      },
      m2: {
        fighter_id: 1, // Mario
        opponent_id: 8, // Fox
        time: 2,
        win: false,
        opponent: 'b',
      },
      m3: {
        fighter_id: 1, // Mario
        opponent_id: 22, // Falco
        time: 1,
        win: true,
        opponent: 'c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.myCharacterRecords).toEqual([
      {
        userCharacter: 'Mario',
        wins: 2,
        losses: 1,
        vsOpponentCharacter: [
          { opponentCharacter: 'Fox', wins: 1, losses: 1 },
          { opponentCharacter: 'Falco', wins: 1, losses: 0 },
        ],
      },
    ]);
  });

  it('includes the user’s top-5 most-played characters even without a primary/secondary selection', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: { fighter_id: 9, opponent_id: 8, time: 1, win: true, opponent: 'a' }, // Pikachu
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.myCharacterRecords).toHaveLength(1);
    expect(payload.userContext.myCharacterRecords[0]).toMatchObject({ userCharacter: 'Pikachu' });
  });

  it('matches head-to-head by opponentUserSlug (strongest signal)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'someone else entirely',
        opponentUserSlug: 'user/07dc2239',
        eventName: 'Ultimate Singles',
        roundText: 'Winners Round 2',
        stocksLeft: 2,
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toEqual([
      {
        result: 'win',
        userCharacter: 'Mario',
        opponentCharacter: 'Fox',
        stage: 'Battlefield',
        eventName: 'Ultimate Singles',
        roundText: 'Winners Round 2',
        stocksLeft: 2,
        date: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  it('matches head-to-head by canonical opponent name when no userSlug is present', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: false,
        opponent: 'pandem1c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toHaveLength(1);
    expect(payload.headToHead[0]).toMatchObject({ result: 'loss' });
  });

  it('resolves the opponent name through the alias map before matching', async () => {
    const database = new FakeDatabase();
    database.seed(`opponentAliases/${UID}`, { 'sponsor tag': 'pandem1c' });
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        opponent: 'sponsor tag',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toHaveLength(1);
  });

  it('does not include matches against other opponents in head-to-head', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        opponent: 'someone unrelated',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toEqual([]);
  });

  it('aggregates raw W/L and top stages against the scouted player’s top characters', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8, // Fox
        time: 3,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'a',
      },
      m2: {
        fighter_id: 1,
        opponent_id: 8, // Fox
        time: 2,
        win: false,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'b',
      },
      m3: {
        fighter_id: 1,
        opponent_id: 22, // Falco
        time: 1,
        win: true,
        map: { id: 3, name: 'Final Destination' },
        opponent: 'c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.vsTopCharacters).toEqual([
      {
        opponentCharacter: 'Fox',
        wins: 1,
        losses: 1,
        topStages: [{ stage: 'Battlefield', wins: 1, losses: 1 }],
      },
      {
        opponentCharacter: 'Falco',
        wins: 1,
        losses: 0,
        topStages: [{ stage: 'Final Destination', wins: 1, losses: 0 }],
      },
    ]);
  });

  it('computes recent form over the most recent 50 matches only', async () => {
    const database = new FakeDatabase();
    const seed: Record<string, unknown> = {};
    // 3 wins then 2 losses, all older than a big losing streak that should
    // be excluded once more than 50 matches exist.
    for (let i = 0; i < 3; i += 1) {
      seed[`old-win-${i}`] = { fighter_id: 1, opponent_id: 2, time: i, win: true, opponent: 'x' };
    }
    for (let i = 0; i < 60; i += 1) {
      seed[`recent-${i}`] = {
        fighter_id: 1,
        opponent_id: 2,
        time: 1000 + i,
        win: i % 2 === 0,
        opponent: 'x',
      };
    }

    database.seed(`matches/${UID}`, seed);

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.recentForm.sampleSize).toBe(50);
    expect(payload.userContext.recentForm.wins + payload.userContext.recentForm.losses).toBe(50);
  });

  it('includes the saved opponent note for the scouted player, keyed by canonical name', async () => {
    const database = new FakeDatabase();
    database.seed(`opponentNotes/${UID}`, {
      pandem1c: { habits: 'likes to dash dance', updatedAt: 1_700_000_000_000 },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.notes).toEqual({
      habits: 'likes to dash dance',
      updatedAt: 1_700_000_000_000,
    });
  });
});

const VALID_REPORT = {
  overview: 'A fast-falling Fox/Falco player who plays aggressively.',
  gameplan: ['Punish landing lag hard.'],
  characterStrategy: {
    picks: ['Mario'],
    reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario — favorable matchup either way.',
  },
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'They perform best on flat stages.',
  },
  headToHead: null,
  watchFor: ['Likes to shine spike off stage.'],
  confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
};

function stubClient(response: {
  stop_reason: string | null;
  parsed_output: unknown;
}): AnthropicLikeClient {
  return {
    messages: {
      parse: async () => response as Awaited<ReturnType<AnthropicLikeClient['messages']['parse']>>,
    },
  };
}

const PAYLOAD = {
  scout: SCOUT,
  headToHead: [],
  userContext: {
    myFighters: { primary: [], secondary: [] },
    myCharacterRecords: [],
    vsTopCharacters: [],
    recentForm: { wins: 0, losses: 0, sampleSize: 0 },
  },
  notes: null,
};

describe('generateScoutReport', () => {
  it('returns the parsed output on a normal completion', async () => {
    const client = stubClient({ stop_reason: 'end_turn', parsed_output: VALID_REPORT });
    const report = await generateScoutReport(client, PAYLOAD);
    expect(report).toEqual(VALID_REPORT);
  });

  it('throws ReportGenerationError("refusal") when stop_reason is refusal', async () => {
    const client = stubClient({ stop_reason: 'refusal', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject(
      new ReportGenerationError('refusal'),
    );
  });

  it('throws ReportGenerationError("truncated") when stop_reason is max_tokens', async () => {
    const client = stubClient({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject(
      new ReportGenerationError('truncated'),
    );
  });

  it('throws ReportGenerationError("unparseable") when parsed_output is null on a normal stop', async () => {
    const client = stubClient({ stop_reason: 'end_turn', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject(
      new ReportGenerationError('unparseable'),
    );
  });
});
