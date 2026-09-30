import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import {
  Entrant,
  EventEntrant,
  Game,
  Hierarchy,
  Match,
  MatchContext,
  MatchState,
  Path,
  PathType,
  Seed,
  Slot,
  User,
} from '@parry-gg/client';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb.js';
import {
  startFakeRtdbServer,
  type FakeRtdbServer,
  type WireWriteKind,
} from '../test-support/fakeRtdbServer.js';
import { FakeAuth } from '../test-support/fakeAuth.js';
import { buildApp } from '../app.js';
import { importPlayerMatches } from '../startgg/sync.js';
import type { StartggSet } from '../startgg/client.js';
import { importParryggMatches, PARRYGG_SSBU_SLUG } from '../parrygg/sync.js';
import type { ParryggClients, ParryggMatchContext } from '../parrygg/client.js';

// ---------------------------------------------------------------------------
// 39.2 code review R2-WR-01: the per-event registry transactions against the
// REAL `firebase-admin` SDK, over the repo's RTDB wire fake. In the SDK every
// `set`/`remove` aborts the queued transactions at the written path, its
// ancestors and its descendants; a SENT one fails with `Error('set')` on the
// server's reply. FakeDatabase does not model that queue, so only the wire
// can show it. The server's `defer` hook holds one transaction's reply open
// (the client keeps it SENT) while another request from the SAME process
// lands — exactly a tier/ruleset PATCH served while a sync commits. Every
// verdict is read from the SERVER's state.
// ---------------------------------------------------------------------------

const UID = 'u1';
const TOKEN = 'wire-token';
const PLAYER_ID = 1802316;
const EMULATOR_HOST_VAR = 'FIREBASE_DATABASE_EMULATOR_HOST';
/** How long a deferred reply waits for the competing write before it is answered anyway. */
const DEFER_FALLBACK_MS = 1_000;
const TEST_TIMEOUT_MS = 30_000;

const TIER_MAJOR = { contractVersion: 1, tier: 'major', setAtMs: 5 };
const RULESET = { contractVersion: 1, dsr: 'none' };

let appCounter = 0;
const openApps: App[] = [];
let server: FakeRtdbServer | null = null;
const previousEmulatorHost = process.env[EMULATOR_HOST_VAR];

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await deleteApp(app);
  }
  await server?.close();
  server = null;
  if (previousEmulatorHost === undefined) {
    delete process.env[EMULATOR_HOST_VAR];
  } else {
    process.env[EMULATOR_HOST_VAR] = previousEmulatorHost;
  }
});

/** Starts the wire server, connects one SDK client (one process) and builds the API on it. */
async function setup(seed: Record<string, unknown>) {
  const fake = await startFakeRtdbServer(seed);
  server = fake;
  process.env[EMULATOR_HOST_VAR] = `127.0.0.1:${fake.port}`;
  appCounter += 1;
  const sdkApp = initializeApp(
    { projectId: 'wire-test', databaseURL: 'https://wire-test-default-rtdb.firebaseio.com' },
    `override-wire-${appCounter}`,
  );
  openApps.push(sdkApp);
  const database = getDatabase(sdkApp);
  await database.ref('warm').get();
  const auth = new FakeAuth();
  auth.registerToken(TOKEN, { uid: UID, email: 'wire@example.test' });
  const api = buildApp({
    firebase: { app: sdkApp, auth: auth as unknown as Auth, database },
    logger: false,
  });
  return { fake, database, api };
}

function bare(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * Holds the reply to the FIRST transaction the client sends for `entryPath`,
 * runs `onHeld` while it is held (the client still has it SENT), and answers it
 * once a plain write lands under `releaseOnPutUnder` — the old clear's child
 * `.remove()` — or after DEFER_FALLBACK_MS (a clear that queues behind the
 * transaction never reaches the server while it is held).
 */
function deferFirstTx(
  fake: FakeRtdbServer,
  entryPath: string,
  releaseOnPutUnder: string,
  onHeld: () => void,
  times = 1,
): void {
  let held = 0;
  let release: (() => void) | null = null;
  fake.beforeWrite = (kind: WireWriteKind, path: string) => {
    if (kind === 'put' && bare(path).startsWith(releaseOnPutUnder)) {
      release?.();
    }
  };
  fake.defer = (kind, path) => {
    if (kind !== 'tx' || bare(path) !== entryPath || held >= times) {
      return null;
    }
    held += 1;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), DEFER_FALLBACK_MS);
      release = () => {
        clearTimeout(timer);
        release = null;
        resolve();
      };
      onHeld();
    });
  };
}

