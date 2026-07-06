import { describe, expect, it, vi } from 'vitest';
import { User } from '@parry-gg/client';
import type { ParryggConfig } from '../config/env.js';
import type { ParryggClients } from '../parrygg/client.js';
import { buildTestApp, TEST_UID } from '../test-support/testApp.js';

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

/** Builds fake parry.gg service clients backed by a mutable user store (tests update bios in place). */
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

describe('parry.gg login routes (unconfigured)', () => {
  it('answers 503 for every login route', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/search',
      payload: { query: 'hbox' },
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('parry.gg login routes (configured)', () => {
  it('search returns candidates without requiring auth', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })],
      ['p2', makeUser({ id: 'p2', gamerTag: 'Mang0' })],
    ]);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/search',
      payload: { query: 'hungry' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'p1', gamerTag: 'Hungrybox' }]);
  });

  it('caps search results at 5 candidates', async () => {
    const entries: [string, User][] = Array.from({ length: 8 }, (_, i) => [
      `p${i}`,
      makeUser({ id: `p${i}`, gamerTag: `Player${i}` }),
    ]);
    const users = new Map(entries);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/search',
      payload: { query: 'Player' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBe(5);
  });

  it('start issues a code, repeat calls return the same one while unexpired', async () => {
    const users = new Map([['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })]]);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'p1' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { parryUserId: string; gamerTag: string; code: string };
    expect(firstBody).toMatchObject({ parryUserId: 'p1', gamerTag: 'Hungrybox' });
    expect(firstBody.code).toMatch(/^ST-[A-Z0-9]{6}$/);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'p1' },
    });
    expect(second.json()).toEqual(firstBody);
  });

  it('start 404s for an unknown parry.gg id', async () => {
    const { app } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(new Map()),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'missing' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('complete 400s when no code is pending', async () => {
    const users = new Map([['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox' })]]);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/complete',
      payload: { parryUserId: 'p1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('complete 400s when the code is absent from the bio', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: 'nothing here' })],
    ]);
    const { app } = buildTestApp({ parrygg: CONFIG, parryggClients: fakeParryggClients(users) });

    await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'p1' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/complete',
      payload: { parryUserId: 'p1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('complete 400s and deletes the code once it has expired', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: 'placeholder' })],
    ]);
    const { app, database } = buildTestApp({
      parrygg: CONFIG,
      parryggClients: fakeParryggClients(users),
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'p1' },
    });
    const { code } = start.json() as { code: string };

    // Force expiry directly, then put the (now-stale) code in the bio.
    database.seed('parryggLoginVerifications/p1', { code, expiresAt: Date.now() - 1 });
    users.set('p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: `hello ${code}` }));

    const complete = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/complete',
      payload: { parryUserId: 'p1' },
    });
    expect(complete.statusCode).toBe(400);

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['parryggLoginVerifications']?.['p1']).toBeUndefined();
  });

  it('complete creates a new Firebase user, link, and reverse index for an unknown parry.gg account', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: 'placeholder bio' })],
    ]);
    const clients = fakeParryggClients(users);
    const { app, database, auth } = buildTestApp({ parrygg: CONFIG, parryggClients: clients });

    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'p1' },
    });
    const { code } = start.json() as { code: string };

    // Simulate the user pasting the code into their real parry.gg bio.
    users.set('p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: `hello ${code} world` }));

    const complete = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/complete',
      payload: { parryUserId: 'p1' },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toEqual({
      token: 'custom-token-for-parrygg-p1',
      gamerTag: 'Hungrybox',
    });

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['parryggLinks']?.['parrygg-p1']).toMatchObject({
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      verified: true,
    });
    expect(tree['parryggUserIndex']?.['p1']).toBe('parrygg-p1');
    expect(tree['parryggLoginVerifications']?.['p1']).toBeUndefined();

    // The deterministic uid was actually created against the fake Auth client.
    await expect(auth.createUser({ uid: 'parrygg-p1' })).rejects.toThrow();
  });

  it('complete reuses the existing index for a previously-linked parry.gg account, minting a token for THAT uid', async () => {
    const users = new Map([
      ['p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: 'placeholder' })],
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
    database.seed('parryggUserIndex/p1', TEST_UID);

    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/start',
      payload: { parryUserId: 'p1' },
    });
    const { code } = start.json() as { code: string };
    users.set('p1', makeUser({ id: 'p1', gamerTag: 'Hungrybox', bioMd: `code: ${code}` }));

    const complete = await app.inject({
      method: 'POST',
      url: '/api/auth/parrygg/login/complete',
      payload: { parryUserId: 'p1' },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toEqual({
      token: `custom-token-for-${TEST_UID}`,
      gamerTag: 'Hungrybox',
    });

    // No new user/link was created — the existing account's link is untouched.
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['parryggLinks']?.[TEST_UID]).toMatchObject({ verified: false });
    expect(tree['parryggUserIndex']?.['p1']).toBe(TEST_UID);
  });
});
