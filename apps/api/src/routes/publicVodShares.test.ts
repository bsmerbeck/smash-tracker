import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

const TOKEN = 'a-valid-token';
const SHARE_ID = 'share-1';

function seedActiveShare(
  database: ReturnType<typeof buildTestApp>['database'],
  overrides: { token?: string; shareId?: string; revokedAt?: number } = {},
) {
  const token = overrides.token ?? TOKEN;
  const shareId = overrides.shareId ?? SHARE_ID;

  database.seed(`shareTokens/${token}`, {
    shareId,
    ownerUid: 'owner-uid',
    permissions: 'view',
    createdAt: 1000,
    ...(overrides.revokedAt !== undefined ? { revokedAt: overrides.revokedAt } : {}),
  });
  database.seed(`shareSnapshots/${shareId}`, {
    uid: 'owner-uid',
    matchId: 'match-1',
    createdAt: 1000,
    result: 'win',
    fighterId: 1,
    opponentFighterId: 2,
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    reviewedMomentsCount: 2,
    redaction: { includedNotes: false, includedTags: false, showDisplayName: false },
  });

  return { token, shareId };
}

describe('GET /api/vod-shares/:token', () => {
  it('returns 200 with a redacted public snapshot (no uid/matchId) and Cache-Control: no-store for an active token', async () => {
    const { app, database } = buildTestApp();
    seedActiveShare(database);

    const response = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect('uid' in body).toBe(false);
    expect('matchId' in body).toBe(false);
    expect(body.result).toBe('win');
    expect(body.reviewedMomentsCount).toBe(2);
  });

  it('returns 404 for an unknown token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/vod-shares/no-such-token',
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns an identical 404 body for a revoked token as for an unknown token (no oracle)', async () => {
    const { app, database } = buildTestApp();
    seedActiveShare(database, {
      token: 'revoked-token',
      shareId: 'revoked-share',
      revokedAt: 2000,
    });

    const unknownResponse = await app.inject({
      method: 'GET',
      url: '/api/vod-shares/no-such-token',
    });
    const revokedResponse = await app.inject({
      method: 'GET',
      url: '/api/vod-shares/revoked-token',
    });

    expect(revokedResponse.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    expect(revokedResponse.json()).toEqual(unknownResponse.json());
  });

  it('rate-limits to 60 req/min keyed on the RIGHTMOST X-Forwarded-For entry (the trusted-proxy-appended one) — rotating a spoofed leftmost entry does NOT mint a fresh bucket', async () => {
    const { app, database } = buildTestApp();
    seedActiveShare(database);

    // In production Cloud Run APPENDS the real client IP as the rightmost
    // XFF entry; anything left of it is attacker-supplied.
    const FIRST_IP = '1.2.3.4';
    const SECOND_IP = '5.6.7.8';

    let lastStatus = 200;
    for (let i = 0; i < 60; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/vod-shares/${TOKEN}`,
        headers: { 'x-forwarded-for': FIRST_IP },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(200);

    const sixtyFirst = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${TOKEN}`,
      headers: { 'x-forwarded-for': FIRST_IP },
    });
    expect(sixtyFirst.statusCode).toBe(429);

    // Spoof attempt: rotate the LEFT side while the trusted rightmost entry
    // stays FIRST_IP — must land in the SAME (already exhausted) bucket.
    const spoofedLeft = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${TOKEN}`,
      headers: { 'x-forwarded-for': `6.6.6.6, ${FIRST_IP}` },
    });
    expect(spoofedLeft.statusCode).toBe(429);

    // A genuinely different client (different rightmost entry) gets its own bucket.
    const differentIp = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${TOKEN}`,
      headers: { 'x-forwarded-for': SECOND_IP },
    });
    expect(differentIp.statusCode).toBe(200);
  });
});
