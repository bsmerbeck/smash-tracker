import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, registerUser, TEST_UID } from '../test-support/testApp.js';

const SECOND_UID = 'test-uid-456';
const SECOND_TOKEN = 'valid-test-token-2';

async function createGroup(app: ReturnType<typeof buildTestApp>['app'], name = 'The Crew') {
  return app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: authHeader(),
    payload: { name },
  });
}

describe('POST /api/groups', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'x' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates a group with the caller as owner and first member', async () => {
    const { app, database } = buildTestApp();

    const response = await createGroup(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ name: 'The Crew', ownerUid: TEST_UID, memberCount: 1 });
    expect(typeof body.id).toBe('string');
    expect(typeof body.inviteCode).toBe('string');
    expect(body.inviteCode).toHaveLength(8);

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.groups).toMatchObject({ [body.id]: { name: 'The Crew', ownerUid: TEST_UID } });
    expect(dump.groupMembers).toMatchObject({
      [body.id]: { [TEST_UID]: { displayName: expect.any(String) } },
    });
    expect(dump.userGroups).toMatchObject({ [TEST_UID]: { [body.id]: true } });
    expect((dump.groupInviteCodes as Record<string, unknown>)[body.inviteCode]).toBe(body.id);
  });

  it('uses the linked start.gg gamer tag as displayName when linked', async () => {
    const { app, database } = buildTestApp();
    database.seed(`startggLinks/${TEST_UID}`, { gamerTag: 'Pandem1c' });

    const response = await createGroup(app);

    const body = response.json();
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.groupMembers).toMatchObject({
      [body.id]: { [TEST_UID]: { displayName: 'Pandem1c' } },
    });
  });

  it('falls back to Player+last4 when no start.gg link exists', async () => {
    const { app, database } = buildTestApp();

    const response = await createGroup(app);

    const body = response.json();
    const dump = database.dump() as Record<string, unknown>;
    const members = (dump.groupMembers as Record<string, Record<string, { displayName: string }>>)[
      body.id
    ];
    expect(members?.[TEST_UID]?.displayName).toBe(`Player${TEST_UID.slice(-4)}`);
  });

  it('rejects creating an 11th group (cap of 10)', async () => {
    const { app } = buildTestApp();

    for (let i = 0; i < 10; i += 1) {
      const response = await createGroup(app, `Group ${i}`);
      expect(response.statusCode).toBe(200);
    }

    const eleventh = await createGroup(app, 'Group 11');
    expect(eleventh.statusCode).toBe(403);
  });

  it('rejects a blank name', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: authHeader(),
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/groups/join', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      payload: { code: 'ABCD2345' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown invite code', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(),
      payload: { code: 'NOPE0000' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lets a second user join by invite code', async () => {
    const { app, auth, database } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: groupId, memberCount: 2 });
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.groupMembers).toMatchObject({ [groupId]: { [SECOND_UID]: expect.any(Object) } });
    expect(dump.userGroups).toMatchObject({ [SECOND_UID]: { [groupId]: true } });
  });

  it('is idempotent when already a member', async () => {
    const { app } = buildTestApp();
    const created = await createGroup(app);
    const { inviteCode } = created.json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(),
      payload: { code: inviteCode },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().memberCount).toBe(1);
  });

  it('rejects joining a full group (cap of 20 members)', async () => {
    const { app, auth } = buildTestApp();
    const created = await createGroup(app);
    const { inviteCode } = created.json();

    for (let i = 0; i < 19; i += 1) {
      const uid = `member-${i}`;
      const token = `token-${i}`;
      registerUser(auth, token, { uid, email: `${uid}@example.com` });
      const response = await app.inject({
        method: 'POST',
        url: '/api/groups/join',
        headers: authHeader(token),
        payload: { code: inviteCode },
      });
      expect(response.statusCode).toBe(200);
    }
    // Group now has 1 (owner) + 19 = 20 members — full.

    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    const overflow = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });
    expect(overflow.statusCode).toBe(409);
  });

  it('rejects joining an 11th group (cap of 10)', async () => {
    const { app, auth, database } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    // 11 distinct groups, each with a different owner (seeded directly in
    // RTDB — going through the create API would also hit a single owner's
    // own 10-group cap, which isn't what this test is about). SECOND_UID
    // joins the first 10 via the real API to hit its own per-user cap.
    const inviteCodes: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const groupId = `seeded-group-${i}`;
      const inviteCode = `CODE000${i}`;
      database.seed(`groups/${groupId}`, {
        name: `Group ${i}`,
        ownerUid: `seeded-owner-${i}`,
        inviteCode,
        createdAt: Date.now(),
      });
      database.seed(`groupMembers/${groupId}/seeded-owner-${i}`, {
        displayName: `Owner${i}`,
        joinedAt: Date.now(),
      });
      database.seed(`groupInviteCodes/${inviteCode}`, groupId);
      inviteCodes.push(inviteCode);
    }

    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/groups/join',
        headers: authHeader(SECOND_TOKEN),
        payload: { code: inviteCodes[i] },
      });
      expect(response.statusCode).toBe(200);
    }
    // SECOND_UID is now in 10 groups (their cap) — joining the 11th must 403.

    const overflow = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCodes[10] },
    });
    expect(overflow.statusCode).toBe(403);
  });
});

