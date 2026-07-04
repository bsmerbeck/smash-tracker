import { describe, expect, it } from 'vitest';
import type { StartggConfig } from '../config/env.js';
import { authHeader, buildTestApp } from '../test-support/testApp.js';

const CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

function gqlResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify({ data }), init);
}

const RESOLVE_RESPONSE = {
  user: { id: 1111624, slug: 'user/07dc2239', player: { id: 1802316, gamerTag: 'Pandem1c' } },
};

const EMPTY_SETS_RESPONSE = {
  player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } },
};

/** Dispatches the resolve-by-slug query, then an empty sets page for every subsequent call. */
function scoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return gqlResponse(RESOLVE_RESPONSE);
    }
    return gqlResponse(EMPTY_SETS_RESPONSE);
  }) as typeof fetch;
}

describe('POST /api/scout (unconfigured)', () => {
  it('answers 503 when start.gg is not configured', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('POST /api/scout (configured)', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 400 for malformed input', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'not a valid start.gg reference' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when query is missing/empty (schema validation)', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when the player cannot be resolved', async () => {
    const fetchMock = (async () => gqlResponse({ user: null })) as typeof fetch;
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: fetchMock });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'user/doesnotexist' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('resolves a URL and returns a ScoutReportData shape', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'https://start.gg/user/07dc2239' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      sampledSets: 0,
      sampledGames: 0,
      characters: [],
      stages: [],
      recentEvents: [],
      commonOpponents: [],
    });
  });

  it('resolves a bare numeric player id', async () => {
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('ResolveById')) {
        return gqlResponse({
          player: {
            id: 1802316,
            gamerTag: 'Pandem1c',
            user: { id: 1111624, slug: 'user/07dc2239' },
          },
        });
      }
      return gqlResponse(EMPTY_SETS_RESPONSE);
    }) as typeof fetch;

    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: fetchMock });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: '1802316' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ player: { id: 1802316, gamerTag: 'Pandem1c' } });
  });

  it('passes through a 429 from start.gg as a friendly rate-limit response', async () => {
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('ResolveBySlug')) {
        return gqlResponse(RESOLVE_RESPONSE);
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: fetchMock });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ statusCode: 429 });
  });

  it('does not refetch sets for a repeat scout of the same player (cache hit)', async () => {
    let setsFetches = 0;
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('ResolveBySlug')) {
        return gqlResponse(RESOLVE_RESPONSE);
      }
      if (body.query.includes('ResolveById')) {
        return gqlResponse({
          player: {
            id: 1802316,
            gamerTag: 'Pandem1c',
            user: { id: 1111624, slug: 'user/07dc2239' },
          },
        });
      }
      setsFetches += 1;
      return gqlResponse(EMPTY_SETS_RESPONSE);
    }) as typeof fetch;

    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: fetchMock });

    const first = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(first.statusCode).toBe(200);
    expect(setsFetches).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: '1802316' },
    });
    expect(second.statusCode).toBe(200);
    // Same underlying player id -> cache hit -> no additional sets fetch.
    expect(setsFetches).toBe(1);
  });
});
