import { describe, expect, it, vi } from 'vitest';
import { WATCHLIST_MAX_ITEMS } from '@smash-tracker/shared';
import { createClient } from '../coaching/tenants.js';
import { RtdbService } from '../services/rtdb.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';

const TENANT_ID = 'tenant-abc';

/** A membership + an ordinary tenant record, so `X-Active-Subject: client:<TENANT_ID>` resolves for TEST_UID. */
function seedClientTenant(database: FakeDatabase, tenantId: string = TENANT_ID): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'coaching' });
  database.seed(`clientMembers/${tenantId}/${TEST_UID}`, { role: 'custodian', joinedAt: 1 });
}

/** The stored `watchlist/<subjectId>` map, or `{}` when the subject has none. */
function subjectTree(database: FakeDatabase, subjectId: string): Record<string, unknown> {
  const tree = (database.dump() as { watchlist?: Record<string, Record<string, unknown>> })
    .watchlist;
  return tree?.[subjectId] ?? {};
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

    expect(Object.keys(subjectTree(database, TENANT_ID))).toEqual(['matchup:3-9']);
    expect(Object.keys(subjectTree(database, TEST_UID))).toEqual(['opponent:coachrival']);

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
    expect(Object.keys(subjectTree(database, TEST_UID))).toEqual(['stage:4']);
    expect(Object.keys(subjectTree(database, TENANT_ID))).toEqual(['stage:3']);
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

/** `count` distinct stage items keyed `stage:1..count`, each with a distinct createdAt. */
function stageMap(count: number): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (let n = 1; n <= count; n += 1) {
    map[`stage:${n}`] = { kind: 'stage', ref: n, createdAt: n };
  }
  return map;
}

function putItem(
  app: ReturnType<typeof buildTestApp>['app'],
  payload: object,
  headers: Record<string, string> = authHeader(),
) {
  return app.inject({ method: 'PUT', url: '/api/watchlist/items', headers, payload });
}