describe('GET /api/groups', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/groups' });
    expect(response.statusCode).toBe(401);
  });

  it('returns an empty list with no groups', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/groups', headers: authHeader() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('lists the caller groups with memberCount', async () => {
    const { app } = buildTestApp();
    await createGroup(app, 'Group A');
    await createGroup(app, 'Group B');

    const response = await app.inject({ method: 'GET', url: '/api/groups', headers: authHeader() });
    expect(response.statusCode).toBe(200);
    const groups = response.json();
    expect(groups).toHaveLength(2);
    expect(groups.map((g: { name: string }) => g.name).sort()).toEqual(['Group A', 'Group B']);
  });
});

describe('GET /api/groups/:id/leaderboard', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/groups/some-id/leaderboard' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 403 for a non-member', async () => {
    const { app, auth } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    const created = await createGroup(app);
    const { id: groupId } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/leaderboard`,
      headers: authHeader(SECOND_TOKEN),
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 for an unknown group', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/groups/does-not-exist/leaderboard',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('computes ratings for each member from their own match history, sorted by rating desc', async () => {
    const { app, auth, database } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();
    await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    // Owner (TEST_UID): a session of wins -> rating should rise above 1500.
    database.seed(`matches/${TEST_UID}`, {
      m1: { fighter_id: 1, opponent_id: 2, time: 1000, win: true },
      m2: { fighter_id: 1, opponent_id: 2, time: 2000, win: true },
      m3: { fighter_id: 1, opponent_id: 2, time: 3000, win: true },
    });
    // Second member: no matches at all -> default rating/RD, 0 games, null lastMatchAt.

    const response = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/leaderboard`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.group).toMatchObject({ id: groupId, memberCount: 2 });
    expect(body.entries).toHaveLength(2);

    const owner = body.entries.find((e: { uid: string }) => e.uid === TEST_UID);
    const second = body.entries.find((e: { uid: string }) => e.uid === SECOND_UID);

    expect(owner.rating).toBeGreaterThan(1500);
    expect(owner.games).toBe(3);
    expect(owner.lastMatchAt).toBe(3000);
    expect(owner.isYou).toBe(true);

    expect(second.rating).toBe(1500);
    expect(second.rd).toBe(350);
    expect(second.games).toBe(0);
    expect(second.lastMatchAt).toBeNull();
    expect(second.isYou).toBe(false);

    // Sorted by rating descending.
    expect(body.entries[0].uid).toBe(TEST_UID);

    // Never exposes email or any other identifying field beyond the contract.
    expect(owner.email).toBeUndefined();
    expect(second.email).toBeUndefined();
  });

  it('marks isYou correctly per-caller (cache payload is caller-agnostic)', async () => {
    const { app, auth } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });

    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();
    await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    const asOwner = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/leaderboard`,
      headers: authHeader(),
    });
    const asSecond = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/leaderboard`,
      headers: authHeader(SECOND_TOKEN),
    });

    const ownerView = asOwner.json().entries.find((e: { uid: string }) => e.uid === TEST_UID);
    const secondViewOfOwner = asSecond
      .json()
      .entries.find((e: { uid: string }) => e.uid === TEST_UID);
    expect(ownerView.isYou).toBe(true);
    expect(secondViewOfOwner.isYou).toBe(false);
  });

  it('caches the leaderboard so a second call does not re-read match history', async () => {
    const { app, database } = buildTestApp();
    const created = await createGroup(app);
    const { id: groupId } = created.json();
    database.seed(`matches/${TEST_UID}`, {
      m1: { fighter_id: 1, opponent_id: 2, time: 1000, win: true },
    });

    const originalRef = database.ref.bind(database);
    let matchReads = 0;
    database.ref = ((path: string) => {
      const ref = originalRef(path);
      if (path.startsWith('matches/')) {
        const originalGet = ref.get.bind(ref);
        ref.get = async () => {
          matchReads += 1;
          return originalGet();
        };
      }
      return ref;
    }) as typeof database.ref;

    const first = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/leaderboard`,
      headers: authHeader(),
    });
    expect(first.statusCode).toBe(200);
    expect(matchReads).toBe(1);

    const second = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/leaderboard`,
      headers: authHeader(),
    });
    expect(second.statusCode).toBe(200);
    // Cache hit — no additional match-history read.
    expect(matchReads).toBe(1);
    expect(second.json()).toEqual(first.json());
  });
});

