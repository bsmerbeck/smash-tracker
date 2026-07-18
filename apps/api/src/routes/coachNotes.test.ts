import { describe, expect, it } from 'vitest';
import { buildTestApp, TEST_UID } from '../test-support/testApp.js';

// Valid-SHAPE tokens (20+ base64url chars, matching SHARE_TOKEN_SHAPE) —
// crafted-path probes are covered by publicVodShares.test.ts already.
const EDIT_TOKEN = 'editTokenAAAAABBBBBCCCCC';
const UNKNOWN_TOKEN = 'unknownTokenDDDDDEEEEEFF';
const COACH_SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const COACH = { sessionId: COACH_SESSION, displayName: 'Coach Person' };

/** The one canonical 404 body EVERY failure mode must produce (no oracle). */
const UNAVAILABLE_404 = {
  error: 'Not Found',
  message: 'This share is no longer available',
  statusCode: 404,
};

interface SeedOptions {
  redaction?: { includedNotes: boolean; includedTags: boolean; showDisplayName: boolean };
  tokenOverrides?: Record<string, unknown>;
  matchOverrides?: Record<string, unknown>;
}

function seedEditShare(
  database: ReturnType<typeof buildTestApp>['database'],
  options: SeedOptions = {},
): void {
  const redaction = options.redaction ?? {
    includedNotes: true,
    includedTags: true,
    showDisplayName: false,
  };
  database.seed(`matches/${TEST_UID}/m1`, {
    fighter_id: 1,
    opponent_id: 8,
    time: 1700000000000,
    win: true,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    ...options.matchOverrides,
  });
  database.seed('shareSnapshots/share1', {
    uid: TEST_UID,
    matchId: 'm1',
    createdAt: 1700000100000,
    result: 'win',
    fighterId: 1,
    opponentFighterId: 8,
    matchDate: 1700000000000,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    reviewedMomentsCount: 0,
    redaction,
  });
  database.seed(`shareTokens/${EDIT_TOKEN}`, {
    shareId: 'share1',
    ownerUid: TEST_UID,
    permissions: 'edit',
    createdAt: 1700000100000,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    ...options.tokenOverrides,
  });
}

describe('GET /api/vod-shares/:token/session', () => {
  it('serves the live edit-session view anonymously with Cache-Control: no-store', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          coachNote: { seconds: 20, note: 'coach note', coach: COACH },
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${EDIT_TOKEN}/session`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.permissions).toBe('edit');
    expect(body.timestamps).toHaveLength(1);
    expect(body.timestamps[0]).toMatchObject({ id: 'coachNote', coach: COACH });
  });

  it('returns the identical 404 body for unknown, revoked, expired, and view-tier tokens', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database);

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${UNKNOWN_TOKEN}/session`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(UNAVAILABLE_404);

    database.seed(`shareTokens/${EDIT_TOKEN}/revokedAt`, 1700000200000);
    const revoked = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${EDIT_TOKEN}/session`,
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toEqual(unknown.json());

    database.seed(`shareTokens/${EDIT_TOKEN}`, {
      shareId: 'share1',
      ownerUid: TEST_UID,
      permissions: 'edit',
      createdAt: 1700000100000,
      expiresAt: Date.now() - 1000,
    });
    const expired = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${EDIT_TOKEN}/session`,
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toEqual(unknown.json());

    database.seed(`shareTokens/${EDIT_TOKEN}`, {
      shareId: 'share1',
      ownerUid: TEST_UID,
      permissions: 'view',
      createdAt: 1700000100000,
    });
    const viewTier = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${EDIT_TOKEN}/session`,
    });
    expect(viewTier.statusCode).toBe(404);
    expect(viewTier.json()).toEqual(unknown.json());
  });
});

describe('POST /api/vod-shares/:token/notes', () => {
  it('creates a coach-attributed note anonymously and returns it with no-store', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database);

    const response = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: {
        sessionId: COACH_SESSION,
        displayName: 'Coach Person',
        seconds: 42,
        note: 'work on ledge trapping',
        tags: ['neutral'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body).toMatchObject({
      seconds: 42,
      note: 'work on ledge trapping',
      tags: ['neutral'],
      coach: COACH,
    });
    expect(typeof body.id).toBe('string');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[TEST_UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps[body.id]).toMatchObject({ seconds: 42, coach: COACH });
  });

  it('rejects a revoked token with the identical 404 body (re-checked on the write)', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, { tokenOverrides: { revokedAt: 1700000200000 } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: { sessionId: COACH_SESSION, displayName: 'Coach Person', seconds: 1, note: 'x' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(UNAVAILABLE_404);
  });

  it('rejects an EXPIRED token with the identical 404 body', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, { tokenOverrides: { expiresAt: Date.now() - 1000 } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: { sessionId: COACH_SESSION, displayName: 'Coach Person', seconds: 1, note: 'x' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(UNAVAILABLE_404);
  });

  it('rejects a view-tier token with the identical 404 body (wrong tier, no oracle)', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, { tokenOverrides: { permissions: 'view' } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: { sessionId: COACH_SESSION, displayName: 'Coach Person', seconds: 1, note: 'x' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(UNAVAILABLE_404);
  });

  it('rejects the 21st note with a 403 (shared cap, server-enforced)', async () => {
    const { app, database } = buildTestApp();
    const twenty = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, { seconds: i, note: `note ${i}` }]),
    );
    seedEditShare(database, { matchOverrides: { vodTimestamps: twenty } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: {
        sessionId: COACH_SESSION,
        displayName: 'Coach Person',
        seconds: 999,
        note: 'one too many',
      },
    });

    expect(response.statusCode).toBe(403);
    // Review WR-01: the 403 body must be a static message — the service's
    // cap error interpolates the owner's private matchId (an RTDB push
    // key), which the anonymous surface must never serve.
    expect(response.json()).toEqual({
      error: 'Forbidden',
      message: 'This review already has the maximum number of notes',
      statusCode: 403,
    });
    expect(JSON.stringify(response.json())).not.toContain('m1');
  });

  it('enforces the 200-char note / 5-tag / uuid-sessionId caps via Zod (400)', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database);

    const longNote = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: {
        sessionId: COACH_SESSION,
        displayName: 'Coach Person',
        seconds: 1,
        note: 'x'.repeat(201),
      },
    });
    expect(longNote.statusCode).toBe(400);

    const tooManyTags = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: {
        sessionId: COACH_SESSION,
        displayName: 'Coach Person',
        seconds: 1,
        note: 'x',
        tags: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
    });
    expect(tooManyTags.statusCode).toBe(400);

    const badSession = await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes`,
      payload: { sessionId: 'not-a-uuid', displayName: 'Coach Person', seconds: 1, note: 'x' },
    });
    expect(badSession.statusCode).toBe(400);
  });
});