// ---- start.gg fixtures ------------------------------------------------------

function makeSet(eventId: number, setId: number): StartggSet {
  return {
    id: setId,
    completedAt: 1_700_000_000,
    fullRoundText: 'Losers Round 2',
    round: -2,
    displayScore: '2-1',
    totalGames: 1,
    event: {
      id: eventId,
      name: 'Ultimate Singles',
      isOnline: true,
      numEntrants: 512,
      videogame: { id: 1386 },
      tournament: { name: `Test Weekly ${eventId}` },
    },
    slots: [
      {
        entrant: {
          id: 1,
          name: 'Me',
          participants: [{ player: { id: PLAYER_ID } }],
          seeds: [{ seedNum: 4 }],
          standing: { placement: 3 },
        },
      },
      {
        entrant: {
          id: 2,
          name: 'PowPow',
          participants: [{ player: { id: 999, gamerTag: 'PowPow' }, user: { slug: 'user/x' } }],
          seeds: [{ seedNum: 1 }],
          standing: { placement: 1 },
        },
      },
    ],
    games: [
      {
        winnerId: 1,
        stage: { id: 311, name: 'Battlefield' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
        entrant1Score: 3,
        entrant2Score: 0,
      },
    ],
  } as StartggSet;
}

function startggFetch(sets: StartggSet[]): typeof fetch {
  return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('PlayerSets')) {
      return new Response(
        JSON.stringify({
          data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
        }),
      );
    }
    return new Response('no details', { status: 500 });
  }) as typeof fetch;
}

// ---- parry.gg fixtures ------------------------------------------------------

const PARRY_USER_ID = 'my-user-id';
const PARRY_EVENT_SLUG = 'weekly-42-singles';
const PARRY_ENTRY_KEY = `pgg-${PARRY_EVENT_SLUG}`;

function parryUser(id: string, tag: string): User {
  const user = new User();
  user.setId(id);
  user.setGamerTag(tag);
  return user;
}

function parrySeed(id: string, seedNum: number, user: User): Seed {
  const entrant = new Entrant();
  entrant.setId(`entrant-${user.getId()}`);
  entrant.setUsersList([user]);
  const eventEntrant = new EventEntrant();
  eventEntrant.setEntrant(entrant);
  eventEntrant.setSeed(seedNum);
  const seed = new Seed();
  seed.setId(id);
  seed.setSeed(seedNum);
  seed.setEventEntrant(eventEntrant);
  return seed;
}

function parrySlot(slotNum: number, seedId: string, score: number): Slot {
  const slot = new Slot();
  slot.setSlot(slotNum);
  slot.setSeedId(seedId);
  slot.setScore(score);
  return slot;
}

function parryContext(): ParryggMatchContext {
  const match = new Match();
  match.setId('match-111');
  match.setRound(2);
  match.setWinnersSide(false);
  match.setGrandFinals(false);
  match.setState(MatchState.MATCH_STATE_COMPLETED);
  match.setSlotsList([parrySlot(0, 'seed-mine', 2), parrySlot(1, 'seed-opponent', 1)]);
  match.setMatchGamesList([]);
  const endedAt = new Timestamp();
  endedAt.setSeconds(1_700_000_000);
  match.setEndedAt(endedAt);

  const context = new MatchContext();
  context.setMatch(match);
  context.setSeedsList([
    parrySeed('seed-mine', 8, parryUser(PARRY_USER_ID, 'Me')),
    parrySeed('seed-opponent', 12, parryUser('opponent-user-id', 'PowPow')),
  ]);
  const game = new Game();
  game.setSlug(PARRYGG_SSBU_SLUG);
  context.setGame(game);

  const tournamentPath = new Path();
  tournamentPath.setType(PathType.PATH_TYPE_TOURNAMENT);
  tournamentPath.setName('Test Weekly 42');
  const eventPath = new Path();
  eventPath.setType(PathType.PATH_TYPE_EVENT);
  eventPath.setName('Ultimate Singles');
  eventPath.setSlug(PARRY_EVENT_SLUG);
  const hierarchy = new Hierarchy();
  hierarchy.setPathsList([tournamentPath, eventPath]);
  context.setHierarchy(hierarchy);
  return context.toObject();
}

