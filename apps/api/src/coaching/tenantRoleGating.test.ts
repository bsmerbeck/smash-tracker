import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

const TENANT_ID = 'tenant-1';
const COACH_TOKEN = 'coach-token';
const COACH_UID = 'coach-1';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CLAIM-03): a
 * dedicated HTTP-level regression suite proving the three-sided property in
 * one place — a demoted `delegate` coach is denied the destructive routes,
 * a `delegate` KEEPS every collaborative route (the coaching relationship
 * this milestone exists to preserve), and a pre-claim `custodian`'s
 * behavior is unchanged on every one of the six routes below (no Phase
 * 11/12/20 regression). See `apps/api/src/coaching/tenants.ts`'s
 * `archiveClient` doc comment for the full rationale.
 */

const DESTRUCTIVE_ROUTES = [
  { method: 'PATCH' as const, path: `/api/coaching/clients/${TENANT_ID}/archive` },
  { method: 'DELETE' as const, path: `/api/coaching/clients/${TENANT_ID}` },
  { method: 'GET' as const, path: `/api/coaching/clients/${TENANT_ID}/export` },
];

const COLLABORATIVE_ROUTES = [
  {
    method: 'GET' as const,
    path: `/api/coaching/clients/${TENANT_ID}/reviews`,
    usesSubjectHeader: false,
  },
  {
    method: 'GET' as const,
    path: `/api/coaching/clients/${TENANT_ID}/sessions`,
    usesSubjectHeader: false,
  },
  { method: 'GET' as const, path: '/api/matches', usesSubjectHeader: true },
];

function seedTenant(database: ReturnType<typeof buildTestApp>['database'], role: string): void {
  database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });
  database.seed(`coachClients/${COACH_UID}/${TENANT_ID}`, {
    label: 'Alex',
    createdAt: 1,
    archivedAt: null,
  });
  database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role, joinedAt: 1 });
}

describe('a delegate coach is denied the destructive routes', () => {
  it.each(DESTRUCTIVE_ROUTES)('$method $path returns 403', async (route) => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'coach@test.com' });
    seedTenant(database, 'delegate');

    const response = await app.inject({
      method: route.method,
      url: route.path,
      headers: { authorization: `Bearer ${COACH_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('an owner member gets 204/204/200 rather than 403 on all three destructive routes', async () => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'owner@test.com' });
    seedTenant(database, 'owner');

    const archiveResponse = await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${TENANT_ID}/archive`,
      headers: { authorization: `Bearer ${COACH_TOKEN}` },
    });
    expect(archiveResponse.statusCode).toBe(204);

    const exportResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${TENANT_ID}/export`,
      headers: { authorization: `Bearer ${COACH_TOKEN}` },
    });
    expect(exportResponse.statusCode).toBe(200);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/coaching/clients/${TENANT_ID}`,
      headers: { authorization: `Bearer ${COACH_TOKEN}` },
    });
    expect(deleteResponse.statusCode).toBe(204);
  });
});

describe('a delegate coach keeps the collaborative routes', () => {
  it.each(COLLABORATIVE_ROUTES)('$method $path is non-403', async (route) => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'coach@test.com' });
    seedTenant(database, 'delegate');

    const response = await app.inject({
      method: route.method,
      url: route.path,
      headers: {
        authorization: `Bearer ${COACH_TOKEN}`,
        ...(route.usesSubjectHeader ? { 'x-active-subject': `client:${TENANT_ID}` } : {}),
      },
    });

    expect(response.statusCode).not.toBe(403);
  });
});

describe('a custodian coach is unaffected (no Phase 11/12/20 regression)', () => {
  it.each([...DESTRUCTIVE_ROUTES, ...COLLABORATIVE_ROUTES])(
    '$method $path is non-403',
    async (route) => {
      const { app, auth, database } = buildTestApp();
      auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'coach@test.com' });
      seedTenant(database, 'custodian');

      const response = await app.inject({
        method: route.method,
        url: route.path,
        headers: {
          authorization: `Bearer ${COACH_TOKEN}`,
          ...('usesSubjectHeader' in route && route.usesSubjectHeader
            ? { 'x-active-subject': `client:${TENANT_ID}` }
            : {}),
        },
      });

      expect(response.statusCode).not.toBe(403);
    },
  );
});

describe('deleteClient hard-delete cascade also destroys an outstanding claim invitation', () => {
  it('removes both claimInvitations/{digest} and activeClaimInvitationByTenant/{tenantId} from the same cascade', async () => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'coach@test.com' });
    seedTenant(database, 'custodian');
    const digest = 'a-digest-abc123';
    database.seed(`claimInvitations/${digest}`, {
      tenantId: TENANT_ID,
      issuerUid: COACH_UID,
      createdAt: 1,
      expiresAt: Date.now() + 1000,
    });
    database.seed(`activeClaimInvitationByTenant/${TENANT_ID}`, {
      digest,
      issuedAt: 1,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/coaching/clients/${TENANT_ID}`,
      headers: { authorization: `Bearer ${COACH_TOKEN}` },
    });
    expect(response.statusCode).toBe(204);

    const dump = database.dump() as Record<string, unknown>;
    expect(
      (dump.claimInvitations as Record<string, unknown> | undefined)?.[digest],
    ).toBeUndefined();
    expect(
      (dump.activeClaimInvitationByTenant as Record<string, unknown> | undefined)?.[TENANT_ID],
    ).toBeUndefined();
  });

  it('behaves exactly as before when no invitation is outstanding', async () => {
    const { app, auth, database } = buildTestApp();
    auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'coach@test.com' });
    seedTenant(database, 'custodian');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/coaching/clients/${TENANT_ID}`,
      headers: { authorization: `Bearer ${COACH_TOKEN}` },
    });

    expect(response.statusCode).toBe(204);
  });
});
