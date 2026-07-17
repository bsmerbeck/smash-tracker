import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_EMAIL, TEST_UID } from '../test-support/testApp.js';

describe('PUT /api/users/me', () => {
  it('upserts the user node from the verified token email', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ uid: TEST_UID, email: TEST_EMAIL });
    expect(database.dump()).toMatchObject({
      users: { [TEST_UID]: { email: TEST_EMAIL } },
    });
  });

  it('is idempotent when called twice', async () => {
    const { app } = buildTestApp();

    await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
    const second = await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ uid: TEST_UID, email: TEST_EMAIL });
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'PUT', url: '/api/users/me' });

    expect(response.statusCode).toBe(401);
  });

  // Phase 7 (Recap Cards & Share-Loop Analytics): referredByShareId is a
  // write-once, first-touch attribution field (FUNNEL-02).
  describe('referredByShareId (write-once attribution)', () => {
    it('stores referredByShareId for a brand-new profile', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'abc' },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'abc' } },
      });
    });

    it('never overwrites an existing referredByShareId (write-once)', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'old' },
      });

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'new' },
      });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'old' } },
      });
    });

    it('still upserts the email with no body (backward compatible with the zero-arg call)', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ uid: TEST_UID, email: TEST_EMAIL });
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect(dump.users[TEST_UID]!.email).toBe(TEST_EMAIL);
      expect('referredByShareId' in dump.users[TEST_UID]!).toBe(false);
    });
  });
});

describe('GET /api/users/me', () => {
  it('returns 404 when the user has not been upserted yet', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns the profile with fighter selections after upsert', async () => {
    const { app, database } = buildTestApp();

    await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
    database.seed(`primaryFighters/${TEST_UID}`, [1, 2]);
    database.seed(`secondaryFighters/${TEST_UID}`, [3]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      uid: TEST_UID,
      email: TEST_EMAIL,
      fighters: { primary: [1, 2], secondary: [3] },
    });
  });
});

describe('GET/PUT /api/users/me/fighters', () => {
  it('returns empty arrays when nothing has been set', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/fighters',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ primary: [], secondary: [] });
  });

  it('sets and reads back primary/secondary fighter ids', async () => {
    const { app } = buildTestApp();

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/api/users/me/fighters',
      headers: authHeader(),
      payload: { primary: [1, 8, 41], secondary: [12] },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({ primary: [1, 8, 41], secondary: [12] });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/users/me/fighters',
      headers: authHeader(),
    });

    expect(getResponse.json()).toEqual({ primary: [1, 8, 41], secondary: [12] });
  });

  it('rejects a body with non-numeric fighter ids', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/me/fighters',
      headers: authHeader(),
      payload: { primary: ['mario'], secondary: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400 });
  });
});
