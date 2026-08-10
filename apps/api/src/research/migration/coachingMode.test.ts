import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { enableCoachingMode } from './coachingMode.js';

const IZAW_UID = 'izaw-uid-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

describe('enableCoachingMode (Phase 30.1, ACCT-03: silent field-scoped coaching-mode enablement)', () => {
  it('sets coachingModeEnabled=true without touching email or other pre-existing fields', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${IZAW_UID}/email`, 'izaw@example.com');
    database.seed(`users/${IZAW_UID}/onboardingIntent`, 'scout');

    await enableCoachingMode(asDatabase(database), IZAW_UID);

    const dump = database.dump() as Record<string, unknown>;
    const users = dump.users as Record<string, Record<string, unknown>>;
    expect(users[IZAW_UID]).toMatchObject({
      email: 'izaw@example.com',
      onboardingIntent: 'scout',
      coachingModeEnabled: true,
    });
  });

  it('is idempotent — re-running leaves coachingModeEnabled=true and other fields unchanged', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${IZAW_UID}/email`, 'izaw@example.com');

    await enableCoachingMode(asDatabase(database), IZAW_UID);
    await enableCoachingMode(asDatabase(database), IZAW_UID);

    const dump = database.dump() as Record<string, unknown>;
    const users = dump.users as Record<string, Record<string, unknown>>;
    expect(users[IZAW_UID]).toMatchObject({
      email: 'izaw@example.com',
      coachingModeEnabled: true,
    });
  });

  it('rejects a malformed uid BEFORE constructing any ref (no write occurs)', async () => {
    const database = new FakeDatabase();

    await expect(enableCoachingMode(asDatabase(database), 'bad/uid')).rejects.toThrow();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.users ?? {}).toEqual({});
  });
});
