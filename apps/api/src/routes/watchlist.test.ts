import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';

const TENANT_ID = 'tenant-abc';

/** A membership + an ordinary tenant record, so `X-Active-Subject: client:<TENANT_ID>` resolves for TEST_UID. */
function seedClientTenant(database: FakeDatabase, tenantId: string = TENANT_ID): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'coaching' });
  database.seed(`clientMembers/${tenantId}/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });
}

function clientHeaders(tenantId: string = TENANT_ID): Record<string, string> {
  return { ...authHeader(), 'x-active-subject': `client:${tenantId}` };
}

describe('watchlist routes — tracer (subject-scoped persistence)', () => {
  it('rejects unauthenticated requests on every route', async () => {
    const { app } = buildTestApp();

    const get = await app.inject({ method: 'GET', url: '/api/watchlist' });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/watchlist/items',
      payload: { kind: 'stage', ref: 3 },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/watchlist/items/stage:3' });

    expect(get.statusCode).toBe(401);
    expect(put.statusCode).toBe(401);
    expect(del.statusCode).toBe(401);
  });

  it('returns an empty list when nothing is tracked', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/watchlist',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('an own-account PUT persists at watchlist/<uid> and GET returns exactly that item', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/watchlist/items',
      headers: authHeader(),
      payload: { kind: 'opponent', ref: 'izaw' },
    });

    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.itemKey).toBe('opponent:izaw');
    expect(body.item).toMatchObject({ kind: 'opponent', ref: 'izaw' });
    expect(body.item.createdAt).toBeGreaterThanOrEqual(before);
    expect(body.item).not.toHaveProperty('note');
    expect(database.dump()).toMatchObject({
      watchlist: { [TEST_UID]: { 'opponent:izaw': { kind: 'opponent', ref: 'izaw' } } },
    });

    const get = await app.inject({ method: 'GET', url: '/api/watchlist', headers: authHeader() });
    expect(get.statusCode).toBe(200);
    expect(get.json().items).toEqual([{ itemKey: 'opponent:izaw', item: body.item }]);
  });

  it('a coach tracking for a client writes under watchlist/<tenant> only, and the two lists never mix', async () => {
    const { app, database } = buildTestApp();
    seedClientTenant(database);

    const own = await app.inject({
      method: 'PUT',
      url: '/api/watchlist/items',
      headers: authHeader(),
      payload: { kind: 'opponent', ref: 'coachrival' },
    });
    const forClient = await app.inject({
      method: 'PUT',
      url: '/api/watchlist/items',
      headers: clientHeaders(),
      payload: { kind: 'matchup', ref: { fighterId: 3, vsFighterId: 9 } },
    });
    expect(own.statusCode).toBe(200);
    expect(forClient.statusCode).toBe(200);
    expect(forClient.json().itemKey).toBe('matchup:3-9');

    const tree = (database.dump() as { watchlist: Record<string, Record<string, unknown>> })
      .watchlist;
    expect(Object.keys(tree[TENANT_ID])).toEqual(['matchup:3-9']);
    expect(Object.keys(tree[TEST_UID])).toEqual(['opponent:coachrival']);

    // Both directions: the own list excludes the client's item...
    const ownList = await app.inject({
      method: 'GET',
      url: '/api/watchlist',
      headers: authHeader(),
    });
    expect(ownList.json().items.map((entry: { itemKey: string }) => entry.itemKey)).toEqual([
      'opponent:coachrival',
    ]);
    // ...and the client's list excludes the own item.
    const clientList = await app.inject({
      method: 'GET',
      url: '/api/watchlist',
      headers: clientHeaders(),
    });
    expect(clientList.json().items.map((entry: { itemKey: string }) => entry.itemKey)).toEqual([
      'matchup:3-9',
    ]);
  });

  it('DELETE removes only the addressed key, in only the addressed subject', async () => {
    const { app, database } = buildTestApp();
    seedClientTenant(database);
    for (const payload of [
      { kind: 'stage', ref: 3 },
      { kind: 'stage', ref: 4 },
    ]) {
      await app.inject({
        method: 'PUT',
        url: '/api/watchlist/items',
        headers: authHeader(),
        payload,
      });
    }
    await app.inject({
      method: 'PUT',
      url: '/api/watchlist/items',
      headers: clientHeaders(),
      payload: { kind: 'stage', ref: 3 },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/watchlist/items/stage:3',
      headers: authHeader(),
    });

    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ itemKey: 'stage:3' });
    const tree = (database.dump() as { watchlist: Record<string, Record<string, unknown>> })
      .watchlist;
    expect(Object.keys(tree[TEST_UID])).toEqual(['stage:4']);
    expect(Object.keys(tree[TENANT_ID])).toEqual(['stage:3']);
  });

  it('untracking an item that is not tracked is a no-op success', async () => {
    const { app } = buildTestApp();

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/watchlist/items/stage:99',
      headers: authHeader(),
    });

    expect(del.statusCode).toBe(200);
  });
});
