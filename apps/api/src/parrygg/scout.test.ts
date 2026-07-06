import { describe, expect, it, vi } from 'vitest';
import {
  Entrant,
  EventEntrant,
  Game,
  Hierarchy,
  Match,
  MatchContext,
  MatchGame,
  MatchGameParticipant,
  MatchGameSlot,
  MatchState,
  Path,
  PathType,
  Seed,
  Slot,
  Character,
  Stage,
  User,
} from '@parry-gg/client';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb.js';
import { PARRYGG_SSBU_SLUG } from './sync.js';
import type { ParryggClients, ParryggMatchContext, ParryggUserSummary } from './client.js';
import {
  accumulateParryMatchContext,
  buildParryScoutReport,
  parseParryProfileUrl,
  ParryScoutCache,
  resolveParryScoutPlayer,
  scoutParryPlayer,
} from './scout.js';

const MY_USER_ID = '019ce9ba-debd-7e11-84a2-77258f52644e';
const OPPONENT_USER_ID = 'opponent-user-id';

function makeUser(id: string, gamerTag: string): User {
  const user = new User();
  user.setId(id);
  user.setGamerTag(gamerTag);
  return user;
}

function makeEntrant(users: User[]): Entrant {
  const entrant = new Entrant();
  entrant.setId(`entrant-${users[0]?.getId()}`);
  entrant.setUsersList(users);
  return entrant;
}

function makeSeed(id: string, seedNum: number, entrant: Entrant): Seed {
  const seed = new Seed();
  seed.setId(id);
  seed.setSeed(seedNum);
  const eventEntrant = new EventEntrant();
  eventEntrant.setEntrant(entrant);
  eventEntrant.setSeed(seedNum);
  seed.setEventEntrant(eventEntrant);
  return seed;
}

function makeSlot(slotNum: number, seedId: string, score: number): Slot {
  const slot = new Slot();
  slot.setSlot(slotNum);
  slot.setSeedId(seedId);
  slot.setScore(score);
  return slot;
}

function timestamp(seconds: number): Timestamp {
  const ts = new Timestamp();
  ts.setSeconds(seconds);
  return ts;
}

function makeCharacter(slug: string): Character {
  const character = new Character();
  character.setSlug(slug);
  return character;
}

function makeStage(slug: string): Stage {
  const stage = new Stage();
  stage.setSlug(slug);
  return stage;
}

function makeGameSlot(
  slotNum: number,
  userId: string,
  characterSlug: string,
  placement: number,
): MatchGameSlot {
  const gameSlot = new MatchGameSlot();
  gameSlot.setSlot(slotNum);
  gameSlot.setPlacement(placement);
  const participant = new MatchGameParticipant();
  participant.setUserId(userId);
  participant.setCharactersList([makeCharacter(characterSlug)]);
  gameSlot.setParticipantsList([participant]);
  return gameSlot;
}

interface BuildOptions {
  matchState?: MatchState;
  mySlotScore?: number;
  opponentSlotScore?: number;
  gameSlug?: string | null;
  matchGames?: MatchGame[];
  eventName?: string;
  tournamentName?: string;
  eventSlug?: string;
  tournamentSlug?: string;
  opponentGamerTag?: string;
  winnersPlacement?: number;
  losersPlacement?: number;
  teamOpponent?: boolean;
  endedAtSeconds?: number;
}