describe('watchlist cap, idempotency and input hardening', () => {
  it('refuses the 26th distinct item with 409 watchlist-full and leaves the map byte-identical', async () => {
    const { app, database } = buildTestApp();
    database.seed(`watchlist/${TEST_UID}`, stageMap(WATCHLIST_MAX_ITEMS));
    const before = structuredClone(database.dump());

    const response = await putItem(app, { kind: 'stage', ref: 26 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ statusCode: 409, code: 'watchlist-full' });
    expect(database.dump()).toEqual(before);
    const stored = subjectTree(database, TEST_UID);
    expect(Object.keys(stored)).toHaveLength(WATCHLIST_MAX_ITEMS);
  });

  it('never evicts: a full list still accepts a re-track of an item it already holds', async () => {
    const { app, database } = buildTestApp();
    database.seed(`watchlist/${TEST_UID}`, stageMap(WATCHLIST_MAX_ITEMS));
    const before = structuredClone(database.dump());

    const response = await putItem(app, { kind: 'stage', ref: 7 });

    expect(response.statusCode).toBe(200);
    expect(database.dump()).toEqual(before);
  });

  it('two concurrent taps of different new items on a 24-item list leave exactly 25 and one 409', async () => {
    const { app, database } = buildTestApp();
    database.seed(`watchlist/${TEST_UID}`, stageMap(WATCHLIST_MAX_ITEMS - 1));

    const [a, b] = await Promise.all([
      putItem(app, { kind: 'stage', ref: 100 }),
      putItem(app, { kind: 'stage', ref: 101 }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const stored = subjectTree(database, TEST_UID);
    expect(Object.keys(stored)).toHaveLength(WATCHLIST_MAX_ITEMS);
  });

  // 39.2 code review API-WR-03: the cap counts only the items GET lists. A
  // child the GET hides as corrupt (a bad value, or a key this build does not
  // know, e.g. a newer kind after a rollback) is left untouched and uncounted,
  // so the user is never refused at fewer than 25 visible items.
  describe('corrupt stored children and the cap (API-WR-03)', () => {
    const CORRUPT_VALUE = { 'stage:900': { kind: 'stage', ref: 'not-a-number', createdAt: 1 } };
    const UNKNOWN_KEY = { 'tournament:1': { kind: 'tournament', ref: 1, createdAt: 1 } };

    async function listedKeys(app: ReturnType<typeof buildTestApp>['app']): Promise<string[]> {
      const response = await app.inject({
        method: 'GET',
        url: '/api/watchlist',
        headers: authHeader(),
      });
      return response.json().items.map((entry: { itemKey: string }) => entry.itemKey);
    }

    it.each([
      ['a corrupt value', CORRUPT_VALUE],
      ['an unknown key', UNKNOWN_KEY],
    ])('24 listed items plus %s: tracking a 25th answers 200', async (_label, corrupt) => {
      const { app, database } = buildTestApp();
      database.seed(`watchlist/${TEST_UID}`, { ...stageMap(WATCHLIST_MAX_ITEMS - 1), ...corrupt });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(await listedKeys(app)).toHaveLength(WATCHLIST_MAX_ITEMS - 1);
      const response = await putItem(app, { kind: 'stage', ref: 500 });

      expect(response.statusCode).toBe(200);
      expect(await listedKeys(app)).toHaveLength(WATCHLIST_MAX_ITEMS);
      // The hidden child is neither counted nor silently deleted.
      expect(subjectTree(database, TEST_UID)).toMatchObject(corrupt);
      warn.mockRestore();
    });

    it('25 listed items plus a corrupt child: a 26th distinct item is still refused with 409', async () => {
      const { app, database } = buildTestApp();
      database.seed(`watchlist/${TEST_UID}`, { ...stageMap(WATCHLIST_MAX_ITEMS), ...UNKNOWN_KEY });
      const before = structuredClone(database.dump());

      const response = await putItem(app, { kind: 'stage', ref: 500 });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'watchlist-full' });
      expect(database.dump()).toEqual(before);
    });

    it('1 listed item plus 24 corrupt children: the user can still track', async () => {
      const { app, database } = buildTestApp();
      const corrupt: Record<string, unknown> = {};
      for (let n = 1; n <= WATCHLIST_MAX_ITEMS - 1; n += 1) {
        corrupt[`stage:${900 + n}`] = { kind: 'stage', ref: 'bad', createdAt: n };
      }
      database.seed(`watchlist/${TEST_UID}`, { ...stageMap(1), ...corrupt });

      const response = await putItem(app, { kind: 'stage', ref: 500 });

      expect(response.statusCode).toBe(200);
    });

    it('25 listed items: repairing a corrupt child under the requested key is refused, never a 26th listed item', async () => {
      const { app, database } = buildTestApp();
      database.seed(`watchlist/${TEST_UID}`, {
        ...stageMap(WATCHLIST_MAX_ITEMS),
        'stage:500': { kind: 'stage', ref: 'bad', createdAt: 1 },
      });

      const response = await putItem(app, { kind: 'stage', ref: 500 });

      expect(response.statusCode).toBe(409);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await listedKeys(app)).toHaveLength(WATCHLIST_MAX_ITEMS);
      warn.mockRestore();
    });

    it('24 listed items: a corrupt child under the requested key is repaired in place (200, 25 listed)', async () => {
      const { app, database } = buildTestApp();
      database.seed(`watchlist/${TEST_UID}`, {
        ...stageMap(WATCHLIST_MAX_ITEMS - 1),
        'stage:500': { kind: 'stage', ref: 'bad', createdAt: 1 },
      });

      const response = await putItem(app, { kind: 'stage', ref: 500 });

      expect(response.statusCode).toBe(200);
      expect(await listedKeys(app)).toHaveLength(WATCHLIST_MAX_ITEMS);
    });
  });

  it('the transaction body aborts (undefined) on a 25-item map and adds exactly one key to a 24-item map', async () => {
    const { database } = buildTestApp();
    const updateFns: Array<(current: unknown) => unknown> = [];
    const originalRef = database.ref.bind(database);
    vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
      const ref = originalRef(path);
      if (path?.startsWith('watchlist/')) {
        const originalTransaction = ref.transaction.bind(ref);
        ref.transaction = ((updateFn: (current: unknown) => unknown) => {
          updateFns.push(updateFn);
          return originalTransaction(updateFn);
        }) as typeof ref.transaction;
      }
      return ref;
    });
    const service = new RtdbService(database as never);

    await service.trackWatchlistItem('u1', { kind: 'stage', ref: 500 });
    const decide = updateFns[0]!;
    // null is the first run of every transaction: it must become a one-item map, not an abort.
    expect(Object.keys(decide(null) as Record<string, unknown>)).toEqual(['stage:500']);
    // Full map, different key: abort.
    expect(decide(stageMap(WATCHLIST_MAX_ITEMS))).toBeUndefined();
    // Room for exactly one more.
    const grown = decide(stageMap(WATCHLIST_MAX_ITEMS - 1)) as Record<string, unknown>;
    expect(Object.keys(grown)).toHaveLength(WATCHLIST_MAX_ITEMS);
    expect(grown).toHaveProperty('stage:500');
  });

  it('re-tracking an item answers 200 with the ORIGINAL createdAt and does not change the map', async () => {
    const { app, database } = buildTestApp();
    database.seed(`watchlist/${TEST_UID}`, {
      'opponent:izaw': { kind: 'opponent', ref: 'izaw', createdAt: 42 },
    });
    const before = structuredClone(database.dump());

    const response = await putItem(app, { kind: 'opponent', ref: 'IzAw' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      itemKey: 'opponent:izaw',
      item: { kind: 'opponent', ref: 'izaw', createdAt: 42 },
    });
    expect(database.dump()).toEqual(before);
  });

  it('ignores a client-supplied itemKey and createdAt: the key is server-derived and createdAt is the server clock', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const response = await putItem(app, {
      kind: 'stage',
      ref: 3,
      itemKey: 'opponent:evil',
      createdAt: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().itemKey).toBe('stage:3');
    expect(response.json().item.createdAt).toBeGreaterThanOrEqual(before);
    const stored = subjectTree(database, TEST_UID);
    expect(Object.keys(stored)).toEqual(['stage:3']);
  });

  it('refuses an opponent ref containing / or # with 400 and writes nothing', async () => {
    const { app, database } = buildTestApp();
    const before = structuredClone(database.dump());

    for (const ref of ['a/b', 'a#b', 'a.b', 'a$b', 'a[b', 'a]b', '   ']) {
      const response = await putItem(app, { kind: 'opponent', ref });
      expect(response.statusCode).toBe(400);
    }

    expect(database.dump()).toEqual(before);
  });

  // 39.2 code review API-IN-02: a DEL passed the input schema but failed the
  // stored parse inside the service, which surfaced as an unmapped 500.
  it('refuses an opponent ref containing a DEL (U+007F) with 400 and writes nothing', async () => {
    const { app, database } = buildTestApp();
    const before = structuredClone(database.dump());

    for (const ref of ['a\u007fb', 'mkleo\u007f']) {
      const response = await putItem(app, { kind: 'opponent', ref });
      expect(response.statusCode, JSON.stringify(ref)).toBe(400);
    }

    expect(database.dump()).toEqual(before);
  });

  it('refuses an unknown kind and a non-positive stage with 400', async () => {
    const { app } = buildTestApp();

    expect((await putItem(app, { kind: 'tournament', ref: 1 })).statusCode).toBe(400);
    expect((await putItem(app, { kind: 'stage', ref: 0 })).statusCode).toBe(400);
  });

  it('refuses a DELETE whose itemKey does not match the key pattern with 400 and deletes nothing', async () => {
    const { app, database } = buildTestApp();
    database.seed(`watchlist/${TEST_UID}`, stageMap(2));
    const before = structuredClone(database.dump());

    for (const itemKey of ['garbage', 'opponent:a%23b', 'stage:abc', 'matchup:1']) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/watchlist/items/${itemKey}`,
        headers: authHeader(),
      });
      expect(response.statusCode).toBe(400);
    }

    expect(database.dump()).toEqual(before);
  });

  it('GET skips a corrupt stored child, returns the valid ones with 200, and logs no value', async () => {
    const { app, database } = buildTestApp();
    database.seed(`watchlist/${TEST_UID}`, {
      'stage:1': { kind: 'stage', ref: 1, createdAt: 2 },
      'stage:2': { kind: 'stage', ref: 'not-a-number', createdAt: 1 },
      'opponent:secretrival': { kind: 'opponent', ref: 'SecretRival', createdAt: 3 },
      'stage:3': { kind: 'stage', ref: 3, createdAt: 1 },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/api/watchlist',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    // Sorted by createdAt then itemKey; the two corrupt children are gone.
    expect(response.json().items.map((entry: { itemKey: string }) => entry.itemKey)).toEqual([
      'stage:3',
      'stage:1',
    ]);
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('skipped a corrupt watchlist child');
    expect(logged).not.toContain('secretrival');
    expect(logged).not.toContain('SecretRival');
    expect(logged).not.toContain('not-a-number');
    expect(logged).not.toContain(TEST_UID);
    warn.mockRestore();
  });

  it('a delegate whose clientMembers row is removed gets 403 on the very next request', async () => {
    const { app, database } = buildTestApp();
    seedClientTenant(database);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/watchlist',
      headers: clientHeaders(),
    });
    expect(allowed.statusCode).toBe(200);

    await database.ref(`clientMembers/${TENANT_ID}/${TEST_UID}`).remove();

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/watchlist',
      headers: clientHeaders(),
    });
    expect(revoked.statusCode).toBe(403);
    const revokedWrite = await putItem(app, { kind: 'stage', ref: 3 }, clientHeaders());
    expect(revokedWrite.statusCode).toBe(403);
    expect(database.dump()).not.toHaveProperty('watchlist');
  });
});

describe('watchlist and the client workspace lifecycle', () => {
  async function createTenantWithTwoItems() {
    const built = buildTestApp();
    const { tenantId } = await createClient(built.database as never, TEST_UID, 'Alex', {
      sessionId: 'session-1',
    });
    for (const payload of [
      { kind: 'opponent', ref: 'izaw' },
      { kind: 'matchup', ref: { fighterId: 3, vsFighterId: 9 } },
    ]) {
      const response = await putItem(built.app, payload, clientHeaders(tenantId));
      expect(response.statusCode).toBe(200);
    }
    return { ...built, tenantId };
  }

  it('the client workspace export carries both tracked items', async () => {
    const { app, tenantId } = await createTenantWithTwoItems();

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${tenantId}/export`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const keys = response
      .json()
      .watchlist.items.map((entry: { itemKey: string }) => entry.itemKey)
      .sort();
    expect(keys).toEqual(['matchup:3-9', 'opponent:izaw']);
  });

  it('a hard delete of the client tenant removes watchlist/<tenant> through the deletion cascade', async () => {
    const { app, database, tenantId } = await createTenantWithTwoItems();
    // The coach's own list is a different subject and must survive.
    await putItem(app, { kind: 'stage', ref: 3 });
    expect(database.dump()).toHaveProperty(['watchlist', tenantId]);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/coaching/clients/${tenantId}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    const tree = (database.dump() as { watchlist?: Record<string, unknown> }).watchlist ?? {};
    expect(tree).not.toHaveProperty(tenantId);
    expect(tree).toHaveProperty(TEST_UID);
  });
});
