import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { authHeader, buildTestApp, registerUser } from '../test-support/testApp.js';
import { listOwnedWorkspaces } from './clientWorkspaces.js';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const CLIENT_UID = 'client-1';
const OTHER_CLIENT_UID = 'client-2';
const COACH_UID = 'coach-1';

/**
 * This route is deliberately NOT added to
 * `apps/api/src/coaching/foreignClient.test.ts`'s `SAME_SUBJECT_ROUTES`
 * harness. That harness proves "a second coach targeting the first coach's
 * TENANT_ID gets 403" — it exists for routes that accept a caller-supplied
 * tenant/uid identifier that a foreign account could substitute.
 * `GET /api/client-workspaces` accepts no tenant id (or any other
 * identifier) to target: it always reads `clientOwnedTenants/{request.uid}`,
 * derived exclusively from the verified token. There is no identifier
 * vector for a foreign-tenant-id test to exercise. The equivalent proof here
 * is the caller-isolation test below: two registered uids, one with an index
 * entry and one without, each receiving only their own list.
 */
describe('listOwnedWorkspaces', () => {
  it('returns [] when clientOwnedTenants/{clientUid} is absent', async () => {
    const database = new FakeDatabase();

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([]);
  });

  it('returns one entry per index child, with the stored label/claimedAt and the delegate uid from clientMembers', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    database.seed(`clientMembers/${TENANT_ID}`, {
      [CLIENT_UID]: { role: 'owner', joinedAt: 1 },
      [COACH_UID]: { role: 'delegate', joinedAt: 1 },
    });

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([
      { tenantId: TENANT_ID, label: 'Ana', claimedAt: 1, delegateCoachUid: COACH_UID },
    ]);
  });

  it('returns delegateCoachUid null when no delegate membership exists (e.g. after the client revoked the coach)', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    database.seed(`clientMembers/${TENANT_ID}`, {
      [CLIENT_UID]: { role: 'owner', joinedAt: 1 },
    });

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([
      { tenantId: TENANT_ID, label: 'Ana', claimedAt: 1, delegateCoachUid: null },
    ]);
  });

  it('skips index children that fail clientOwnedTenantEntrySchema instead of throwing', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${OTHER_TENANT_ID}`, { label: '' }); // fails: empty label, missing claimedAt
    database.seed(`clientMembers/${TENANT_ID}`, {
      [CLIENT_UID]: { role: 'owner', joinedAt: 1 },
    });

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([
      { tenantId: TENANT_ID, label: 'Ana', claimedAt: 1, delegateCoachUid: null },
    ]);
  });

  // Quick 260726-r7 (P0 self-heal): a hard-deleted tenant leaves
  // `clientMembers/{tenantId}` gone entirely while the client-keyed
  // `clientOwnedTenants` index row (written by a PRE-fix `deleteClient`, or
  // production's current stuck rows) survives. This is the exact orphan
  // shape the owner is currently stuck with.
  it('excludes an orphan row (index present, clientMembers absent) AND prunes it', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    // Deliberately no clientMembers/{TENANT_ID} at all — the tenant is gone.

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([]);
    const dump = database.dump() as Record<string, unknown>;
    expect(
      (dump.clientOwnedTenants as Record<string, Record<string, unknown>> | undefined)?.[
        CLIENT_UID
      ]?.[TENANT_ID],
    ).toBeUndefined();
  });

  it('excludes and prunes when clientMembers/{tenantId} exists but every child fails clientMembershipSchema', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    // A corrupt-but-present node: no surviving (safeParse-passing) members.
    database.seed(`clientMembers/${TENANT_ID}`, { [CLIENT_UID]: { role: 'not-a-real-role' } });

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([]);
    const dump = database.dump() as Record<string, unknown>;
    expect(
      (dump.clientOwnedTenants as Record<string, Record<string, unknown>> | undefined)?.[
        CLIENT_UID
      ]?.[TENANT_ID],
    ).toBeUndefined();
  });

  it('a healthy claimed workspace is still listed, with its delegate coach, and is never pruned', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    database.seed(`clientMembers/${TENANT_ID}`, {
      [CLIENT_UID]: { role: 'owner', joinedAt: 1 },
      [COACH_UID]: { role: 'delegate', joinedAt: 1 },
    });

    const result = await listOwnedWorkspaces(database as never, CLIENT_UID);

    expect(result).toEqual([
      { tenantId: TENANT_ID, label: 'Ana', claimedAt: 1, delegateCoachUid: COACH_UID },
    ]);
    const dump = database.dump() as Record<string, unknown>;
    expect(
      (dump.clientOwnedTenants as Record<string, Record<string, unknown>> | undefined)?.[
        CLIENT_UID
      ]?.[TENANT_ID],
    ).toEqual({ label: 'Ana', claimedAt: 1 });
  });
});

describe('GET /api/client-workspaces', () => {
  it("returns 200 and only that uid's entries", async () => {
    const { app, auth, database } = buildTestApp();
    const uidAToken = 'uid-a-token';
    registerUser(auth, uidAToken, { uid: CLIENT_UID, email: 'a@test.com' });
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });
    // 260726-r7: listOwnedWorkspaces now self-heals a tenant whose
    // clientMembers/{tenantId} is gone, so a genuinely live workspace fixture
    // must seed the owner's membership row — exactly what flipTenantOwnership
    // writes at claim time.
    database.seed(`clientMembers/${TENANT_ID}/${CLIENT_UID}`, { role: 'owner', joinedAt: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/client-workspaces',
      headers: authHeader(uidAToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ tenantId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.tenantId).toBe(TENANT_ID);
  });

  it("returns 200 [] for a DIFFERENT uid with no index entries, never the first uid's list", async () => {
    const { app, auth, database } = buildTestApp();
    const uidAToken = 'uid-a-token';
    const uidBToken = 'uid-b-token';
    registerUser(auth, uidAToken, { uid: CLIENT_UID, email: 'a@test.com' });
    registerUser(auth, uidBToken, { uid: OTHER_CLIENT_UID, email: 'b@test.com' });
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${TENANT_ID}`, { label: 'Ana', claimedAt: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/client-workspaces',
      headers: authHeader(uidBToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns 401 with no authorization header', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/client-workspaces' });

    expect(response.statusCode).toBe(401);
  });
});
