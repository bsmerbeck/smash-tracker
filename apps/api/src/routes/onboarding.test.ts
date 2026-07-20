import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import { emitScoutActivated } from '../onboarding/activation.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

describe('GET /api/onboarding/progress', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/onboarding/progress' });

    expect(response.statusCode).toBe(401);
  });

  it('returns all-false when nothing has fired yet', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/progress',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      analytics: false,
      vod: false,
      tournamentPrep: false,
      scout: false,
    });
  });

  it('reflects the eventDedup markers for the authenticated user only (never a subject-resolved target)', async () => {
    const { app, database } = buildTestApp();
    await emitScoutActivated(asDatabase(database), TEST_UID, 'session-1');

    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/progress',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ scout: true, analytics: false });
  });
});
