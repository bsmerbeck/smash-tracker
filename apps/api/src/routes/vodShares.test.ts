import { describe, expect, it, vi } from 'vitest';
import type { Ga4Config } from '../config/env.js';
import { authHeader, buildTestApp, registerUser, TEST_UID } from '../test-support/testApp.js';

const GA4_CONFIG: Ga4Config = { measurementId: 'G-TEST', apiSecret: 'test-secret' };

const SECOND_UID = 'test-uid-456';
const SECOND_TOKEN = 'valid-test-token-2';

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
/** The STORED shape of REDACTION_ALL_ON (post-buildShareSnapshot key names) — used when seeding shareSnapshots directly. */
const REDACTION_ALL_ON_STORED = { includedNotes: true, includedTags: true, showDisplayName: false };

/** Seeds a `tournamentEntries/{uid}/{entryKey}` record recap creation reads. */
function seedTournamentEntry(
  database: ReturnType<typeof buildTestApp>['database'],
  uid: string,
  entryKey: string,
  overrides = {},
) {
  database.seed(`tournamentEntries/${uid}`, {
    [entryKey]: {
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      seed: 8,
      placement: 3,
      firstSetAt: 1000,
      lastSetAt: 5000,
      setsPlayed: 1,
      ...overrides,
    },
  });
}

/** Seeds a single won set (one match, one game) matching seedTournamentEntry's event/tournament window. */
function seedRecapMatch(database: ReturnType<typeof buildTestApp>['database'], uid: string) {
  database.seed(`matches/${uid}`, {
    m1: {
      fighter_id: 1,
      opponent_id: 2,
      time: 1000,
      win: true,
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      externalId: 'sgg:set-1:g1',
      opponentSeed: 1,
      opponent: 'RivalTag',
    },
  });
}

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

