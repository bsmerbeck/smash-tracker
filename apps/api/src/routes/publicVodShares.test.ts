import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

// Valid-SHAPE tokens (43-char base64url, matching generateShareToken's
// output): getShareByToken rejects anything outside
// /^[A-Za-z0-9_-]{20,128}$/ before ever reading RTDB, so short/illegal
// tokens would never exercise the lookup paths these tests target.
const TOKEN = 'aValidToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'noSuchToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVOKED_TOKEN = 'revokedToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
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

function seedActiveRecapShare(
  database: ReturnType<typeof buildTestApp>['database'],
  overrides: { token?: string; shareId?: string } = {},
) {
  const token = overrides.token ?? TOKEN;
  const shareId = overrides.shareId ?? SHARE_ID;

  database.seed(`shareTokens/${token}`, {
    shareId,
    ownerUid: 'owner-uid',
    permissions: 'view',
    createdAt: 1000,
  });
  database.seed(`shareSnapshots/${shareId}`, {
    uid: 'owner-uid',
    entryKey: '99',
    createdAt: 1000,
    kind: 'recap',
    source: 'startgg',
    tournamentName: 'The Big House 9',
    tournamentDate: 500,
    placement: 3,
    seed: 8,
    setRecordWins: 2,
    setRecordLosses: 1,
    characterFighterIds: [1, 5],
    reviewedMomentsCount: 0,
  });

  return { token, shareId };
}

describe('GET /api/vod-shares/:token', () => {
  it('returns a recap public snapshot (kind recap) distinguishable from a review snapshot', async () => {
    const { app, database } = buildTestApp();
    seedActiveRecapShare(database);

    const response = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kind).toBe('recap');
    expect(body.tournamentName).toBe('The Big House 9');
    expect(body.setRecordWins).toBe(2);
    expect(body.characterFighterIds).toEqual([1, 5]);
    expect('uid' in body).toBe(false);
    expect('entryKey' in body).toBe(false);
    expect('vodUrl' in body).toBe(false);
  });

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
      url: `/api/vod-shares/${UNKNOWN_TOKEN}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns an identical 404 body for a revoked token as for an unknown token (no oracle)', async () => {
    const { app, database } = buildTestApp();
    seedActiveShare(database, {
      token: REVOKED_TOKEN,
      shareId: 'revoked-share',
      revokedAt: 2000,
    });

    const unknownResponse = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${UNKNOWN_TOKEN}`,
    });
    const revokedResponse = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${REVOKED_TOKEN}`,
    });

    expect(revokedResponse.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    expect(revokedResponse.json()).toEqual(unknownResponse.json());
  });

  it('returns the identical 404 (never a 500) for a malformed token with RTDB-illegal path characters', async () => {
    const { app } = buildTestApp();

    // `foo.bar` would make firebase-admin's ref() throw synchronously if it
    // ever reached an RTDB read — the shape guard must collapse it to the
    // same 404 as an unknown token (no charset validity oracle).
    const malformedResponse = await app.inject({
      method: 'GET',
      url: '/api/vod-shares/foo.bar',
    });
    const unknownResponse = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${UNKNOWN_TOKEN}`,
    });

    expect(malformedResponse.statusCode).toBe(404);
    expect(malformedResponse.json()).toEqual(unknownResponse.json());
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
