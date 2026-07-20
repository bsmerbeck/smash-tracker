import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  ANALYTICS_MIN_GAMES,
  computeActivationState,
  emitScoutActivated,
  onboardingCausePayload,
  reconcilePlayerActivation,
  VOD_MIN_NOTES,
} from './activation.js';

const UID = 'player-uid-1';
const SESSION_ID = 'session-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function allLedgerRows(database: FakeDatabase): Record<string, unknown>[] {
  const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
  const days = dump.eventLedger ?? {};
  return Object.values(days).flatMap((day) => Object.values(day)) as Record<string, unknown>[];
}

function seedMatch(
  database: FakeDatabase,
  uid: string,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`matches/${uid}/${id}`, {
    fighter_id: 1,
    opponent_id: 2,
    time: Date.now(),
    win: true,
    ...overrides,
  });
}

describe('reconcilePlayerActivation', () => {
  it('emits analytics_activated once the personal library reaches ANALYTICS_MIN_GAMES', async () => {
    const database = new FakeDatabase();
    for (let i = 0; i < ANALYTICS_MIN_GAMES; i += 1) {
      seedMatch(database, UID, `m${i}`);
    }

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventName: 'analytics_activated',
      actorId: UID,
      causationId: UID,
      consentState: 'unknown',
    });
  });

  it('does not emit analytics_activated below the threshold', async () => {
    const database = new FakeDatabase();
    for (let i = 0; i < ANALYTICS_MIN_GAMES - 1; i += 1) {
      seedMatch(database, UID, `m${i}`);
    }

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    expect(allLedgerRows(database)).toHaveLength(0);
  });

  it('emits vod_activated once a personal match has a vodUrl and >= VOD_MIN_NOTES notes', async () => {
    const database = new FakeDatabase();
    seedMatch(database, UID, 'm0', {
      vodUrl: 'https://youtube.com/watch?v=abc',
      vodTimestamps: [
        { seconds: 1, note: 'a' },
        { seconds: 2, note: 'b' },
      ],
    });
    expect(VOD_MIN_NOTES).toBe(2);

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventName: 'vod_activated', causationId: UID });
  });

  it('does not emit vod_activated with fewer than VOD_MIN_NOTES notes', async () => {
    const database = new FakeDatabase();
    seedMatch(database, UID, 'm0', {
      vodUrl: 'https://youtube.com/watch?v=abc',
      vodTimestamps: [{ seconds: 1, note: 'a' }],
    });

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    expect(allLedgerRows(database)).toHaveLength(0);
  });

  it('does not emit vod_activated when vodUrl is present but no notes exist', async () => {
    const database = new FakeDatabase();
    seedMatch(database, UID, 'm0', { vodUrl: 'https://youtube.com/watch?v=abc' });

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    expect(allLedgerRows(database)).toHaveLength(0);
  });

  it('emits tournament_prep_activated once the user has >= 1 tournamentEntries row', async () => {
    const database = new FakeDatabase();
    database.seed(`tournamentEntries/${UID}`, { '987': { eventId: 987 } });

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventName: 'tournament_prep_activated', causationId: UID });
  });

  it('is idempotent — a second reconcile call emits nothing new (once-per-user dedup)', async () => {
    const database = new FakeDatabase();
    for (let i = 0; i < ANALYTICS_MIN_GAMES; i += 1) {
      seedMatch(database, UID, `m${i}`);
    }

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);
    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    expect(allLedgerRows(database)).toHaveLength(1);
  });

  it('stamps causationId = uid (never a per-resource id) and carries onboardingCause when intent is saved', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${UID}/onboardingIntent`, 'coach_clients');
    for (let i = 0; i < ANALYTICS_MIN_GAMES; i += 1) {
      seedMatch(database, UID, `m${i}`);
    }

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    const rows = allLedgerRows(database);
    expect(rows[0]).toMatchObject({
      causationId: UID,
      payload: { onboardingCause: 'coach_clients' },
    });
  });

  it('omits onboardingCause from payload when no intent is saved', async () => {
    const database = new FakeDatabase();
    for (let i = 0; i < ANALYTICS_MIN_GAMES; i += 1) {
      seedMatch(database, UID, `m${i}`);
    }

    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);

    const rows = allLedgerRows(database);
    expect(rows[0]).toMatchObject({ payload: {} });
  });
});

describe('emitScoutActivated', () => {
  it('emits scout_activated once per user (dedup on a second call)', async () => {
    const database = new FakeDatabase();

    await emitScoutActivated(asDatabase(database), UID, SESSION_ID);
    await emitScoutActivated(asDatabase(database), UID, SESSION_ID);

    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventName: 'scout_activated',
      actorId: UID,
      causationId: UID,
    });
  });
});

describe('computeActivationState', () => {
  it('returns false for every kind when nothing has fired', async () => {
    const database = new FakeDatabase();

    const state = await computeActivationState(asDatabase(database), UID);

    expect(state).toEqual({
      analytics: false,
      vod: false,
      tournamentPrep: false,
      scout: false,
    });
  });

  it('reflects the eventDedup markers written by the emit functions above (not a recomputed count)', async () => {
    const database = new FakeDatabase();
    for (let i = 0; i < ANALYTICS_MIN_GAMES; i += 1) {
      seedMatch(database, UID, `m${i}`);
    }
    await reconcilePlayerActivation(asDatabase(database), UID, SESSION_ID);
    await emitScoutActivated(asDatabase(database), UID, SESSION_ID);

    const state = await computeActivationState(asDatabase(database), UID);

    expect(state).toEqual({
      analytics: true,
      vod: false,
      tournamentPrep: false,
      scout: true,
    });
  });
});

describe('onboardingCausePayload', () => {
  it('returns { onboardingCause: "coach_clients" } only when the stored intent is coach_clients', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${UID}/onboardingIntent`, 'coach_clients');

    await expect(onboardingCausePayload(asDatabase(database), UID)).resolves.toEqual({
      onboardingCause: 'coach_clients',
    });
  });

  it('returns {} for any other saved intent', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${UID}/onboardingIntent`, 'scout');

    await expect(onboardingCausePayload(asDatabase(database), UID)).resolves.toEqual({});
  });

  it('returns {} when no intent is saved', async () => {
    const database = new FakeDatabase();

    await expect(onboardingCausePayload(asDatabase(database), UID)).resolves.toEqual({});
  });
});
