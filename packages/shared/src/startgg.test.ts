import { describe, expect, it } from 'vitest';
import {
  isParryggIdentity,
  isStartggIdentity,
  scoutGameSchema,
  scoutIdentityKey,
  scoutPlayerIdentitySchema,
  scoutRecentEventSchema,
  scoutReportDataSchema,
  type ScoutPlayerIdentity,
} from './startgg.js';

describe('scoutPlayerIdentitySchema — V9-B back-compat + parry.gg identity design', () => {
  it('parses a pre-V9-B stored record: numeric id, no source, no parryUserId', () => {
    const legacy = { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' };
    const parsed = scoutPlayerIdentitySchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(isStartggIdentity(parsed)).toBe(true);
    expect(isParryggIdentity(parsed)).toBe(false);
  });

  it('parses an explicit source: startgg record the same way', () => {
    const parsed = scoutPlayerIdentitySchema.parse({
      id: 1802316,
      gamerTag: 'Pandem1c',
      source: 'startgg',
    });
    expect(isStartggIdentity(parsed)).toBe(true);
  });

  it('parses a parrygg identity carrying parryUserId', () => {
    const parsed = scoutPlayerIdentitySchema.parse({
      gamerTag: 'Pandem1c',
      source: 'parrygg',
      parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
    });
    expect(isParryggIdentity(parsed)).toBe(true);
    expect(isStartggIdentity(parsed)).toBe(false);
  });

  it('rejects a parrygg identity missing parryUserId', () => {
    expect(() =>
      scoutPlayerIdentitySchema.parse({ gamerTag: 'Pandem1c', source: 'parrygg' }),
    ).toThrow();
  });

  it('rejects a startgg identity (explicit or implicit) missing a numeric id', () => {
    expect(() => scoutPlayerIdentitySchema.parse({ gamerTag: 'Pandem1c' })).toThrow();
    expect(() =>
      scoutPlayerIdentitySchema.parse({ gamerTag: 'Pandem1c', source: 'startgg' }),
    ).toThrow();
  });
});

describe('scoutIdentityKey', () => {
  it('keys a startgg identity by its numeric id', () => {
    const identity: ScoutPlayerIdentity = { id: 1802316, gamerTag: 'Pandem1c' };
    expect(scoutIdentityKey(identity)).toBe('startgg:1802316');
  });

  it('keys a parrygg identity by its parryUserId, distinct from any startgg id namespace', () => {
    const identity: ScoutPlayerIdentity = {
      gamerTag: 'Pandem1c',
      source: 'parrygg',
      parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
    };
    expect(scoutIdentityKey(identity)).toBe('parrygg:019ce9ba-debd-7e11-84a2-77258f52644e');
  });

  it('never collides a startgg id with a parrygg id that happens to look similar', () => {
    const startgg: ScoutPlayerIdentity = { id: 42, gamerTag: 'A' };
    const parrygg: ScoutPlayerIdentity = { gamerTag: 'B', source: 'parrygg', parryUserId: '42' };
    expect(scoutIdentityKey(startgg)).not.toBe(scoutIdentityKey(parrygg));
  });
});

describe('scoutRecentEventSchema — V9-B slug/source back-compat', () => {
  it('parses a pre-V9-B event with neither slug nor source', () => {
    const legacy = { eventName: 'Ultimate Singles', lastSetAt: 1_700_000_000_000 };
    expect(scoutRecentEventSchema.parse(legacy)).toEqual(legacy);
  });

  it('parses a start.gg event carrying a slug + source', () => {
    const event = {
      eventName: 'Ultimate Singles',
      lastSetAt: 1_700_000_000_000,
      slug: 'tournament/the-big-house-9/event/ultimate-singles',
      source: 'startgg' as const,
    };
    expect(scoutRecentEventSchema.parse(event)).toEqual(event);
  });
});

describe('scoutReportDataSchema — V9-D `games` back-compat', () => {
  const baseReport = {
    player: { id: 1802316, gamerTag: 'Pandem1c' },
    sampledSets: 3,
    sampledGames: 6,
    characters: [{ fighterId: 67, games: 6, wins: 4 }],
    stages: [{ stageId: 1, games: 6, wins: 4 }],
    recentEvents: [],
    commonOpponents: [],
  };

  it('parses a pre-V9-D stored report with no `games` field at all', () => {
    const parsed = scoutReportDataSchema.parse(baseReport);
    expect(parsed.games).toBeUndefined();
  });

  it('parses a V9-D report carrying `games`', () => {
    const game = {
      time: 1_700_000_000_000,
      win: true,
      fighterId: 67,
      opponentFighterId: 41,
      stageId: 1,
      stageName: 'Battlefield',
      opponentTag: 'PowPow',
      eventName: 'Ultimate Singles',
    };
    const parsed = scoutReportDataSchema.parse({ ...baseReport, games: [game] });
    expect(parsed.games).toEqual([game]);
  });

  it('scoutGameSchema tolerates a game with no resolved stage (stageId/stageName both absent)', () => {
    const parsed = scoutGameSchema.parse({
      time: 1_700_000_000_000,
      win: false,
      fighterId: 67,
      opponentFighterId: 0,
      opponentTag: 'PowPow',
    });
    expect(parsed.stageId).toBeUndefined();
    expect(parsed.stageName).toBeUndefined();
    expect(parsed.eventName).toBeUndefined();
  });
});