describe('POST /api/groups/:id/leave', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/groups/some-id/leave' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown group', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/does-not-exist/leave',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('blocks the owner from leaving while other members exist (409)', async () => {
    const { app, auth } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();
    await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/leave`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(409);
  });

  it('allows a non-owner member to leave', async () => {
    const { app, auth, database } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();
    await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/leave`,
      headers: authHeader(SECOND_TOKEN),
    });
    expect(response.statusCode).toBe(204);

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.groupMembers).toMatchObject({ [groupId]: { [TEST_UID]: expect.any(Object) } });
    expect(
      (dump.groupMembers as Record<string, Record<string, unknown>>)[groupId]?.[SECOND_UID],
    ).toBeUndefined();
    // The RTDB (and this fake) semantics for removing the last child of a
    // node can leave an empty object behind rather than pruning the parent
    // key entirely — either way, SECOND_UID must no longer be recorded as a
    // member of this group.
    expect(dump.userGroups).not.toMatchObject({ [SECOND_UID]: { [groupId]: true } });
  });

  it('allows the owner to leave once they are the only member', async () => {
    const { app } = buildTestApp();
    const created = await createGroup(app);
    const { id: groupId } = created.json();

    const response = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/leave`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('DELETE /api/groups/:id', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'DELETE', url: '/api/groups/some-id' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown group', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/groups/does-not-exist',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 403 for a non-owner', async () => {
    const { app, auth } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();
    await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${groupId}`,
      headers: authHeader(SECOND_TOKEN),
    });
    expect(response.statusCode).toBe(403);
  });

  it('cleans up all four RTDB paths on owner delete', async () => {
    const { app, auth, database } = buildTestApp();
    registerUser(auth, SECOND_TOKEN, { uid: SECOND_UID, email: 'second@example.com' });
    const created = await createGroup(app);
    const { id: groupId, inviteCode } = created.json();
    await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: authHeader(SECOND_TOKEN),
      payload: { code: inviteCode },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${groupId}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(204);

    const dump = database.dump() as Record<string, unknown>;
    expect((dump.groups as Record<string, unknown> | undefined)?.[groupId]).toBeUndefined();
    expect((dump.groupMembers as Record<string, unknown> | undefined)?.[groupId]).toBeUndefined();
    expect(
      (dump.userGroups as Record<string, Record<string, unknown>> | undefined)?.[TEST_UID]?.[
        groupId
      ],
    ).toBeUndefined();
    expect(
      (dump.userGroups as Record<string, Record<string, unknown>> | undefined)?.[SECOND_UID]?.[
        groupId
      ],
    ).toBeUndefined();
    expect(
      (dump.groupInviteCodes as Record<string, unknown> | undefined)?.[inviteCode],
    ).toBeUndefined();
  });
});