function parryClients(contexts: ParryggMatchContext[]): ParryggClients {
  return {
    users: {} as ParryggClients['users'],
    matches: {
      getMatches: async () => ({
        getMatchesList: () => contexts.map((c) => ({ toObject: () => c })),
      }),
    } as unknown as ParryggClients['matches'],
  };
}

function row(fake: FakeRtdbServer, entryKey: string): Record<string, unknown> {
  return (fake.get(`tournamentEntries/${UID}/${entryKey}`) ?? {}) as Record<string, unknown>;
}

describe('override clears queue behind a sync commit instead of aborting it (R2-WR-01)', () => {
  it(
    'start.gg: a tier CLEAR served mid-commit leaves the sync resolved, the row rebuilt and the tier cleared',
    async () => {
      const { fake, database, api } = await setup({
        tournamentEntries: {
          [UID]: {
            '987': {
              eventId: 987,
              eventName: 'Ultimate Singles',
              firstSetAt: 1,
              lastSetAt: 2,
              setsPlayed: 1,
              tierOverride: TIER_MAJOR,
            },
          },
        },
      });
      let patch: Promise<{ statusCode: number; body: string }> | null = null;
      deferFirstTx(fake, `tournamentEntries/${UID}/987`, `tournamentEntries/${UID}/987/`, () => {
        patch = api.inject({
          method: 'PATCH',
          url: '/api/tournaments/987/tier',
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { tierOverride: null },
        });
      });

      const outcome = await importPlayerMatches(
        database,
        UID,
        PLAYER_ID,
        'tok',
        startggFetch([makeSet(987, 111)]),
        { warn: vi.fn() },
      ).then(
        () => 'resolved',
        (error: Error) => `rejected: ${error.message}`,
      );
      expect(patch, 'the clear never fired').not.toBeNull();
      const response = await patch!;

      expect(outcome, fake.log.join('\n')).toBe('resolved');
      expect(response.statusCode, response.body).toBe(200);
      const stored = row(fake, '987');
      expect(stored['numEntrants'], fake.log.join('\n')).toBe(512);
      expect(stored).not.toHaveProperty('tierOverride');
      expect(fake.get(`startggLinks/${UID}/lastSyncAt`)).toEqual(expect.any(Number));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'parry.gg: a ruleset CLEAR served mid-commit leaves the sync resolved, the row rebuilt and the ruleset cleared',
    async () => {
      const { fake, database, api } = await setup({
        tournamentEntries: {
          [UID]: {
            [PARRY_ENTRY_KEY]: {
              eventName: 'Ultimate Singles',
              firstSetAt: 1,
              lastSetAt: 2,
              setsPlayed: 1,
              source: 'parrygg',
              entryKey: PARRY_ENTRY_KEY,
              rulesetOverride: RULESET,
            },
          },
        },
      });
      const entryPath = `tournamentEntries/${UID}/${PARRY_ENTRY_KEY}`;
      let patch: Promise<{ statusCode: number; body: string }> | null = null;
      deferFirstTx(fake, entryPath, `${entryPath}/`, () => {
        patch = api.inject({
          method: 'PATCH',
          url: `/api/tournaments/${PARRY_ENTRY_KEY}/ruleset`,
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { rulesetOverride: null },
        });
      });

      const outcome = await importParryggMatches(
        database,
        UID,
        PARRY_USER_ID,
        'api-key',
        parryClients([parryContext()]),
        { warn: vi.fn() },
      ).then(
        () => 'resolved',
        (error: Error) => `rejected: ${error.message}`,
      );
      expect(patch, 'the clear never fired').not.toBeNull();
      const response = await patch!;

      expect(outcome, fake.log.join('\n')).toBe('resolved');
      expect(response.statusCode, response.body).toBe(200);
      const stored = row(fake, PARRY_ENTRY_KEY);
      expect(stored['lastSetAt'], fake.log.join('\n')).toBe(1_700_000_000_000);
      expect(stored).not.toHaveProperty('rulesetOverride');
      expect(fake.get(`parryggLinks/${UID}/lastSyncAt`)).toEqual(expect.any(Number));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a ruleset CLEAR served while a tier SET is in flight leaves both PATCHes answered 200 and both applied',
    async () => {
      const { fake, api } = await setup({
        tournamentEntries: {
          [UID]: {
            '987': {
              eventId: 987,
              eventName: 'Ultimate Singles',
              firstSetAt: 1,
              lastSetAt: 2,
              setsPlayed: 1,
              rulesetOverride: RULESET,
            },
          },
        },
      });
      let clear: Promise<{ statusCode: number; body: string }> | null = null;
      deferFirstTx(fake, `tournamentEntries/${UID}/987`, `tournamentEntries/${UID}/987/`, () => {
        clear = api.inject({
          method: 'PATCH',
          url: '/api/tournaments/987/ruleset',
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { rulesetOverride: null },
        });
      });

      const set = await api.inject({
        method: 'PATCH',
        url: '/api/tournaments/987/tier',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { tierOverride: { tier: 'major' } },
      });
      expect(clear, 'the clear never fired').not.toBeNull();
      const cleared = await clear!;

      expect(set.statusCode, `${set.body}\n${fake.log.join('\n')}`).toBe(200);
      expect(cleared.statusCode, cleared.body).toBe(200);
      const stored = row(fake, '987');
      expect(stored['tierOverride'], fake.log.join('\n')).toMatchObject({ tier: 'major' });
      expect(stored).not.toHaveProperty('rulesetOverride');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a sync survives an entry transaction the SDK aborts (R2-WR-01)', () => {
  it(
    'start.gg: an entry aborted once by a same-process child write is retried and committed',
    async () => {
      const { fake, database } = await setup({
        tournamentEntries: {
          [UID]: {
            '987': {
              eventId: 987,
              eventName: 'Ultimate Singles',
              firstSetAt: 1,
              lastSetAt: 2,
              setsPlayed: 1,
              tierOverride: TIER_MAJOR,
            },
          },
        },
      });
      // A plain child write from this process (any writer that is not a
      // transaction) while the entry's transaction is SENT: the SDK aborts it.
      deferFirstTx(fake, `tournamentEntries/${UID}/987`, `tournamentEntries/${UID}/987/`, () => {
        void database.ref(`tournamentEntries/${UID}/987/tierOverride`).remove();
      });

      const summary = await importPlayerMatches(
        database,
        UID,
        PLAYER_ID,
        'tok',
        startggFetch([makeSet(987, 111)]),
        { warn: vi.fn() },
      );

      expect(summary).not.toHaveProperty('registryEntriesFailed');
      const stored = row(fake, '987');
      expect(stored['numEntrants'], fake.log.join('\n')).toBe(512);
      expect(stored).not.toHaveProperty('tierOverride');
      expect(fake.get(`startggLinks/${UID}/lastSyncAt`)).toEqual(expect.any(Number));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'start.gg: an entry that still fails after its retry is reported, while every other entry, lastSyncAt and the summary commit',
    async () => {
      const { fake, database } = await setup({
        tournamentEntries: {
          [UID]: {
            '987': {
              eventId: 987,
              eventName: 'Ultimate Singles',
              firstSetAt: 1,
              lastSetAt: 2,
              setsPlayed: 1,
              tierOverride: TIER_MAJOR,
            },
          },
        },
      });
      // Abort the entry's first transaction AND its retry.
      deferFirstTx(
        fake,
        `tournamentEntries/${UID}/987`,
        `tournamentEntries/${UID}/987/`,
        () => {
          void database.ref(`tournamentEntries/${UID}/987/tierOverride`).remove();
        },
        2,
      );
      const warn = vi.fn();

      const summary = await importPlayerMatches(
        database,
        UID,
        PLAYER_ID,
        'tok',
        startggFetch([makeSet(987, 111), makeSet(988, 112)]),
        { warn },
      );

      // The route answers 200 with the summary: the failed entry is counted,
      // never hidden behind a 500 while the rest of the sync committed.
      expect(summary.registryEntriesFailed).toBe(1);
      expect(summary.imported).toBe(2);
      expect(row(fake, '988')['numEntrants'], fake.log.join('\n')).toBe(512);
      expect(row(fake, '987')).not.toHaveProperty('numEntrants');
      expect(fake.get(`startggLinks/${UID}/lastSyncAt`)).toEqual(expect.any(Number));
      // Logged by entry key and error kind only — never an override value.
      const commitWarnings = warn.mock.calls.filter(([, message]) =>
        String(message).includes('did not commit'),
      );
      expect(commitWarnings).toHaveLength(1);
      expect(JSON.stringify(commitWarnings[0]![0])).toContain('987');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('major');
    },
    TEST_TIMEOUT_MS,
  );
});