describe('DELETE /api/vod-shares/:id', () => {
  async function createAndRevoke(app: ReturnType<typeof buildTestApp>['app']) {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    const { shareId, token } = createResponse.json();
    await app.inject({
      method: 'POST',
      url: `/api/vod-shares/${shareId}/revoke`,
      headers: authHeader(),
    });
    return { shareId, token };
  }

  it('hard-deletes a revoked share — token, snapshot, and index entry all removed', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);
    const { shareId, token } = await createAndRevoke(app);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/vod-shares/${shareId}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    const dump = database.dump() as Record<string, unknown>;
    const snapshots = (dump.shareSnapshots ?? {}) as Record<string, unknown>;
    expect(snapshots[shareId]).toBeUndefined();
    const tokens = (dump.shareTokens ?? {}) as Record<string, unknown>;
    expect(tokens[token]).toBeUndefined();
    const index = ((dump.sharesByUser ?? {}) as Record<string, Record<string, unknown>>)[TEST_UID];
    expect(index?.[shareId]).toBeUndefined();

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/vod-shares',
      headers: authHeader(),
    });
    expect(listResponse.json()).toEqual([]);
  });

  it('FB-03: 204s for an ACTIVE share — revoke-first is no longer required, and the link dies immediately', async () => {
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
      method: 'DELETE',
      url: `/api/vod-shares/${shareId}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    const dump = database.dump() as Record<string, unknown>;
    const tokens = (dump.shareTokens ?? {}) as Record<string, unknown>;
    expect(tokens[token]).toBeUndefined();
    const snapshots = (dump.shareSnapshots ?? {}) as Record<string, unknown>;
    expect(snapshots[shareId]).toBeUndefined();
  });

  it('404s for an unknown share and rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/vod-shares/nope',
      headers: authHeader(),
    });
    expect(missing.statusCode).toBe(404);

    const unauthenticated = await app.inject({ method: 'DELETE', url: '/api/vod-shares/nope' });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("404s when deleting another user's revoked share (cross-user)", async () => {
    const { app, auth, database } = buildTestApp();
    seedMatch(database);
    const { shareId } = await createAndRevoke(app);
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/vod-shares/${shareId}`,
      headers: authHeader(SECOND_TOKEN),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/vod-shares/bulk', () => {
  /** Seeds one review share (snapshot + token + owner index) directly, matching createShare's own record shape. */
  function seedShare(
    database: ReturnType<typeof buildTestApp>['database'],
    uid: string,
    shareId: string,
    token: string,
    tokenOverrides: Record<string, unknown> = {},
  ) {
    database.seed(`shareSnapshots/${shareId}`, {
      uid,
      matchId: 'm1',
      createdAt: 1000,
      result: 'win',
      fighterId: 1,
      opponentFighterId: 2,
      matchDate: 500,
      vodUrl: 'https://youtu.be/abc123',
      reviewedMomentsCount: 1,
      redaction: REDACTION_ALL_ON_STORED,
    });
    database.seed(`shareTokens/${token}`, {
      shareId,
      ownerUid: uid,
      permissions: 'view',
      createdAt: 1000,
      ...tokenOverrides,
    });
    database.seed(`sharesByUser/${uid}/${shareId}`, token);
  }

  it('revoke over a seeded mix returns 200 with expected processed/skipped counts', async () => {
    const { app, database } = buildTestApp();
    seedShare(database, TEST_UID, 'activeShare', 'activeTokenAAAAABBBBB');
    seedShare(database, TEST_UID, 'revokedShare', 'revokedTokenAAAAABBBBB', {
      revokedAt: 2000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/bulk',
      headers: authHeader(),
      payload: { action: 'revoke', shareIds: ['activeShare', 'revokedShare', 'nope'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ processed: 1, skipped: 2 });
    const dump = database.dump() as Record<string, unknown>;
    const tokens = dump.shareTokens as Record<string, Record<string, unknown>>;
    expect(tokens.activeTokenAAAAABBBBB!.revokedAt).toEqual(expect.any(Number));
  });

  it('a body with 101 shareIds is rejected with 400', async () => {
    const { app } = buildTestApp();
    const shareIds = Array.from({ length: 101 }, (_, i) => `share${i}`);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/bulk',
      headers: authHeader(),
      payload: { action: 'revoke', shareIds },
    });

    expect(response.statusCode).toBe(400);
  });

  it('an empty shareIds array is rejected with 400', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/bulk',
      headers: authHeader(),
      payload: { action: 'revoke', shareIds: [] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('an invalid action is rejected with 400', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/bulk',
      headers: authHeader(),
      payload: { action: 'archive', shareIds: ['s1'] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('a bulk request including a foreign shareId returns 200 and counts it as skipped, never an error', async () => {
    const { app, auth, database } = buildTestApp();
    seedShare(database, TEST_UID, 'ownShare', 'ownTokenAAAAAAABBBBB');
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    seedShare(database, SECOND_UID, 'otherShare', 'otherTokenAAAAAABBBBB');

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/bulk',
      headers: authHeader(),
      payload: { action: 'delete', shareIds: ['ownShare', 'otherShare'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ processed: 1, skipped: 1 });
    const dump = database.dump() as Record<string, unknown>;
    const tokens = (dump.shareTokens ?? {}) as Record<string, unknown>;
    // The foreign share (owned by SECOND_UID) is untouched.
    expect(tokens.otherTokenAAAAAABBBBB).toBeDefined();
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/bulk',
      payload: { action: 'revoke', shareIds: ['s1'] },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/vod-shares — kind recap', () => {
  it("creates a recap share for the caller's own seeded tournamentEntries and reads back kind recap + computed stats", async () => {
    const { app, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99');
    seedRecapMatch(database, TEST_UID);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99' },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.shareId).toEqual(expect.any(String));
    expect(created.token).toEqual(expect.any(String));

    const readResponse = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${created.token}`,
    });

    expect(readResponse.statusCode).toBe(200);
    const body = readResponse.json();
    expect(body.kind).toBe('recap');
    expect(body.tournamentName).toBe('The Big House 9');
    expect(body.setRecordWins).toBe(1);
    expect(body.setRecordLosses).toBe(0);
    expect(body.characterFighterIds).toEqual([1]);
    expect('uid' in body).toBe(false);
    expect('entryKey' in body).toBe(false);
  });

  it("404s for a recap create against another user's entryKey (never a body/params uid, T-05-04)", async () => {
    const { app, auth, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99'); // owned by TEST_UID only
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(SECOND_TOKEN),
      payload: { kind: 'recap', entryKey: '99' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s for a recap create against a nonexistent entryKey', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: 'nope' },
    });

    expect(response.statusCode).toBe(404);
  });

  // Review WR-01: entryKey is interpolated into an RTDB path — a crafted
  // value must collapse to the same 404 an absent entry gets, never a 500.
  it('404s (never 500s) for an entryKey with RTDB-illegal path characters', async () => {
    const { app } = buildTestApp();

    // FakeDatabase's ref() throws on `.`/`#`/`$`/`[`/`]` exactly like
    // firebase-admin — a 404 here proves the shape guard runs BEFORE the read.
    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: 'foo.bar' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s for an entryKey containing the DEL control char (firebase-illegal, WR-08)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: `foo${String.fromCharCode(0x7f)}bar` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s for an entryKey containing a slash (would read a NESTED child of a real entry)', async () => {
    const { app, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99');
    seedRecapMatch(database, TEST_UID);

    // `99/eventName` resolves to a real nested string under the seeded entry
    // — without the guard, tournamentEntrySchema would throw out of the
    // parse (500) instead of 404ing.
    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99/eventName' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s (never 500s) when the stored tournament entry is corrupt', async () => {
    const { app, database } = buildTestApp();
    // Corrupt: string-typed firstSetAt, missing setsPlayed.
    seedTournamentEntry(database, TEST_UID, '99', {
      firstSetAt: 'not-a-number',
      setsPlayed: undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects the 101st recap share with 403 (same cap as review shares)', async () => {
    const { app, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99');
    seedRecapMatch(database, TEST_UID);
    seedActiveShares(database, TEST_UID, 100);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a recap body missing entryKey with 400', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('an existing vod-review create (no kind) still returns 201 and reads back a review snapshot with no kind field', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });
    expect(createResponse.statusCode).toBe(201);
    const { token } = createResponse.json();

    const readResponse = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${token}`,
    });

    expect(readResponse.statusCode).toBe(200);
    const body = readResponse.json();
    expect('kind' in body).toBe(false);
    expect(body.result).toBe('win');
  });

  it('defaults to detail "full" and stores the set timeline when the request omits detail', async () => {
    const { app, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99');
    seedRecapMatch(database, TEST_UID);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99' },
    });
    expect(createResponse.statusCode).toBe(201);
    const { token } = createResponse.json();

    const readResponse = await app.inject({ method: 'GET', url: `/api/vod-shares/${token}` });
    const body = readResponse.json();

    expect(body.detail).toBe('full');
    expect(body.sets).toHaveLength(1);
    expect(body.sets[0]).toMatchObject({ opponentName: 'RivalTag', wins: 1, losses: 0, win: true });
  });

  it('stores no set timeline (and no detail field) for an explicit detail: "summary"', async () => {
    const { app, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99');
    seedRecapMatch(database, TEST_UID);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99', detail: 'summary' },
    });
    expect(createResponse.statusCode).toBe(201);
    const { token } = createResponse.json();

    const readResponse = await app.inject({ method: 'GET', url: `/api/vod-shares/${token}` });
    const body = readResponse.json();

    expect('detail' in body).toBe(false);
    expect('sets' in body).toBe(false);
    // The rest of the recap stats are unaffected by detail.
    expect(body.setRecordWins).toBe(1);
  });

  it('reads back tournamentUrl built from the seeded entry eventSlug', async () => {
    const { app, database } = buildTestApp();
    seedTournamentEntry(database, TEST_UID, '99', {
      eventSlug: 'tournament/the-big-house-9/event/ultimate-singles',
    });
    seedRecapMatch(database, TEST_UID);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { kind: 'recap', entryKey: '99' },
    });
    const { token } = createResponse.json();

    const readResponse = await app.inject({ method: 'GET', url: `/api/vod-shares/${token}` });
    const body = readResponse.json();

    expect(body.tournamentUrl).toBe(
      'https://start.gg/tournament/the-big-house-9/event/ultimate-singles',
    );
  });
});

describe('WR-02: cross-user ownership', () => {
  it("404s when creating a share against another user's matchId (never a body/params uid, T-05-04)", async () => {
    const { app, auth, database } = buildTestApp();
    seedMatch(database); // seeds matches/{TEST_UID}/m1
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(SECOND_TOKEN),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    // Same 404 as "a match that does not exist" -- ownership is enforced by
    // path shape (matches/{uid}/{matchId}), so a foreign matchId is
    // indistinguishable from a nonexistent one; never a 403 that would
    // confirm the match's existence to a non-owner.
    expect(response.statusCode).toBe(404);
  });

  it("404s when revoking another user's shareId, without silently succeeding or leaking existence", async () => {
    const { app, auth, database } = buildTestApp();
    seedMatch(database);
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

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
      headers: authHeader(SECOND_TOKEN),
    });

    // Same 404 as "an unknown share" -- indistinguishable from a share that
    // never existed.
    expect(response.statusCode).toBe(404);

    // And the share must remain untouched -- user B's failed attempt did
    // not revoke user A's share.
    const dump = database.dump() as Record<string, unknown>;
    const tokens = dump.shareTokens as Record<string, Record<string, unknown>>;
    expect(tokens[token]!.revokedAt).toBeUndefined();
  });

  it("GET /api/vod-shares never includes another user's shares", async () => {
    const { app, auth, database } = buildTestApp();
    seedMatch(database);
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/vod-shares',
      headers: authHeader(SECOND_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe('POST /api/vod-shares — review_shared GA4 event (Phase 7)', () => {
  it('records a review_shared event after a successful create, and still returns 201 when the GA4 fetch rejects', async () => {
    const ga4Fetch = vi.fn<typeof fetch>(() => Promise.reject(new Error('network partition')));
    const { app, database } = buildTestApp({
      ga4: GA4_CONFIG,
      ga4Fetch: ga4Fetch as unknown as typeof fetch,
    });
    seedMatch(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(201);
    // Let the fire-and-forget microtask (never awaited by the handler) settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ga4Fetch).toHaveBeenCalledTimes(1);
    const [url, init] = ga4Fetch.mock.calls[0]!;
    expect(String(url)).toContain('measurement_id=');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.events[0].name).toBe('review_shared');
    expect(body.events[0].params).toEqual({ kind: 'review' });
  });

  it('does not attempt an MP call and still returns 201 when GA4 is unconfigured (ga4 null)', async () => {
    const ga4Fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const { app, database } = buildTestApp({
      ga4: null,
      ga4Fetch: ga4Fetch as unknown as typeof fetch,
    });
    seedMatch(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      headers: authHeader(),
      payload: { matchId: 'm1', redaction: REDACTION_ALL_ON },
    });

    expect(response.statusCode).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ga4Fetch).not.toHaveBeenCalled();
  });
});
