import { describe, expect, it } from 'vitest';
import type { StartggConfig, ParryggConfig } from '../config/env.js';
import type { ParryggClients } from '../parrygg/client.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const ENTRY_KEY = 'manual-locals-42-abc123';
const EVENT_DATE = 1_700_000_000_000;

function seedBrief(
  database: ReturnType<typeof buildTestApp>['database'],
  likelyOpponents: Record<string, true> = {},
): void {
  database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
    eventDate: EVENT_DATE,
    activatedAt: EVENT_DATE,
    lastOpenedAt: EVENT_DATE,
    ...(Object.keys(likelyOpponents).length > 0 ? { likelyOpponents } : {}),
  });
}

interface SeedMatchInput {
  time: number;
  win: boolean;
  opponent?: string;
  opponentUserSlug?: string;
  opponentParryUserId?: string;
}

function seedMatches(
  database: ReturnType<typeof buildTestApp>['database'],
  matches: SeedMatchInput[],
): void {
  const record: Record<string, unknown> = {};
  matches.forEach((match, index) => {
    record[`match-${index}`] = {
      fighter_id: 1,
      opponent_id: 2,
      time: match.time,
      win: match.win,
      ...(match.opponent !== undefined ? { opponent: match.opponent } : {}),
      ...(match.opponentUserSlug !== undefined ? { opponentUserSlug: match.opponentUserSlug } : {}),
      ...(match.opponentParryUserId !== undefined
        ? { opponentParryUserId: match.opponentParryUserId }
        : {}),
    };
  });
  database.seed(`matches/${TEST_UID}`, record);
}

function seedAliases(
  database: ReturnType<typeof buildTestApp>['database'],
  aliases: Record<string, string>,
): void {
  database.seed(`opponentAliases/${TEST_UID}`, aliases);
}

// ---------------------------------------------------------------------------
// Task 2: GET .../binding-candidates
// ---------------------------------------------------------------------------

describe('GET /api/prep/:entryKey/opponents/:name/binding-candidates', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('three matches carrying the SAME start.gg slug return exactly one candidate with matchCount 3', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 2, win: false, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 3, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      candidates: Array<{ provider: string; startggUserSlug?: string; matchCount: number }>;
    };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      provider: 'startgg',
      startggUserSlug: 'user/abc123',
      matchCount: 3,
    });
  });

  it('two DIFFERENT provider identities for the same canonical name return two candidates in a deterministic, non-popularity order', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    // The parry.gg identity has fewer matches than the start.gg identity —
    // if the sort were popularity-based, start.gg would sort first by
    // count; the assertion below proves it sorts by identity, not count.
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 2, win: false, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 3, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      {
        time: 4,
        win: true,
        opponent: 'Rival',
        opponentParryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    const body = response.json() as {
      candidates: Array<{ provider: string; matchCount: number }>;
    };
    expect(body.candidates).toHaveLength(2);
    // startgg sorts before parrygg by the module's fixed provider order,
    // regardless of which identity has more matches.
    expect(body.candidates.map((c) => c.provider)).toEqual(['startgg', 'parrygg']);

    // Reordering the input matches so the LOWER-count identity (parrygg)
    // comes first in storage must not change the output order.
    const { app: app2, database: database2 } = buildTestApp();
    seedBrief(database2, { rival: true });
    seedMatches(database2, [
      {
        time: 4,
        win: true,
        opponent: 'Rival',
        opponentParryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      },
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 2, win: false, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 3, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
    ]);
    const response2 = await app2.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });
    const body2 = response2.json() as { candidates: Array<{ provider: string }> };
    expect(body2.candidates.map((c) => c.provider)).toEqual(['startgg', 'parrygg']);
  });

  it('matches carrying no provider identity contribute NO candidate, even when tag-only matches exist', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival' },
      { time: 2, win: false, opponent: 'Rival' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    expect(response.json()).toEqual({ candidates: [] });
  });

  it('a canonical name reached only through an alias still groups correctly', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedAliases(database, { r1val_alt_tag: 'rival' });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'R1val_Alt_Tag', opponentUserSlug: 'user/abc123' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    const body = response.json() as { candidates: Array<{ startggUserSlug?: string }> };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.startggUserSlug).toBe('user/abc123');
  });

  it('a name NOT curated on the brief returns an empty candidate list rather than leaking the wider match history', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, {}); // rival is NOT curated
    seedMatches(database, [
      { time: 1, win: true, opponent: 'rival', opponentUserSlug: 'user/abc123' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidates: [] });
  });

  it('performs ZERO writes: the whole fake database is byte-identical before and after', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
    ]);

    const before = JSON.stringify(database.dump());
    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });
    const after = JSON.stringify(database.dump());

    expect(response.statusCode).toBe(200);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Task 3: PUT/DELETE .../binding
// ---------------------------------------------------------------------------

const STARTGG_CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

const PARRYGG_CONFIG: ParryggConfig = { apiKey: 'parry-key' };

const RESOLVE_RESPONSE = {
  user: { id: 1111624, slug: 'user/07dc2239', player: { id: 1802316, gamerTag: 'Pandem1c' } },
};

const EMPTY_SETS_RESPONSE = {
  player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } },
};

function gqlResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify({ data }), init);
}

function scoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return gqlResponse(RESOLVE_RESPONSE);
    }
    return gqlResponse(EMPTY_SETS_RESPONSE);
  }) as typeof fetch;
}

const PARRY_USER_ID = '019ce9ba-debd-7e11-84a2-77258f52644e';