/** Builds a realistic, fully-populated MatchContext (as `.toObject()`) — mirrors sync.test.ts's factory, extended with slug/placement fields V9-B scouting reads. */
function makeMatchContext(options: BuildOptions = {}): ParryggMatchContext {
  const {
    matchState = MatchState.MATCH_STATE_COMPLETED,
    mySlotScore = 2,
    opponentSlotScore = 1,
    gameSlug = PARRYGG_SSBU_SLUG,
    matchGames = [],
    eventName = 'Ultimate Singles',
    tournamentName = 'Test Weekly 42',
    eventSlug,
    tournamentSlug,
    opponentGamerTag = 'PowPow',
    winnersPlacement,
    losersPlacement,
    teamOpponent = false,
    endedAtSeconds = 1_700_000_000,
  } = options;

  const myUser = makeUser(MY_USER_ID, 'Me');
  const opponentUser = makeUser(OPPONENT_USER_ID, opponentGamerTag);
  const opponentUsers = teamOpponent
    ? [opponentUser, makeUser('teammate-id', 'Teammate')]
    : [opponentUser];

  const mySeedMsg = makeSeed('seed-mine', 8, makeEntrant([myUser]));
  const opponentSeedMsg = makeSeed('seed-opponent', 12, makeEntrant(opponentUsers));

  const match = new Match();
  match.setId('match-111');
  match.setRound(2);
  match.setState(matchState);
  match.setSlotsList([
    makeSlot(0, 'seed-mine', mySlotScore),
    makeSlot(1, 'seed-opponent', opponentSlotScore),
  ]);
  match.setMatchGamesList(matchGames);
  match.setEndedAt(timestamp(endedAtSeconds));
  if (winnersPlacement != null) {
    match.setWinnersPlacement(winnersPlacement);
  }
  if (losersPlacement != null) {
    match.setLosersPlacement(losersPlacement);
  }

  const context = new MatchContext();
  context.setMatch(match);
  context.setSeedsList([mySeedMsg, opponentSeedMsg]);

  if (gameSlug !== null) {
    const game = new Game();
    game.setSlug(gameSlug);
    context.setGame(game);
  }

  const hierarchy = new Hierarchy();
  const tournamentPath = new Path();
  tournamentPath.setType(PathType.PATH_TYPE_TOURNAMENT);
  tournamentPath.setName(tournamentName);
  if (tournamentSlug) {
    tournamentPath.setSlug(tournamentSlug);
  }
  const eventPath = new Path();
  eventPath.setType(PathType.PATH_TYPE_EVENT);
  eventPath.setName(eventName);
  if (eventSlug) {
    eventPath.setSlug(eventSlug);
  }
  hierarchy.setPathsList([tournamentPath, eventPath]);
  context.setHierarchy(hierarchy);

  return context.toObject();
}

describe('parseParryProfileUrl', () => {
  it('parses a bare profile URL', () => {
    expect(parseParryProfileUrl(`https://parry.gg/profile/${MY_USER_ID}`)).toBe(MY_USER_ID);
  });

  it('tolerates missing protocol and a trailing slash', () => {
    expect(parseParryProfileUrl(`parry.gg/profile/${MY_USER_ID}/`)).toBe(MY_USER_ID);
  });

  it('returns null for a non-parry.gg URL', () => {
    expect(parseParryProfileUrl('https://start.gg/user/07dc2239')).toBeNull();
  });

  it('returns null for a parry.gg URL that is not a profile', () => {
    expect(parseParryProfileUrl('https://parry.gg/my-tournament-01931d1c')).toBeNull();
  });

  it('returns null for a bare gamer tag (not a URL at all)', () => {
    expect(parseParryProfileUrl('PowPow')).toBeNull();
  });

  it('returns null when the path segment is not a valid UUID v7', () => {
    expect(parseParryProfileUrl('https://parry.gg/profile/not-a-uuid')).toBeNull();
  });
});

describe('resolveParryScoutPlayer', () => {
  function stubClients(overrides: {
    getUser?: (id: string) => ParryggUserSummary | null;
    search?: ParryggUserSummary[];
  }): ParryggClients {
    return {
      users: {
        getUser: vi.fn(async (request: { getId: () => string }) => {
          const found = overrides.getUser?.(request.getId());
          return {
            getUser: () =>
              found
                ? { toObject: () => ({ id: found.id, gamerTag: found.gamerTag, bioMd: '' }) }
                : undefined,
          };
        }),
        getUsers: vi.fn(async () => ({
          getUsersList: () =>
            (overrides.search ?? []).map((u) => ({ toObject: () => ({ ...u, bioMd: '' }) })),
        })),
      } as unknown as ParryggClients['users'],
      matches: {} as unknown as ParryggClients['matches'],
    };
  }

  it('resolves a profile URL directly via getUser', async () => {
    const clients = stubClients({
      getUser: (id) => (id === MY_USER_ID ? { id: MY_USER_ID, gamerTag: 'Pandem1c' } : null),
    });
    const result = await resolveParryScoutPlayer(
      'key',
      `https://parry.gg/profile/${MY_USER_ID}`,
      clients,
    );
    expect(result).toEqual({ parryUserId: MY_USER_ID, gamerTag: 'Pandem1c' });
  });

  it('resolves a bare UUID directly via getUser', async () => {
    const clients = stubClients({
      getUser: (id) => (id === MY_USER_ID ? { id: MY_USER_ID, gamerTag: 'Pandem1c' } : null),
    });
    const result = await resolveParryScoutPlayer('key', MY_USER_ID, clients);
    expect(result).toEqual({ parryUserId: MY_USER_ID, gamerTag: 'Pandem1c' });
  });

  it('resolves a bare tag via search, taking the best EXACT match', async () => {
    const clients = stubClients({
      search: [
        { id: 'id-1', gamerTag: 'PowPow2' },
        { id: 'id-2', gamerTag: 'PowPow' },
      ],
    });
    const result = await resolveParryScoutPlayer('key', 'PowPow', clients);
    expect(result).toEqual({ parryUserId: 'id-2', gamerTag: 'PowPow' });
  });

  it('is case-insensitive for the exact-tag match', async () => {
    const clients = stubClients({ search: [{ id: 'id-2', gamerTag: 'PowPow' }] });
    const result = await resolveParryScoutPlayer('key', 'powpow', clients);
    expect(result?.parryUserId).toBe('id-2');
  });

  it('returns null when no exact tag match is found among fuzzy candidates', async () => {
    const clients = stubClients({ search: [{ id: 'id-1', gamerTag: 'PowPow2' }] });
    const result = await resolveParryScoutPlayer('key', 'PowPow', clients);
    expect(result).toBeNull();
  });

  it('returns null when a direct id/URL does not resolve to a user', async () => {
    const clients = stubClients({ getUser: () => null });
    const result = await resolveParryScoutPlayer('key', MY_USER_ID, clients);
    expect(result).toBeNull();
  });
});

