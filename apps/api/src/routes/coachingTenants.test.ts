import { describe, expect, it } from 'vitest';
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
    });
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