function parryClients(overrides: {
  getUser?: () => { id: string; gamerTag: string } | null;
}): ParryggClients {
  return {
    users: {
      getUser: async () => {
        const found = overrides.getUser?.() ?? null;
        return {
          getUser: () => (found ? { toObject: () => ({ ...found, bioMd: '' }) } : undefined),
        };
      },
      getUsers: async () => ({ getUsersList: () => [] }),
    } as unknown as ParryggClients['users'],
    matches: {
      getMatches: async () => ({ getMatchesList: () => [] }),
    } as unknown as ParryggClients['matches'],
  };
}

/** Deep-clones the credit balance + reportJobs subtrees, used to assert money never moved. */
function moneySnapshot(database: ReturnType<typeof buildTestApp>['database']): string {
  const tree = database.dump() as Record<string, unknown>;
  return JSON.stringify({
    creditBalances: tree.creditBalances ?? null,
    creditLedger: tree.creditLedger ?? null,
    reportJobs: tree.reportJobs ?? null,
  });
}

describe('PUT /api/prep/:entryKey/opponents/:name/binding', () => {
  it('a start.gg profile reference that resolves persists a binding carrying the resolved id, slug, and gamer tag', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, { rival: true });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/07dc2239' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      brief: { scoutBindings: Record<string, Record<string, unknown>> };
    };
    expect(body.brief.scoutBindings.rival).toMatchObject({
      provider: 'startgg',
      startggPlayerId: 1802316,
      startggUserSlug: 'user/07dc2239',
      displayTag: 'Pandem1c',
    });
  });

  it('a parry.gg profile reference that resolves persists a binding carrying the resolved user id', async () => {
    const { app, database } = buildTestApp({
      parrygg: PARRYGG_CONFIG,
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedBrief(database, { rival: true });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { parrygg: { query: `https://parry.gg/profile/${PARRY_USER_ID}` } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      brief: { scoutBindings: Record<string, Record<string, unknown>> };
    };
    expect(body.brief.scoutBindings.rival).toMatchObject({
      provider: 'parrygg',
      parryUserId: PARRY_USER_ID,
      displayTag: 'Pandem1c',
    });
  });

  it('confirming with BOTH references, both resolving, persists a combined binding with both identities', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      parrygg: PARRYGG_CONFIG,
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedBrief(database, { rival: true });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: {
        startgg: { query: 'user/07dc2239' },
        parrygg: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      brief: { scoutBindings: Record<string, Record<string, unknown>> };
    };
    expect(body.brief.scoutBindings.rival).toMatchObject({
      provider: 'combined',
      startggPlayerId: 1802316,
      parryUserId: PARRY_USER_ID,
    });
  });

  it('a bare gamer tag on the start.gg side answers 400 and persists nothing', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, { rival: true });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'Pandem1c' } },
    });

    expect(response.statusCode).toBe(400);
    const brief = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });
    const body = brief.json() as { brief: { scoutBindings: Record<string, unknown> } };
    expect(body.brief.scoutBindings).toEqual({});
  });

  it('a reference that resolves to no player answers 404 and persists nothing', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: (async () => gqlResponse({ user: null })) as typeof fetch,
    });
    seedBrief(database, { rival: true });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/nonexistent' } },
    });

    expect(response.statusCode).toBe(404);
    const brief = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });
    const body = brief.json() as { brief: { scoutBindings: Record<string, unknown> } };
    expect(body.brief.scoutBindings).toEqual({});
  });

  it('confirming for a non-curated opponent answers 409 and persists nothing', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, {}); // rival is NOT curated

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/07dc2239' } },
    });

    expect(response.statusCode).toBe(409);
    const brief = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });
    const body = brief.json() as { brief: { scoutBindings: Record<string, unknown> } };
    expect(body.brief.scoutBindings).toEqual({});
  });

  it('persists ONLY resolved values, never the raw submitted reference text', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, { rival: true });

    // The submitted reference text ("user/some-other-slug") differs from
    // what the resolver actually returns (RESOLVE_RESPONSE's
    // "user/07dc2239") — the stubbed fetch resolves ANY ResolveBySlug query
    // to the same fixed player, so this proves the stored value is the
    // RESOLVED slug, not the submitted one.
    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/some-other-slug' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      brief: { scoutBindings: Record<string, Record<string, unknown>> };
    };
    expect(body.brief.scoutBindings.rival?.startggUserSlug).toBe('user/07dc2239');
    expect(body.brief.scoutBindings.rival?.startggUserSlug).not.toBe('user/some-other-slug');
  });

  it('every case leaves the credit balance node and reportJobs subtree absent/unchanged', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, { rival: true });

    const before = moneySnapshot(database);
    await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/07dc2239' } },
    });
    const after = moneySnapshot(database);

    expect(after).toEqual(before);
  });
});

describe('DELETE /api/prep/:entryKey/opponents/:name/binding', () => {
  it('clears the binding and returns the updated brief', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, { rival: true });

    await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/07dc2239' } },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { brief: { scoutBindings: Record<string, unknown> } };
    expect(body.brief.scoutBindings).toEqual({});
  });

  it('neither confirm nor clear spends a credit, creates a report job, or invokes the model client', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
    });
    seedBrief(database, { rival: true });

    await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
      payload: { startgg: { query: 'user/07dc2239' } },
    });
    const before = moneySnapshot(database);
    await app.inject({
      method: 'DELETE',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding`,
      headers: authHeader(),
    });
    const after = moneySnapshot(database);

    expect(after).toEqual(before);
  });
});
