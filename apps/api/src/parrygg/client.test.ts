import { describe, expect, it, vi } from 'vitest';
import { User } from '@parry-gg/client';
import { getUser, searchUsers, type ParryggClients } from './client.js';

/** Builds a real `@parry-gg/client` `User` protobuf message from a plain object. */
function makeUser(fields: Partial<ReturnType<User['toObject']>>): User {
  const user = new User();
  user.setId(fields.id ?? 'user-1');
  user.setGamerTag(fields.gamerTag ?? 'TestTag');
  if (fields.sponsorName) {
    user.setSponsorName(fields.sponsorName);
  }
  if (fields.locationCountry) {
    user.setLocationCountry(fields.locationCountry);
  }
  if (fields.avatarUrl) {
    user.setAvatarUrl(fields.avatarUrl);
  }
  if (fields.bioMd) {
    user.setBioMd(fields.bioMd);
  }
  return user;
}

/** Fake service clients satisfying only the methods client.ts calls, with real request/metadata assertions. */
function fakeClients(overrides: {
  getUsers?: (...args: unknown[]) => Promise<{ getUsersList(): User[] }>;
  getUser?: (...args: unknown[]) => Promise<{ getUser(): User | undefined }>;
}): ParryggClients {
  return {
    users: {
      getUsers: overrides.getUsers ?? vi.fn(),
      getUser: overrides.getUser ?? vi.fn(),
    } as unknown as ParryggClients['users'],
    matches: {
      getMatches: vi.fn(),
    } as unknown as ParryggClients['matches'],
  };
}

describe('searchUsers', () => {
  it('passes the gamer tag filter and API key metadata, mapping results', async () => {
    const getUsers = vi.fn(async (...args: unknown[]) => {
      const [request, metadata] = args as [{ getFilter(): { getGamerTag(): string } }, unknown];
      expect(request.getFilter().getGamerTag()).toBe('hungrybox');
      expect(metadata).toEqual({ 'X-API-KEY': 'test-key' });
      return {
        getUsersList: () => [
          makeUser({ id: 'u1', gamerTag: 'Hungrybox', sponsorName: 'PG', locationCountry: 'US' }),
        ],
      };
    });

    const results = await searchUsers('test-key', 'hungrybox', 10, fakeClients({ getUsers }));

    expect(results).toEqual([
      { id: 'u1', gamerTag: 'Hungrybox', sponsorName: 'PG', locationCountry: 'US' },
    ]);
    expect(getUsers).toHaveBeenCalledTimes(1);
  });

  it('caps results at the given limit', async () => {
    const getUsers = vi.fn(async () => ({
      getUsersList: () => [
        makeUser({ id: 'u1', gamerTag: 'Tag1' }),
        makeUser({ id: 'u2', gamerTag: 'Tag2' }),
        makeUser({ id: 'u3', gamerTag: 'Tag3' }),
      ],
    }));

    const results = await searchUsers('test-key', 'tag', 2, fakeClients({ getUsers }));
    expect(results).toHaveLength(2);
  });

  it("omits optional fields the user record doesn't carry", async () => {
    const getUsers = vi.fn(async () => ({
      getUsersList: () => [makeUser({ id: 'u1', gamerTag: 'Bare' })],
    }));

    const results = await searchUsers('test-key', 'bare', 10, fakeClients({ getUsers }));
    expect(results).toEqual([{ id: 'u1', gamerTag: 'Bare' }]);
  });
});

describe('getUser', () => {
  it('fetches by id and returns the full user object', async () => {
    const getUserFn = vi.fn(async (...args: unknown[]) => {
      const [request, metadata] = args as [{ getId(): string }, unknown];
      expect(request.getId()).toBe('u1');
      expect(metadata).toEqual({ 'X-API-KEY': 'test-key' });
      return { getUser: () => makeUser({ id: 'u1', gamerTag: 'Tag', bioMd: 'ST-ABC123' }) };
    });

    const user = await getUser('test-key', 'u1', fakeClients({ getUser: getUserFn }));
    expect(user).toMatchObject({ id: 'u1', gamerTag: 'Tag', bioMd: 'ST-ABC123' });
  });

  it('returns null when parry.gg has no such user', async () => {
    const getUserFn = vi.fn(async () => ({ getUser: () => undefined }));
    const user = await getUser('test-key', 'missing', fakeClients({ getUser: getUserFn }));
    expect(user).toBeNull();
  });
});