describe('accumulateParryMatchContext', () => {
  function emptyAcc() {
    return {
      sampledSets: 0,
      sampledGames: 0,
      characters: new Map<number, { games: number; wins: number }>(),
      stages: new Map<number, { games: number; wins: number }>(),
      events: new Map<
        string,
        {
          eventName: string;
          tournamentName?: string;
          placement?: number;
          slug?: string;
          lastSetAt: number;
        }
      >(),
      opponents: new Map<string, number>(),
    };
  }

  it('aggregates characters, stages, events, and opponents from the scouted player perspective', () => {
    const acc = emptyAcc();
    const game = new MatchGame();
    game.setStagesList([makeStage('battlefield')]);
    game.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'mario', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    const context = makeMatchContext({ matchGames: [game] });

    accumulateParryMatchContext(acc, context, MY_USER_ID);

    expect(acc.sampledSets).toBe(1);
    expect(acc.sampledGames).toBe(1);
    expect(acc.characters.get(1)).toEqual({ games: 1, wins: 1 }); // Mario
    expect(acc.opponents.get('PowPow')).toBe(1);
    const event = [...acc.events.values()][0];
    expect(event).toMatchObject({
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
    });
  });

  it('skips matches that are not completed', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({ matchState: MatchState.MATCH_STATE_IN_PROGRESS });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    expect(acc.sampledSets).toBe(0);
  });

  it('skips 0-0 walkovers', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({ mySlotScore: 0, opponentSlotScore: 0 });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    expect(acc.sampledSets).toBe(0);
  });

  it('skips matches with no game identified, and non-SSBU games', () => {
    const acc = emptyAcc();
    accumulateParryMatchContext(acc, makeMatchContext({ gameSlug: null }), MY_USER_ID);
    accumulateParryMatchContext(
      acc,
      makeMatchContext({ gameSlug: 'super-smash-bros-melee' }),
      MY_USER_ID,
    );
    expect(acc.sampledSets).toBe(0);
  });

  it('skips team entrants', () => {
    const acc = emptyAcc();
    accumulateParryMatchContext(acc, makeMatchContext({ teamOpponent: true }), MY_USER_ID);
    expect(acc.sampledSets).toBe(0);
  });

  it('still counts a sampled set with no per-game detail, but contributes no character/stage rows (sparse young data)', () => {
    const acc = emptyAcc();
    accumulateParryMatchContext(acc, makeMatchContext({ matchGames: [] }), MY_USER_ID);
    expect(acc.sampledSets).toBe(1);
    expect(acc.sampledGames).toBe(0);
    expect(acc.characters.size).toBe(0);
    expect(acc.stages.size).toBe(0);
    // Event/opponent are still recorded even with no game detail.
    expect(acc.opponents.get('PowPow')).toBe(1);
  });

  it('groups unmapped characters under fighterId 0', () => {
    const acc = emptyAcc();
    const game = new MatchGame();
    game.setStagesList([makeStage('battlefield')]);
    game.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'totally-unknown-character', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    accumulateParryMatchContext(acc, makeMatchContext({ matchGames: [game] }), MY_USER_ID);
    expect(acc.characters.get(0)).toEqual({ games: 1, wins: 1 });
  });

  it('groups unresolvable stages under stageId 0', () => {
    const acc = emptyAcc();
    const game = new MatchGame();
    game.setStagesList([makeStage('some-brand-new-stage')]);
    game.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'mario', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    accumulateParryMatchContext(acc, makeMatchContext({ matchGames: [game] }), MY_USER_ID);
    expect(acc.stages.get(0)).toEqual({ games: 1, wins: 1 });
  });

  it('captures a tournament+event slug pair when both path types carry one', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({
      tournamentSlug: 'my-tournament-01931d1c',
      eventSlug: 'test',
    });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    const event = [...acc.events.values()][0];
    expect(event?.slug).toBe('my-tournament-01931d1c/test');
  });

  it('omits the slug when only one half of the pair is present', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({ tournamentSlug: 'my-tournament-01931d1c' });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    const event = [...acc.events.values()][0];
    expect(event?.slug).toBeUndefined();
  });

  it('attributes winnersPlacement when I won the match', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({
      mySlotScore: 3,
      opponentSlotScore: 1,
      winnersPlacement: 1,
      losersPlacement: 0,
    });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    const event = [...acc.events.values()][0];
    expect(event?.placement).toBe(1);
  });

  it('attributes losersPlacement when I lost the match', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({
      mySlotScore: 1,
      opponentSlotScore: 3,
      winnersPlacement: 0,
      losersPlacement: 4,
    });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    const event = [...acc.events.values()][0];
    expect(event?.placement).toBe(4);
  });

  it('omits placement when it is 0 (not a meaningful placement match)', () => {
    const acc = emptyAcc();
    const context = makeMatchContext({ winnersPlacement: 0, losersPlacement: 0 });
    accumulateParryMatchContext(acc, context, MY_USER_ID);
    const event = [...acc.events.values()][0];
    expect(event?.placement).toBeUndefined();
  });
});

