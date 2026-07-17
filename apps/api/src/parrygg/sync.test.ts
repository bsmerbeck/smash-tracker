import { describe, expect, it } from 'vitest';
import type { ParryggSyncSummary } from '@smash-tracker/shared';
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
  Seed,
  Slot,
  Character,
  Stage,
  PathType,
  User,
} from '@parry-gg/client';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  gamesFromMatchContext,
  importParryggMatches,
  normalizeOpponentTag,
  PARRYGG_SSBU_SLUG,
} from './sync.js';
import type { ParryggClients, ParryggMatchContext } from './client.js';

const MY_USER_ID = 'my-user-id';
const OPPONENT_USER_ID = 'opponent-user-id';

function emptySummary(): ParryggSyncSummary {
  return {
    matches: 0,
    imported: 0,
    dqOrIncomplete: 0,
    otherGame: 0,
    unknownGame: 0,
    teamEntrants: 0,
    unmappedCharacters: 0,
    unmappedStages: 0,
    setsWithoutGameData: 0,
  };
}

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
  round?: number;
  winnersSide?: boolean;
  grandFinals?: boolean;
  mySlotScore?: number;
  opponentSlotScore?: number;
  gameSlug?: string | null;
  matchGames?: MatchGame[];
  eventName?: string;
  tournamentName?: string;
  eventSlug?: string;
  opponentGamerTag?: string;
  opponentSeed?: number;
  mySeed?: number;
  teamOpponent?: boolean;
}

