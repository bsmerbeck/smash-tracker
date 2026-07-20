import { describe, expect, it, vi } from 'vitest';
import type { StartggConfig } from '../config/env.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { ParryggClients } from '../parrygg/client.js';

/** Extracts every event row across `eventLedger`'s day shards — mirrors `matches.test.ts`'s identically-named helper. */
function eventRows(dump: unknown): Array<{ eventName: string; actorId: string }> {
  const typed = dump as { eventLedger?: Record<string, Record<string, unknown>> };
  return Object.values(typed.eventLedger ?? {}).flatMap((day) => Object.values(day)) as Array<{
    eventName: string;
    actorId: string;
  }>;
}

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

  it('fires scout_activated (once) on a successful report — Phase 13 ONBD-04', async () => {
    const { app, database } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });

    const first = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'https://start.gg/user/07dc2239' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'https://start.gg/user/07dc2239' },
    });
    expect(second.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const fired = rows.filter((row) => row.eventName === 'scout_activated');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe(TEST_UID);
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

// ---------------------------------------------------------------------------
// V9-B Feature 4: parry.gg scouting — source resolution + independent 503s.
// ---------------------------------------------------------------------------

const PARRY_USER_ID = '019ce9ba-debd-7e11-84a2-77258f52644e';

function parryClients(overrides: {
  getUser?: () => { id: string; gamerTag: string } | null;
}): ParryggClients {
  return {
    users: {
      getUser: vi.fn(async () => {
        const found = overrides.getUser?.() ?? null;
        return {
          getUser: () => (found ? { toObject: () => ({ ...found, bioMd: '' }) } : undefined),
        };
      }),
      getUsers: vi.fn(async () => ({ getUsersList: () => [] })),
    } as unknown as ParryggClients['users'],
    matches: {
      getMatches: vi.fn(async () => ({ getMatchesList: () => [] })),
    } as unknown as ParryggClients['matches'],
  };
}

describe('POST /api/scout (parry.gg, V9-B)', () => {
  it('answers 503 when neither integration is configured', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 for a parry.gg query when only start.gg is configured', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 for a start.gg query when only parry.gg is configured', async () => {
    const { app } = buildTestApp({
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({}),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('a pasted parry.gg profile URL resolves via parry.gg regardless of the source field', async () => {
    const { app } = buildTestApp({
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}`, source: 'startgg' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: { source: 'parrygg', parryUserId: PARRY_USER_ID, gamerTag: 'Pandem1c' },
    });
  });

  it('respects an explicit source: parrygg for a bare tag', async () => {
    const { app } = buildTestApp({
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: PARRY_USER_ID, source: 'parrygg' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ player: { source: 'parrygg' } });
  });

  it('returns 404 when no parry.gg player resolves', async () => {
    const { app } = buildTestApp({
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({ getUser: () => null }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('defaults to start.gg when source is omitted and the query is not a parry.gg URL', async () => {
    const { app } = buildTestApp({
      startgg: CONFIG,
      startggFetch: scoutFetchMock(),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({}),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ player: { id: 1802316 } });
  });
});

// ---------------------------------------------------------------------------
// V13: combine start.gg + parry.gg into one scout via `combineWith`.
// ---------------------------------------------------------------------------

describe('POST /api/scout (V13 combined)', () => {
  const combinedPayload = {
    query: 'user/07dc2239',
    source: 'startgg' as const,
    combineWith: { query: PARRY_USER_ID, source: 'parrygg' as const },
  };

  it('merges both sites into a single combined identity when both resolve', async () => {
    const { app } = buildTestApp({
      startgg: CONFIG,
      startggFetch: scoutFetchMock(),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: combinedPayload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: {
        source: 'combined',
        id: 1802316,
        parryUserId: PARRY_USER_ID,
        gamerTag: 'Pandem1c',
      },
    });
  });

  it('falls back to the single source that resolves (parry.gg not found)', async () => {
    const { app } = buildTestApp({
      startgg: CONFIG,
      startggFetch: scoutFetchMock(),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({ getUser: () => null }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: combinedPayload,
    });
    expect(response.statusCode).toBe(200);
    // Only start.gg resolved → single-source report, NOT a combined identity.
    const body = response.json();
    expect(body.player.id).toBe(1802316);
    expect(body.player.source).not.toBe('combined');
    expect(body.player.parryUserId).toBeUndefined();
  });

  it('falls back to start.gg when parry.gg is not configured on this deployment', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: combinedPayload,
    });
    // No 503 for the combined request — the unconfigured side is dropped.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ player: { id: 1802316 } });
  });

  it('returns 404 when neither site resolves the player', async () => {
    const noPlayerFetch = (async () => gqlResponse({ user: null })) as typeof fetch;
    const { app } = buildTestApp({
      startgg: CONFIG,
      startggFetch: noPlayerFetch,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({ getUser: () => null }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scout',
      headers: authHeader(),
      payload: combinedPayload,
    });
    expect(response.statusCode).toBe(404);
  });
});