describe('PATCH /api/vod-shares/:token/notes/:noteId', () => {
  it("edits the caller's own note (partial body) and returns the updated note", async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          myNote: { seconds: 20, note: 'original', tags: ['punish'], coach: COACH },
        },
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/myNote`,
      payload: { sessionId: COACH_SESSION, note: 'edited by me' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      id: 'myNote',
      seconds: 20,
      note: 'edited by me',
      tags: ['punish'],
      coach: COACH,
    });
  });

  it("returns the identical 404 body for another session's note (server-side ownership)", async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          theirNote: {
            seconds: 20,
            note: 'not yours',
            coach: { sessionId: OTHER_SESSION, displayName: 'Other Coach' },
          },
        },
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/theirNote`,
      payload: { sessionId: COACH_SESSION, note: 'hijack' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(UNAVAILABLE_404);
  });

  it('returns the identical 404 body when targeting an OWNER note', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: { ownerNote: { seconds: 10, note: 'owner note' } },
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/ownerNote`,
      payload: { sessionId: COACH_SESSION, note: 'hijack' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(UNAVAILABLE_404);
  });
});

describe('DELETE /api/vod-shares/:token/notes/:noteId', () => {
  it("deletes the caller's own note via the sessionId QUERY param (204)", async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          myNote: { seconds: 20, note: 'mine', coach: COACH },
          ownerNote: { seconds: 10, note: 'owner note' },
        },
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/myNote?sessionId=${COACH_SESSION}`,
    });

    expect(response.statusCode).toBe(204);

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[TEST_UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps).not.toHaveProperty('myNote');
    expect(vodTimestamps).toHaveProperty('ownerNote');
  });

  it("returns the identical 404 body for another session's note and leaves it stored", async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          theirNote: {
            seconds: 20,
            note: 'not yours',
            coach: { sessionId: OTHER_SESSION, displayName: 'Other Coach' },
          },
        },
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/theirNote?sessionId=${COACH_SESSION}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(UNAVAILABLE_404);

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[TEST_UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps).toHaveProperty('theirNote');
  });

  it('rejects a missing sessionId query param with 400', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: { myNote: { seconds: 20, note: 'mine', coach: COACH } },
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/myNote`,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('coach write rate limits (per-token 20/min + per-IP floor)', () => {
  it('429s the 21st rapid same-token write even when the caller rotates spoofed IPs', async () => {
    const { app, database } = buildTestApp();
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: { myNote: { seconds: 20, note: 'mine', coach: COACH } },
      },
    });

    // PATCH (not POST) so the 20-NOTE cap can't trip before the 20/min
    // RATE cap — this test isolates the rate limiter.
    let lastStatus = 0;
    for (let i = 0; i < 20; i += 1) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/vod-shares/${EDIT_TOKEN}/notes/myNote`,
        // Rotating the trusted rightmost XFF entry every request — a
        // per-IP-keyed bucket would never fill; only a per-TOKEN bucket
        // trips. This is the spike test for the nested registration.
        headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
        payload: { sessionId: COACH_SESSION, note: `edit ${i}` },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(200);

    const twentyFirst = await app.inject({
      method: 'PATCH',
      url: `/api/vod-shares/${EDIT_TOKEN}/notes/myNote`,
      headers: { 'x-forwarded-for': '10.0.0.99' },
      payload: { sessionId: COACH_SESSION, note: 'over the limit' },
    });
    expect(twentyFirst.statusCode).toBe(429);
  });

  it('429s the 101st same-IP request even when the caller rotates tokens (per-IP floor)', async () => {
    const { app } = buildTestApp();
    const ip = '9.9.9.9';

    // Unknown tokens 404 — but every request still counts against the
    // per-IP floor bucket (the limiter runs before the handler).
    let lastStatus = 0;
    for (let i = 0; i < 100; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/vod-shares/rotatingToken${String(i).padStart(10, '0')}/session`,
        headers: { 'x-forwarded-for': ip },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(404);

    const hundredFirst = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/rotatingTokenZZZZZZZZZZ/session`,
      headers: { 'x-forwarded-for': ip },
    });
    expect(hundredFirst.statusCode).toBe(429);
  });
});