/** Builds a realistic, fully-populated MatchContext (as `.toObject()`), mirroring the shape parry.gg's GetMatches returns. */
function makeMatchContext(options: BuildOptions = {}): ParryggMatchContext {
  const {
    matchState = MatchState.MATCH_STATE_COMPLETED,
    round = 2,
    winnersSide = false,
    grandFinals = false,
    mySlotScore = 2,
    opponentSlotScore = 1,
    gameSlug = PARRYGG_SSBU_SLUG,
    matchGames = [],
    eventName = 'Ultimate Singles',
    tournamentName = 'Test Weekly 42',
    eventSlug,
    opponentGamerTag = 'PowPow',
    opponentSeed = 12,
    mySeed = 8,
    teamOpponent = false,
  } = options;

  const myUser = makeUser(MY_USER_ID, 'Me');
  const opponentUser = makeUser(OPPONENT_USER_ID, opponentGamerTag);
  const opponentUsers = teamOpponent
    ? [opponentUser, makeUser('teammate-id', 'Teammate')]
    : [opponentUser];

  const mySeedMsg = makeSeed('seed-mine', mySeed, makeEntrant([myUser]));
  const opponentSeedMsg = makeSeed('seed-opponent', opponentSeed, makeEntrant(opponentUsers));

  const match = new Match();
  match.setId('match-111');
  match.setRound(round);
  match.setWinnersSide(winnersSide);
  match.setGrandFinals(grandFinals);
  match.setState(matchState);
  match.setSlotsList([
    makeSlot(0, 'seed-mine', mySlotScore),
    makeSlot(1, 'seed-opponent', opponentSlotScore),
  ]);
  match.setMatchGamesList(matchGames);
  match.setEndedAt(timestamp(1_700_000_000));

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

describe('normalizeOpponentTag', () => {
  it('strips sponsor prefixes and lowercases', () => {
    expect(normalizeOpponentTag('Sponsor | PowPow')).toBe('powpow');
    expect(normalizeOpponentTag('PowPow')).toBe('powpow');
  });

  it('falls back to unknown for empty/missing names', () => {
    expect(normalizeOpponentTag(undefined)).toBe('unknown');
    expect(normalizeOpponentTag('###')).toBe('unknown');
  });
});

describe('gamesFromMatchContext', () => {
  it('skips matches that are not completed', () => {
    const summary = emptySummary();
    const context = makeMatchContext({ matchState: MatchState.MATCH_STATE_IN_PROGRESS });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toEqual([]);
    expect(summary.dqOrIncomplete).toBe(1);
  });

  it('skips 0-0 walkovers', () => {
    const summary = emptySummary();
    const context = makeMatchContext({ mySlotScore: 0, opponentSlotScore: 0 });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toEqual([]);
    expect(summary.dqOrIncomplete).toBe(1);
  });

  it('skips matches with no game identified at all, counted as unknownGame', () => {
    const summary = emptySummary();
    const context = makeMatchContext({ gameSlug: null });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toEqual([]);
    expect(summary.unknownGame).toBe(1);
    expect(summary.matches).toBe(0);
  });

  it('skips matches for a different (identified) game, counted as otherGame', () => {
    const summary = emptySummary();
    const context = makeMatchContext({ gameSlug: 'super-smash-bros-melee' });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toEqual([]);
    expect(summary.otherGame).toBe(1);
    expect(summary.matches).toBe(0);
  });

  it('skips team entrants (singles only for v1)', () => {
    const summary = emptySummary();
    const context = makeMatchContext({ teamOpponent: true });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toEqual([]);
    expect(summary.teamEntrants).toBe(1);
    expect(summary.matches).toBe(1);
  });

  it('synthesizes per-game records from slot scores when matchGamesList is empty', () => {
    const summary = emptySummary();
    const context = makeMatchContext({
      mySlotScore: 2,
      opponentSlotScore: 1,
      round: 2,
      winnersSide: false,
    });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);

    expect(summary.setsWithoutGameData).toBe(1);
    expect(games).toHaveLength(3);
    expect(games.map((g) => g.record.win)).toEqual([true, true, false]);
    for (const game of games) {
      expect(game.record).toMatchObject({
        fighter_id: 0,
        opponent_id: 0,
        map: { id: 0, name: 'unknown' },
        source: 'parrygg',
        opponent: 'powpow',
        eventName: 'Ultimate Singles',
        tournamentName: 'Test Weekly 42',
        roundText: 'Losers Round 2',
        bracketRound: -2,
        opponentSeed: 12,
      });
    }
    expect(games[0]?.key).toBe('pgg-match-111-g1');
    expect(games[2]?.key).toBe('pgg-match-111-g3');
  });

  it('labels grand finals distinctly from a numbered round', () => {
    const summary = emptySummary();
    const context = makeMatchContext({ grandFinals: true, winnersSide: true, round: 1 });
    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games[0]?.record.roundText).toBe('Grand Finals');
    expect(games[0]?.record.bracketRound).toBe(1);
  });

  it('imports fully-detailed games with character/stage mapping and per-game win attribution', () => {
    const summary = emptySummary();
    const matchGames = [
      (() => {
        const game = new MatchGame();
        game.setStagesList([makeStage('battlefield')]);
        game.setSlotsList([
          makeGameSlot(0, MY_USER_ID, 'mario', 1),
          makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
        ]);
        return game;
      })(),
      (() => {
        const game = new MatchGame();
        game.setStagesList([makeStage('pokemon-stadium-2')]);
        game.setSlotsList([
          makeGameSlot(0, MY_USER_ID, 'mario', 2),
          makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 1),
        ]);
        return game;
      })(),
    ];
    const context = makeMatchContext({ matchGames });

    const games = gamesFromMatchContext(context, MY_USER_ID, summary);

    expect(games).toHaveLength(2);
    expect(games[0]?.record).toMatchObject({
      fighter_id: 1, // Mario
      opponent_id: 41, // Sonic
      map: { name: 'Battlefield' },
      win: true,
      source: 'parrygg',
      externalId: 'pgg-match-111-g1',
    });
    expect(games[1]?.record).toMatchObject({
      fighter_id: 1,
      opponent_id: 41,
      win: false,
    });
    expect(summary.unmappedCharacters).toBe(0);
    expect(summary.unmappedStages).toBe(0);
    expect(summary.setsWithoutGameData).toBe(0);
  });

  it('skips a game with an unmapped character, counting it', () => {
    const summary = emptySummary();
    const game = new MatchGame();
    game.setStagesList([makeStage('battlefield')]);
    game.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'totally-unknown-character', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    const context = makeMatchContext({ matchGames: [game] });

    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toEqual([]);
    expect(summary.unmappedCharacters).toBe(1);
  });

  it('imports with the unknown-stage sentinel when the stage slug is unrecognized, counting it', () => {
    const summary = emptySummary();
    const game = new MatchGame();
    game.setStagesList([makeStage('some-brand-new-stage')]);
    game.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'mario', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    const context = makeMatchContext({ matchGames: [game] });

    const games = gamesFromMatchContext(context, MY_USER_ID, summary);
    expect(games).toHaveLength(1);
    expect(games[0]?.record.map).toEqual({ id: 0, name: 'unknown' });
    expect(summary.unmappedStages).toBe(1);
  });
});