describe('buildParryScoutReport / scoutParryPlayer', () => {
  const player = { parryUserId: MY_USER_ID, gamerTag: 'Pandem1c' };

  function clientsReturning(contexts: ParryggMatchContext[]): ParryggClients {
    return {
      users: {} as unknown as ParryggClients['users'],
      matches: {
        getMatches: vi.fn(async () => ({
          getMatchesList: () => contexts.map((c) => ({ toObject: () => c })),
        })),
      } as unknown as ParryggClients['matches'],
    };
  }

  it('builds a full ScoutReportData with a parrygg-sourced identity', async () => {
    const game = new MatchGame();
    game.setStagesList([makeStage('battlefield')]);
    game.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'mario', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    const clients = clientsReturning([makeMatchContext({ matchGames: [game] })]);

    const report = await buildParryScoutReport('api-key', player, clients);

    expect(report.player).toEqual({
      source: 'parrygg',
      parryUserId: MY_USER_ID,
      gamerTag: 'Pandem1c',
    });
    expect(report.sampledSets).toBe(1);
    expect(report.characters[0]).toMatchObject({ fighterId: 1, games: 1, wins: 1 });
  });

  it('tolerates empty matchGames everywhere (no character/stage rows, still events + opponents)', async () => {
    const clients = clientsReturning([makeMatchContext({ matchGames: [] })]);
    const report = await buildParryScoutReport('api-key', player, clients);
    expect(report.characters).toEqual([]);
    expect(report.stages).toEqual([]);
    expect(report.recentEvents.length).toBeGreaterThan(0);
    expect(report.commonOpponents.length).toBeGreaterThan(0);
  });

  it('scoutParryPlayer resolves + builds + caches by parryUserId', async () => {
    let getMatchesCalls = 0;
    const clients: ParryggClients = {
      users: {
        getUser: vi.fn(async () => ({
          getUser: () => ({
            toObject: () => ({ id: MY_USER_ID, gamerTag: 'Pandem1c', bioMd: '' }),
          }),
        })),
        getUsers: vi.fn(),
      } as unknown as ParryggClients['users'],
      matches: {
        getMatches: vi.fn(async () => {
          getMatchesCalls += 1;
          return { getMatchesList: () => [] };
        }),
      } as unknown as ParryggClients['matches'],
    };
    const cache = new ParryScoutCache();

    const first = await scoutParryPlayer('key', MY_USER_ID, cache, clients);
    const second = await scoutParryPlayer('key', MY_USER_ID, cache, clients);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(getMatchesCalls).toBe(1); // second call was a cache hit
  });

  it('scoutParryPlayer returns null when the player does not resolve', async () => {
    const clients: ParryggClients = {
      users: {
        getUser: vi.fn(async () => ({ getUser: () => undefined })),
        getUsers: vi.fn(async () => ({ getUsersList: () => [] })),
      } as unknown as ParryggClients['users'],
      matches: { getMatches: vi.fn() } as unknown as ParryggClients['matches'],
    };
    const result = await scoutParryPlayer('key', 'nobody', new ParryScoutCache(), clients);
    expect(result).toBeNull();
  });
});
