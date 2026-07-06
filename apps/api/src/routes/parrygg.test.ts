import { describe, expect, it, vi } from 'vitest';
import { User } from '@parry-gg/client';
import type { ParryggConfig } from '../config/env.js';
import type { ParryggClients } from '../parrygg/client.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const CONFIG: ParryggConfig = { apiKey: 'test-api-key' };

function makeUser(fields: {
  id: string;
  gamerTag: string;
  bioMd?: string;
  avatarUrl?: string;
}): User {
  const user = new User();
  user.setId(fields.id);
  user.setGamerTag(fields.gamerTag);
  if (fields.bioMd) {
    user.setBioMd(fields.bioMd);
  }
  if (fields.avatarUrl) {
    user.setAvatarUrl(fields.avatarUrl);
  }
  return user;
}

/** Builds fake parry.gg service clients backed by an in-memory user store (mutable so tests can update bios). */
function fakeParryggClients(users: Map<string, User>): ParryggClients {
  return {
    users: {
      getUsers: vi.fn(async (request: { getFilter(): { getGamerTag(): string } }) => {
        const tag = request.getFilter().getGamerTag().toLowerCase();
        const matches = [...users.values()].filter((u) =>
          u.getGamerTag().toLowerCase().includes(tag),
        );
        return { getUsersList: () => matches };
      }),
      getUser: vi.fn(async (request: { getId(): string }) => {
        return { getUser: () => users.get(request.getId()) };
      }),
    } as unknown as ParryggClients['users'],
    matches: {
      getMatches: vi.fn(async () => ({ getMatchesList: () => [] })),
    } as unknown as ParryggClients['matches'],
  };
}

describe('parry.gg routes (unconfigured)', () => {
  it('answers 503 for every integration route', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/parrygg/status',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('parry.gg routes (configured)', () => {
  it('requires auth on every route', async () => {
    const { app } = buildTestApp({ parrygg: CONFIG });
    const response = await app.inject({ method: 'GET', url: '/api/integrations/parrygg/status' });
    expect(response.statusCode).toBe(401);
  });

  it('reports unlinked status, then linked-unverified after linking', async () => {
    const users = new Map([['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })]]);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    const before = await app.inject({
      method: 'GET',
      url: '/api/integrations/parrygg/status',
      headers: authHeader(),
    });
    expect(before.json()).toEqual({ linked: false });

    const link = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/link',
      headers: authHeader(),
      payload: { parryUserId: 'p1' },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ linked: true, gamerTag: 'Hungrybox', verified: false });

    const after = await app.inject({
      method: 'GET',
      url: '/api/integrations/parrygg/status',
      headers: authHeader(),
    });
    expect(after.json()).toMatchObject({ linked: true, gamerTag: 'Hungrybox', verified: false });
  });

  it('search returns candidates matching the gamer tag', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })],
      ['p2', makeUser({ id: 'p2', gamerTag: 'Mang0' })],
    ]);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/parrygg/search?tag=hungry',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'p1', gamerTag: 'Hungrybox' }]);
  });

  it('404s linking a parry.gg id that does not exist', async () => {
    const { app } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(new Map()),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/link',
      headers: authHeader(),
      payload: { parryUserId: 'missing' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('409s linking a parry.gg account already claimed by a different uid', async () => {
    const users = new Map([['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })]]);
    const { app, database } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(users),
    });
    database.seed('parryggUserIndex/p1', 'some-other-uid');

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/link',
      headers: authHeader(),
      payload: { parryUserId: 'p1' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('writes the link and reverse index atomically', async () => {
    const users = new Map([['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })]]);
    const { app, database } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(users),
    });

    await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/link',
      headers: authHeader(),
      payload: { parryUserId: 'p1' },
    });

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['parryggLinks']?.[TEST_UID]).toMatchObject({
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
    });
    expect(tree['parryggUserIndex']?.['p1']).toBe(TEST_UID);
  });

  it('unlinks, clearing the link, reverse index, and any pending verification', async () => {
    const { app, database } = buildTestApp({ parrygg: CONFIG });
    database.seed(`parryggLinks/${TEST_UID}`, {
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: false,
      linkedAt: 1000,
    });
    database.seed('parryggUserIndex/p1', TEST_UID);
    database.seed(`parryggVerifications/${TEST_UID}`, {
      code: 'ST-ABC123',
      expiresAt: Date.now() + 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/unlink',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(204);

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['parryggLinks']?.[TEST_UID]).toBeUndefined();
    expect(tree['parryggUserIndex']?.['p1']).toBeUndefined();
    expect(tree['parryggVerifications']?.[TEST_UID]).toBeUndefined();
  });

  it('409s sync/verify-start when nothing is linked', async () => {
    const { app } = buildTestApp({ parrygg: CONFIG });
    const sync = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/sync',
      headers: authHeader(),
    });
    expect(sync.statusCode).toBe(409);

    const verifyStart = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/start',
      headers: authHeader(),
    });
    expect(verifyStart.statusCode).toBe(409);
  });

  it('verification: start issues a code, repeat calls return the same one while unexpired', async () => {
    const { app, database } = buildTestApp({ parrygg: CONFIG });
    database.seed(`parryggLinks/${TEST_UID}`, {
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: false,
      linkedAt: 1000,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/start',
      headers: authHeader(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { code: string; expiresAt: number };
    expect(firstBody.code).toMatch(/^ST-[A-Z0-9]{6}$/);

    const second = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/start',
      headers: authHeader(),
    });
    expect(second.json()).toEqual(firstBody);
  });

  it('verification: complete succeeds when the code is present in the bio', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: 'nothing yet' })],
    ]);
    const clients = fakeParryggClients(users);
    const { app, database } = buildTestApp({ parrygg: CONFIG, parryggClients: clients });
    database.seed(`parryggLinks/${TEST_UID}`, {
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: false,
      linkedAt: 1000,
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/start',
      headers: authHeader(),
    });
    const { code } = start.json() as { code: string };

    // Simulate the user pasting the code into their real parry.gg bio.
    users.set('p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: `hello ${code} world` }));

    const complete = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/complete',
      headers: authHeader(),
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ verified: true });

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['parryggLinks']?.[TEST_UID]).toMatchObject({ verified: true });
    expect(tree['parryggVerifications']?.[TEST_UID]).toBeUndefined();
  });

  it('verification: complete 400s when the code is absent from the bio', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: 'nothing here' })],
    ]);
    const { app, database } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(users),
    });
    database.seed(`parryggLinks/${TEST_UID}`, {
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: false,
      linkedAt: 1000,
    });

    await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/start',
      headers: authHeader(),
    });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/complete',
      headers: authHeader(),
    });
    expect(complete.statusCode).toBe(400);
  });

  it('verification: complete 400s when no verification is pending', async () => {
    const { app, database } = buildTestApp({ parrygg: CONFIG });
    database.seed(`parryggLinks/${TEST_UID}`, {
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: false,
      linkedAt: 1000,
    });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/verify/complete',
      headers: authHeader(),
    });
    expect(complete.statusCode).toBe(400);
  });

  it('sync succeeds for a linked (even unverified) account', async () => {
    const { app, database } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(new Map()),
    });
    database.seed(`parryggLinks/${TEST_UID}`, {
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: false,
      linkedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/parrygg/sync',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ matches: 0, imported: 0 });
  });
});