describe('importParryggMatches', () => {
  const PARRY_USER_ID = MY_USER_ID;

  function clientsReturning(contexts: ParryggMatchContext[]): ParryggClients {
    return {
      users: {} as ParryggClients['users'],
      matches: {
        getMatches: async () => ({
          getMatchesList: () => contexts.map((c) => ({ toObject: () => c })),
        }),
      } as unknown as ParryggClients['matches'],
    };
  }

  it('writes idempotent match + opponent records and stamps lastSyncAt', async () => {
    const database = new FakeDatabase();
    const context = makeMatchContext();
    const clients = clientsReturning([context]);

    const summary = await importParryggMatches(
      database as never,
      'uid-1',
      PARRY_USER_ID,
      'api-key',
      clients,
    );

    expect(summary.imported).toBeGreaterThan(0);
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(
      Object.keys(tree['matches']?.['uid-1'] as object).some((k) =>
        k.startsWith('pgg-match-111-g'),
      ),
    ).toBe(true);
    expect(tree['opponents']?.['uid-1']).toMatchObject({ powpow: true });
    expect(typeof tree['parryggLinks']?.['uid-1']).toBe('object');
    expect((tree['parryggLinks']?.['uid-1'] as Record<string, unknown>)?.lastSyncAt).toEqual(
      expect.any(Number),
    );
  });

  it('does not double count on re-sync (same keys overwrite in place)', async () => {
    const database = new FakeDatabase();
    const context = makeMatchContext();
    const clients = clientsReturning([context, context]);

    const summary = await importParryggMatches(
      database as never,
      'uid-1',
      PARRY_USER_ID,
      'api-key',
      clients,
    );
    // Same match appears "twice" (simulating pagination overlap) but the
    // stable key dedupes it — imported counts unique keys only once.
    expect(summary.imported).toBe(3);
  });

  it('produces a zeroed summary and no writes when there is nothing importable', async () => {
    const database = new FakeDatabase();
    const clients = clientsReturning([]);

    const summary = await importParryggMatches(
      database as never,
      'uid-1',
      PARRY_USER_ID,
      'api-key',
      clients,
    );
    expect(summary.imported).toBe(0);
    const tree = database.dump() as Record<string, unknown>;
    expect(tree['matches']).toBeUndefined();
  });

  it('writes a tournamentEntries registry record for an importable match with an event slug + user seed', async () => {
    const database = new FakeDatabase();
    const context = makeMatchContext({
      eventSlug: 'tournament/test-weekly-42/event/ultimate-singles',
      mySeed: 8,
    });
    const clients = clientsReturning([context]);

    await importParryggMatches(database as never, 'uid-1', PARRY_USER_ID, 'api-key', clients);

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown> | undefined;
    expect(registry).toBeDefined();
    const entryKey = 'pgg-tournamenttest-weekly-42eventultimate-singles';
    const record = registry?.[entryKey] as Record<string, unknown> | undefined;
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      source: 'parrygg',
      entryKey,
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
      seed: 8,
    });
    expect((record?.setsPlayed as number) >= 1).toBe(true);
  });

  it('omits the seed key entirely when the user has no seed (never writes null)', async () => {
    const database = new FakeDatabase();
    const context = makeMatchContext({
      eventSlug: 'tournament/test-weekly-42/event/ultimate-singles',
      mySeed: 0,
    });
    const clients = clientsReturning([context]);

    await importParryggMatches(database as never, 'uid-1', PARRY_USER_ID, 'api-key', clients);

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    const entryKey = 'pgg-tournamenttest-weekly-42eventultimate-singles';
    const record = registry[entryKey] as Record<string, unknown>;
    expect(record).toBeDefined();
    expect('seed' in record).toBe(false);
    for (const value of Object.values(record)) {
      expect(value).not.toBeNull();
    }
  });

  it('is idempotent — re-syncing the same context overwrites the registry entry in place', async () => {
    const database = new FakeDatabase();
    const context = makeMatchContext({
      eventSlug: 'tournament/test-weekly-42/event/ultimate-singles',
      mySeed: 8,
    });
    const clients = clientsReturning([context]);

    await importParryggMatches(database as never, 'uid-1', PARRY_USER_ID, 'api-key', clients);
    await importParryggMatches(database as never, 'uid-1', PARRY_USER_ID, 'api-key', clients);

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(registry)).toHaveLength(1);
  });

  // Review WR-07: a completed, singles, SSBU set must count toward the
  // registry even when every one of its games is skipped (e.g. unmapped
  // characters) — mirroring start.gg's accumulateRegistry, which runs
  // unconditionally per set.
  it('counts a completed set toward setsPlayed even when all its games have unmapped characters', async () => {
    const database = new FakeDatabase();
    const unmappedGame = new MatchGame();
    unmappedGame.setStagesList([makeStage('battlefield')]);
    unmappedGame.setSlotsList([
      makeGameSlot(0, MY_USER_ID, 'totally-unknown-character', 1),
      makeGameSlot(1, OPPONENT_USER_ID, 'sonic', 2),
    ]);
    const context = makeMatchContext({
      eventSlug: 'tournament/test-weekly-42/event/ultimate-singles',
      matchGames: [unmappedGame],
    });
    const clients = clientsReturning([context]);

    const summary = await importParryggMatches(
      database as never,
      'uid-1',
      PARRY_USER_ID,
      'api-key',
      clients,
    );

    // No importable games…
    expect(summary.imported).toBe(0);
    expect(summary.unmappedCharacters).toBe(1);
    // …but the completed set still registers.
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown> | undefined;
    const record = registry?.['pgg-tournamenttest-weekly-42eventultimate-singles'] as
      Record<string, unknown> | undefined;
    expect(record).toBeDefined();
    expect(record?.setsPlayed).toBe(1);
  });

  it('falls back to a sanitized eventName|tournamentName composite key when no event slug exists', async () => {
    const database = new FakeDatabase();
    const context = makeMatchContext({ mySeed: 8 });
    const clients = clientsReturning([context]);

    await importParryggMatches(database as never, 'uid-1', PARRY_USER_ID, 'api-key', clients);

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(registry)).toHaveLength(1);
    const [entryKey] = Object.keys(registry);
    expect(entryKey?.startsWith('pgg-')).toBe(true);
  });
});
