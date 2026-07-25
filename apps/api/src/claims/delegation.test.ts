import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ForbiddenError } from '../services/rtdb.js';
import { revokeCoachDelegation } from './delegation.js';
import { authHeader, buildTestApp } from '../test-support/testApp.js';

const TENANT_ID = 'tenant-1';
const OWNER_UID = 'owner-1';
const DELEGATE_UID = 'delegate-1';
const CUSTODIAN_UID = 'custodian-1';
const STRANGER_UID = 'stranger-1';
const SESSION_ID = 'session-1';

const OWNER_TOKEN = 'owner-token';
const DELEGATE_TOKEN = 'delegate-token';

/**
 * D-class emission (`void createEvent(...)`) is intentionally fire-and-forget
 * — callers never await it. Flush the macrotask queue before asserting on
 * `eventLedger`, mirroring `apps/api/src/claims/invitations.test.ts`.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function seedMembership(
  database: FakeDatabase,
  tenantId: string,
  uid: string,
  role: 'custodian' | 'owner' | 'delegate',
): void {
  database.seed(`clientMembers/${tenantId}/${uid}`, { role, joinedAt: 1 });
}

function eventLedgerEntries(database: FakeDatabase, eventName: string): unknown[] {
  const dump = database.dump() as Record<string, unknown>;
  const ledgerByDay = dump.eventLedger as Record<string, Record<string, unknown>> | undefined;
  if (!ledgerByDay) return [];
  return Object.values(ledgerByDay).flatMap((dayEntries) =>
    Object.values(dayEntries).filter(
      (entry) => (entry as { eventName?: string }).eventName === eventName,
    ),
  );
}

describe('revokeCoachDelegation', () => {
  it("removes clientMembers/{tenantId}/{delegateUid} and coachClients/{delegateUid}/{tenantId}, leaving the owner's own membership and content trees untouched", async () => {
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, DELEGATE_UID, 'delegate');
    database.seed(`coachClients/${DELEGATE_UID}/${TENANT_ID}`, {
      label: 'Alex',
      createdAt: 1,
      archivedAt: null,
    });
    database.seed(`matches/${TENANT_ID}/m1`, { seeded: true });

    await revokeCoachDelegation(database as never, OWNER_UID, TENANT_ID, DELEGATE_UID, {
      sessionId: SESSION_ID,
    });

    const dump = database.dump() as Record<string, unknown>;
    expect((dump.clientMembers as Record<string, unknown>)[TENANT_ID]).not.toHaveProperty(
      DELEGATE_UID,
    );
    expect(
      (dump.coachClients as Record<string, unknown> | undefined)?.[DELEGATE_UID],
    ).not.toHaveProperty(TENANT_ID);
    const tenantMembers = (dump.clientMembers as Record<string, Record<string, unknown>>)[
      TENANT_ID
    ];
    expect(tenantMembers?.[OWNER_UID]).toMatchObject({ role: 'owner' });
    expect((dump.matches as Record<string, Record<string, unknown>>)[TENANT_ID]).toEqual({
      m1: { seeded: true },
    });
  });

  it('rejects when called by a custodian, a delegate, or a non-member, all with the same message', async () => {
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, DELEGATE_UID, 'delegate');
    seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');

    const custodianError = await revokeCoachDelegation(
      database as never,
      CUSTODIAN_UID,
      TENANT_ID,
      DELEGATE_UID,
      { sessionId: SESSION_ID },
    ).catch((err: unknown) => err);
    const delegateError = await revokeCoachDelegation(
      database as never,
      DELEGATE_UID,
      TENANT_ID,
      DELEGATE_UID,
      { sessionId: SESSION_ID },
    ).catch((err: unknown) => err);
    const strangerError = await revokeCoachDelegation(
      database as never,
      STRANGER_UID,
      TENANT_ID,
      DELEGATE_UID,
      { sessionId: SESSION_ID },
    ).catch((err: unknown) => err);

    expect(custodianError).toBeInstanceOf(ForbiddenError);
    expect(delegateError).toBeInstanceOf(ForbiddenError);
    expect(strangerError).toBeInstanceOf(ForbiddenError);
    expect((custodianError as Error).message).toBe((delegateError as Error).message);
    expect((delegateError as Error).message).toBe((strangerError as Error).message);
  });

  it('rejects targeting a member whose role is custodian', async () => {
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');

    await expect(
      revokeCoachDelegation(database as never, OWNER_UID, TENANT_ID, CUSTODIAN_UID, {
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects targeting a uid with no membership record', async () => {
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');

    await expect(
      revokeCoachDelegation(database as never, OWNER_UID, TENANT_ID, STRANGER_UID, {
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a self-revoke', async () => {
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');

    await expect(
      revokeCoachDelegation(database as never, OWNER_UID, TENANT_ID, OWNER_UID, {
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('emits coach_delegation_revoked with a content-free payload after the write commits', async () => {
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, DELEGATE_UID, 'delegate');

    await revokeCoachDelegation(database as never, OWNER_UID, TENANT_ID, DELEGATE_UID, {
      sessionId: SESSION_ID,
    });
    await flush();

    const rows = eventLedgerEntries(database, 'coach_delegation_revoked');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventName: 'coach_delegation_revoked',
      actorId: OWNER_UID,
      causationId: `${TENANT_ID}:${DELEGATE_UID}:revoked`,
      consentState: 'unknown',
      payload: { reason: 'client_initiated' },
    });
    expect(JSON.stringify(rows[0])).not.toMatch(/label|Alex/i);
  });
});

describe('DELETE /api/client-workspaces/:tenantId/delegations/:delegateUid (live revocation)', () => {
  it("the coach's next identical request 403s immediately after the owner revokes, on the same app instance", async () => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(OWNER_TOKEN, { uid: OWNER_UID, email: 'owner@test.com' });
    auth.registerToken(DELEGATE_TOKEN, { uid: DELEGATE_UID, email: 'delegate@test.com' });
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, DELEGATE_UID, 'delegate');
    database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });

    const beforeRevoke = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { ...authHeader(DELEGATE_TOKEN), 'x-active-subject': `client:${TENANT_ID}` },
    });
    expect(beforeRevoke.statusCode).not.toBe(403);

    const revokeResponse = await app.inject({
      method: 'DELETE',
      url: `/api/client-workspaces/${TENANT_ID}/delegations/${DELEGATE_UID}`,
      headers: authHeader(OWNER_TOKEN),
    });
    expect(revokeResponse.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { ...authHeader(DELEGATE_TOKEN), 'x-active-subject': `client:${TENANT_ID}` },
    });
    expect(afterRevoke.statusCode).toBe(403);
  });

  it('returns 403 with identical bodies for a custodian, a delegate, and a non-member caller', async () => {
    const { app, auth, database } = buildTestApp();
    const custodianToken = 'custodian-token';
    const strangerToken = 'stranger-token';
    auth.registerToken(OWNER_TOKEN, { uid: OWNER_UID, email: 'owner@test.com' });
    auth.registerToken(DELEGATE_TOKEN, { uid: DELEGATE_UID, email: 'delegate@test.com' });
    auth.registerToken(custodianToken, { uid: CUSTODIAN_UID, email: 'custodian@test.com' });
    auth.registerToken(strangerToken, { uid: STRANGER_UID, email: 'stranger@test.com' });
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, DELEGATE_UID, 'delegate');
    seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');

    const custodianResponse = await app.inject({
      method: 'DELETE',
      url: `/api/client-workspaces/${TENANT_ID}/delegations/${DELEGATE_UID}`,
      headers: authHeader(custodianToken),
    });
    const delegateResponse = await app.inject({
      method: 'DELETE',
      url: `/api/client-workspaces/${TENANT_ID}/delegations/${DELEGATE_UID}`,
      headers: authHeader(DELEGATE_TOKEN),
    });
    const strangerResponse = await app.inject({
      method: 'DELETE',
      url: `/api/client-workspaces/${TENANT_ID}/delegations/${DELEGATE_UID}`,
      headers: authHeader(strangerToken),
    });

    expect(custodianResponse.statusCode).toBe(403);
    expect(delegateResponse.statusCode).toBe(403);
    expect(strangerResponse.statusCode).toBe(403);
    expect(custodianResponse.body).toBe(delegateResponse.body);
    expect(delegateResponse.body).toBe(strangerResponse.body);
  });

  it('returns 403 when the revoke targets a custodian member', async () => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(OWNER_TOKEN, { uid: OWNER_UID, email: 'owner@test.com' });
    seedMembership(database, TENANT_ID, OWNER_UID, 'owner');
    seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/client-workspaces/${TENANT_ID}/delegations/${CUSTODIAN_UID}`,
      headers: authHeader(OWNER_TOKEN),
    });

    expect(response.statusCode).toBe(403);
  });
});
