import { describe, expect, it } from 'vitest';
import { clientHubRowSchema } from '@smash-tracker/shared';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('/api/coaching/clients', () => {
  it('creates, lists, archives, exports, and hard-deletes a managed client', async () => {
    const { app } = buildTestApp();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/coaching/clients',
      headers: authHeader(),
      payload: { label: 'Alex' },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created).toMatchObject({
      label: 'Alex',
      lastActivityAt: null,
      draftCount: 0,
      deliveryState: null,
      archivedAt: null,
      kind: 'ordinary',
    });
    // Phase 29 (RTEN-01): the 201 body must parse against the hub row
    // schema and carry the ordinary resolution for a freshly created
    // coaching tenant.
    const parsedCreated = clientHubRowSchema.safeParse(created);
    expect(parsedCreated.success).toBe(true);
    const clientId = created.clientId as string;

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients',
      headers: authHeader(),
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      {
        clientId,
        label: 'Alex',
        lastActivityAt: null,
        draftCount: 0,
        deliveryState: null,
        archivedAt: null,
        claimedAt: null,
        pendingInvitationExpiresAt: null,
        kind: 'ordinary',
      },
    ]);

    const exportResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/export`,
      headers: authHeader(),
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json()).toMatchObject({ clientId, label: 'Alex', matches: [] });

    const archiveResponse = await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${clientId}/archive`,
      headers: authHeader(),
    });
    expect(archiveResponse.statusCode).toBe(204);

    const listAfterArchive = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients',
      headers: authHeader(),
    });
    expect(listAfterArchive.json()).toEqual([]);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/coaching/clients/${clientId}`,
      headers: authHeader(),
    });
    expect(deleteResponse.statusCode).toBe(204);
  });

  it('rejects a duplicate label for the same coach with 409', async () => {
    const { app } = buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/api/coaching/clients',
      headers: authHeader(),
      payload: { label: 'Alex' },
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/coaching/clients',
      headers: authHeader(),
      payload: { label: 'alex' },
    });

    expect(duplicate.statusCode).toBe(409);
  });

  it('rejects mutations from a coach with no membership record on the target client with 403', async () => {
    const { app, database } = buildTestApp();
    database.seed('clientTenants/tenant-1', { createdAt: 1, archivedAt: null });
    database.seed(`coachClients/${TEST_UID}-someone-else/tenant-1`, {
      label: 'Not yours',
      createdAt: 1,
    });
    // Deliberately no clientMembers/tenant-1/{TEST_UID} seed.

    const archiveResponse = await app.inject({
      method: 'PATCH',
      url: '/api/coaching/clients/tenant-1/archive',
      headers: authHeader(),
    });
    expect(archiveResponse.statusCode).toBe(403);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/coaching/clients/tenant-1',
      headers: authHeader(),
    });
    expect(deleteResponse.statusCode).toBe(403);

    const exportResponse = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-1/export',
      headers: authHeader(),
    });
    expect(exportResponse.statusCode).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/coaching/clients' });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/coaching/clients/:clientId/kind (Phase 29, RTEN-01/D-07)', () => {
  it('returns the ordinary resolution for a member of an ordinary tenant', async () => {
    const { app, database } = buildTestApp();
    database.seed('clientTenants/tenant-1', { createdAt: 1, archivedAt: null });
    database.seed(`clientMembers/tenant-1/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-1/kind',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'ordinary' });
  });

  it('returns the research resolution for an ALLOWLISTED member of an ARCHIVED research tenant', async () => {
    const { app, database } = buildTestApp({ research: { adminUids: new Set([TEST_UID]) } });
    database.seed('clientTenants/tenant-1', {
      createdAt: 1,
      archivedAt: Date.now(),
      kind: 'research',
    });
    database.seed(`clientMembers/tenant-1/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-1/kind',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'research' });
  });

  it('returns the existing membership rejection, deep-equal to a genuine non-member, for a non-allowlisted member of a research tenant', async () => {
    const { app, database } = buildTestApp();
    database.seed('clientTenants/tenant-1', { createdAt: 1, archivedAt: null, kind: 'research' });
    database.seed(`clientMembers/tenant-1/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });
    database.seed('clientTenants/tenant-2', { createdAt: 1, archivedAt: null });
    // Deliberately no clientMembers/tenant-2/{TEST_UID} — genuine non-member.

    const deniedResponse = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-1/kind',
      headers: authHeader(),
    });
    const nonMemberResponse = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-2/kind',
      headers: authHeader(),
    });

    expect(deniedResponse.statusCode).toBe(403);
    expect(nonMemberResponse.statusCode).toBe(403);
    expect(deniedResponse.body).toBe(nonMemberResponse.body);
  });

  it('rejects a path-illegal clientId with the same rejection as a non-member, never a 500', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${encodeURIComponent('tenant.illegal')}/kind`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(403);
  });

  it('answers a server error (not 200, not 403) when the caller IS a member but the kind cannot be resolved', async () => {
    const { app, database } = buildTestApp();
    database.seed(`clientMembers/tenant-1/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });
    // Corrupt/unparseable stored kind -> readSubjectKind resolves 'unresolved'.
    database.seed('clientTenants/tenant-1', { createdAt: 1, archivedAt: null, kind: 'bogus' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-1/kind',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(500);
  });

  it('rejects a non-member with 403 (no membership record at all)', async () => {
    const { app, database } = buildTestApp();
    database.seed('clientTenants/tenant-1', { createdAt: 1, archivedAt: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients/tenant-1/kind',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('GET /api/coaching/clients — research row filtering (Phase 29, review consensus finding 1)', () => {
  it('hides a research row from a non-allowlisted caller and shows it to an allowlisted one', async () => {
    const { app, database } = buildTestApp({ research: { adminUids: new Set([TEST_UID]) } });
    database.seed(`coachClients/${TEST_UID}/tenant-research`, {
      label: 'Research Client',
      createdAt: 1,
      archivedAt: null,
    });
    database.seed('clientTenants/tenant-research', {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
    database.seed(`clientMembers/tenant-research/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });

    const allowlistedResponse = await app.inject({
      method: 'GET',
      url: '/api/coaching/clients',
      headers: authHeader(),
    });
    expect(allowlistedResponse.json()).toHaveLength(1);
    expect(allowlistedResponse.json()[0]).toMatchObject({ kind: 'research' });

    const { app: nonAdminApp, database: nonAdminDatabase } = buildTestApp();
    nonAdminDatabase.seed(`coachClients/${TEST_UID}/tenant-research`, {
      label: 'Research Client',
      createdAt: 1,
      archivedAt: null,
    });
    nonAdminDatabase.seed('clientTenants/tenant-research', {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
    nonAdminDatabase.seed(`clientMembers/tenant-research/${TEST_UID}`, {
      role: 'custodian',
      joinedAt: 1,
    });

    const nonAdminResponse = await nonAdminApp.inject({
      method: 'GET',
      url: '/api/coaching/clients',
      headers: authHeader(),
    });
    expect(nonAdminResponse.json()).toEqual([]);
  });
});
