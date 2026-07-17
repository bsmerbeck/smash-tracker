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
  // write-once, first-touch attribution field (FUNNEL-02). The incoming
  // value is the share-page bearer TOKEN (the public snapshot never exposes
  // a shareId), resolved server-side via shareTokens/{token} to the durable
  // shareId before storage (review CR-01).
  describe('referredByShareId (write-once attribution)', () => {
    // Real stamped values are 43-char base64url bearer tokens.
    const REFERRAL_TOKEN = 'a'.repeat(43);
    const OTHER_TOKEN = 'b'.repeat(43);

    function seedShareToken(
      database: ReturnType<typeof buildTestApp>['database'],
      token: string,
      shareId: string,
      extra: Record<string, unknown> = {},
    ) {
      database.seed(`shareTokens/${token}`, {
        shareId,
        ownerUid: 'owner-uid-1',
        permissions: 'view',
        createdAt: 1000,
        ...extra,
      });
    }

    it('resolves a valid token to its shareId and stores the shareId (never the token)', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-1');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-1' } },
      });
    });

    it('never overwrites an existing attribution (write-once), even with a new valid token', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-old');
      seedShareToken(database, OTHER_TOKEN, 'share-new');

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: OTHER_TOKEN },
      });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-old' } },
      });
    });

    it('silently drops an unknown token (200, no field written) — provisioning never fails on a bad referral', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: OTHER_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect(dump.users[TEST_UID]!.email).toBe(TEST_EMAIL);
      expect('referredByShareId' in dump.users[TEST_UID]!).toBe(false);
    });

    it('silently drops a malformed token with RTDB-illegal path characters (200, never a 500)', async () => {
      const { app, database } = buildTestApp();

      // FakeDatabase throws on `.` in a ref path exactly like firebase-admin
      // does — this passing with 200 proves the SHARE_TOKEN_SHAPE guard runs
      // BEFORE any shareTokens/{token} read.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'crafted.path#token$probe' },
      });

      expect(response.statusCode).toBe(200);
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect('referredByShareId' in dump.users[TEST_UID]!).toBe(false);
    });

    it('rejects an oversized referredByShareId with 400 before any lookup (review WR-02)', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'x'.repeat(129) },
      });

      expect(response.statusCode).toBe(400);
      const dump = database.dump() as { users?: Record<string, unknown> };
      expect(dump.users?.[TEST_UID]).toBeUndefined();
    });

    it('still attributes through a REVOKED share token (revocation kills viewing, not attribution)', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-revoked', { revokedAt: 2000 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-revoked' } },
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
