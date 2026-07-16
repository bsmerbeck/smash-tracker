import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

function seedMatch(database: ReturnType<typeof buildTestApp>['database'], overrides = {}) {
  database.seed(`matches/${TEST_UID}`, {
    m1: {
      fighter_id: 1,
      opponent_id: 2,
      time: 1000,
      win: true,
      vodUrl: 'https://youtu.be/abc123',
      vodTimestamps: [{ seconds: 10, note: 'missed punish' }],
      tags: ['practice-friendlies'],
      ...overrides,
    },
  });
}

/**
 * Seeds `count` ACTIVE shares for `uid`: both the `sharesByUser/{uid}`
 * index entry (token string) AND a matching `shareTokens/{token}` record
 * with no `revokedAt` — required so `countActiveShares`'s join actually
 * counts them (a bare `sharesByUser` entry with no token record is treated
 * as inactive/corrupt and skipped, mirroring `listSharesForUser`).
 */
function seedActiveShares(
  database: ReturnType<typeof buildTestApp>['database'],
  uid: string,
  count: number,
) {
  const shares: Record<string, unknown> = {};
  const tokens: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    const token = `${uid}-token-${i}`;
    shares[`s${i}`] = token;
    tokens[token] = { shareId: `s${i}`, ownerUid: uid, permissions: 'view', createdAt: 1000 };
  }
  database.seed(`sharesByUser/${uid}`, shares);
  for (const [token, record] of Object.entries(tokens)) {
    database.seed(`shareTokens/${token}`, record);
  }
}

const REDACTION_ALL_ON = { includeNotes: true, includeTags: true, showDisplayName: false };

describe('POST /api/vod-shares', () => {
  it('creates a share and returns shareId, token, and url', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.shareId).toEqual(expect.any(String));
    expect(body.token).toEqual(expect.any(String));
    expect(body.url).toBe(`http://localhost:5173/s/${body.token}`);
  });

  it('SHARE-01: the snapshot is immutable — editing the source match afterward leaves the share unchanged', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    expect(createResponse.statusCode).toBe(201);
    const { shareId } = createResponse.json();

    // Edit the source match after the share was created.
    seedMatch(database, { win: false, fighter_id: 9 });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/vod-shares',
      headers: authHeader(),
    });
    expect(listResponse.statusCode).toBe(200);
    const row = listResponse.json().find((r: { shareId: string }) => r.shareId === shareId);
    expect(row.result).toBe('win');
    expect(row.fighterId).toBe(1);
  });

  it('redaction toggles gate stored content', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: {
        matchId: 'm1',
        redaction: { includeNotes: false, includeTags: false, showDisplayName: false },
      },
    });

    expect(response.statusCode).toBe(201);
    const { shareId } = response.json();
    const dump = database.dump() as Record<string, unknown>;
    const snapshots = dump.shareSnapshots as Record<string, Record<string, unknown>>;
    const stored = snapshots[shareId]!;
    expect('timestamps' in stored).toBe(false);
    expect('tags' in stored).toBe(false);
    expect(stored.reviewedMomentsCount).toBe(1);
  });

  it('rejects the 101st share with 403', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);
    seedActiveShares(database, TEST_UID, 100);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(403);
  });

  it('CR-01: revoking one of 100 active shares lets the 101st create succeed (cap counts active shares only)', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);
    seedActiveShares(database, TEST_UID, 100);

    // At the cap: rejected, same as the previous test.
    const atCap = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    expect(atCap.statusCode).toBe(403);

    // Revoke one of the 100 via the real route.
    const revokeResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/s0/revoke',
      headers: authHeader(),
    });
    expect(revokeResponse.statusCode).toBe(204);

    // Now under the active cap: the 101st create succeeds.
    const afterRevoke = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    expect(afterRevoke.statusCode).toBe(201);
  });

  it('rejects a match with no vodUrl with a clear non-500 status', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}`, {
      m1: { fighter_id: 1, opponent_id: 2, time: 1000, win: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for a match that does not exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'nope', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/vod-shares', () => {
  it('returns an empty list when the user has no shares', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/vod-shares',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns active and revoked shares with redaction flags, status, and url', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    const { shareId } = createResponse.json();

    await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${shareId}/revoke`,
      headers: authHeader(),
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/vod-shares',
      headers: authHeader(),
    });

    expect(listResponse.statusCode).toBe(200);
    const rows = listResponse.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].shareId).toBe(shareId);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].revokedAt).toEqual(expect.any(Number));
    expect(rows[0].redaction).toEqual({
      includedNotes: true,
      includedTags: true,
      showDisplayName: false,
    });
    expect(rows[0].permissions).toBe('view');
  });

  it('skips a corrupt record instead of failing the whole list', async () => {
    const { app, database } = buildTestApp();
    database.seed(`sharesByUser/${TEST_UID}`, { corrupt: 'token-with-no-record' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/vod-shares',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/vod-shares' });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/vod-shares/:id/revoke', () => {
  it('soft-revokes the share — never removed, revokedAt set', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    const { shareId, token } = createResponse.json();

    const response = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${shareId}/revoke`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    const dump = database.dump() as Record<string, unknown>;
    const snapshots = dump.shareSnapshots as Record<string, unknown>;
    expect(snapshots[shareId]).toBeDefined();
    const tokens = dump.shareTokens as Record<string, Record<string, unknown>>;
    expect(tokens[token]!.revokedAt).toEqual(expect.any(Number));
  });

  it('404s for an unknown share', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/nope/revoke',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'POST', url: '/api/vod-shares/nope/revoke' });

    expect(response.statusCode).toBe(401);
  });
});
