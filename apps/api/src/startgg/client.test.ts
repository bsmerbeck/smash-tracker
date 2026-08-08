import { describe, expect, it } from 'vitest';
import {
  fetchEventDetails,
  fetchResearchSetsPage,
  fetchResearchSetsProbePage,
  normalizeStartggPlayerId,
  resolvePlayerById,
  resolvePlayerBySlug,
  STARTGG_ERROR_BODY_EXCERPT_MAX,
  StartggApiError,
} from './client.js';

function gqlResponse(data: unknown) {
  return new Response(JSON.stringify({ data }));
}

describe('fetchEventDetails', () => {
  it('parses slug, tournament slug, and top standings', async () => {
    const fetchMock = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe('https://api.start.gg/gql/alpha');
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      expect(body.variables).toEqual({ eventId: 123, perPage: 8 });
      return gqlResponse({
        event: {
          slug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
          tournament: { name: 'The Box: Juice Box 26', slug: 'tournament/the-box-juice-box-26' },
          standings: {
            nodes: [
              {
                placement: 1,
                entrant: {
                  name: 'Team | Champ',
                  participants: [
                    { player: { id: 1, gamerTag: 'Champ' }, user: { slug: 'user/9fb774ae' } },
                  ],
                },
              },
              {
                placement: 2,
                entrant: {
                  name: 'RunnerUp',
                  participants: [{ player: { id: 2, gamerTag: null }, user: { slug: null } }],
                },
              },
            ],
          },
        },
      });
    };

    const details = await fetchEventDetails('server-token', 123, fetchMock as typeof fetch);

    expect(details.slug).toBe('tournament/the-box-juice-box-26/event/ultimate-singles');
    expect(details.tournamentSlug).toBe('tournament/the-box-juice-box-26');
    expect(details.topStandings).toEqual([
      { placement: 1, name: 'Team | Champ', gamerTag: 'Champ', userSlug: 'user/9fb774ae' },
      { placement: 2, name: 'RunnerUp' },
    ]);
  });

  it('tolerates a fully nullish event (no slug, no standings)', async () => {
    const fetchMock = async () => gqlResponse({ event: null });

    const details = await fetchEventDetails('server-token', 999, fetchMock as typeof fetch);

    expect(details).toEqual({ topStandings: [] });
  });

  it('tolerates nullish tournament and empty standings nodes', async () => {
    const fetchMock = async () =>
      gqlResponse({
        event: {
          slug: 'tournament/x/event/y',
          tournament: null,
          standings: { nodes: [null, { placement: null, entrant: null }] },
        },
      });

    const details = await fetchEventDetails('server-token', 42, fetchMock as typeof fetch);

    expect(details.slug).toBe('tournament/x/event/y');
    expect(details.tournamentSlug).toBeUndefined();
    expect(details.topStandings).toEqual([]);
  });

  it('throws a StartggApiError on GraphQL errors', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ errors: [{ message: 'event not found' }] }));

    await expect(
      fetchEventDetails('server-token', 1, fetchMock as typeof fetch),
    ).rejects.toBeInstanceOf(StartggApiError);
  });
});

describe('resolvePlayerBySlug', () => {
  it('resolves a user slug to a player identity (verified via probe against api.start.gg)', async () => {
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      expect(body.variables).toEqual({ slug: 'user/07dc2239' });
      return new Response(
        JSON.stringify({
          data: {
            user: {
              id: 1111624,
              slug: 'user/07dc2239',
              player: { id: 1802316, gamerTag: 'Pandem1c' },
            },
          },
        }),
      );
    };

    const player = await resolvePlayerBySlug(
      'server-token',
      'user/07dc2239',
      fetchMock as typeof fetch,
    );

    expect(player).toEqual({ id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' });
  });

  it('returns null when the slug does not resolve', async () => {
    const fetchMock = async () => new Response(JSON.stringify({ data: { user: null } }));
    const player = await resolvePlayerBySlug(
      'server-token',
      'user/ghost',
      fetchMock as typeof fetch,
    );
    expect(player).toBeNull();
  });

  it('returns null when the user has no linked player', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ data: { user: { id: 1, slug: 'user/x', player: null } } }));
    const player = await resolvePlayerBySlug('server-token', 'user/x', fetchMock as typeof fetch);
    expect(player).toBeNull();
  });
});

describe('resolvePlayerById', () => {
  it('resolves a numeric player id to an identity (verified via probe against api.start.gg)', async () => {
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      expect(body.variables).toEqual({ id: 1802316 });
      return new Response(
        JSON.stringify({
          data: {
            player: {
              id: 1802316,
              gamerTag: 'Pandem1c',
              user: { id: 1111624, slug: 'user/07dc2239' },
            },
          },
        }),
      );
    };

    const player = await resolvePlayerById('server-token', 1802316, fetchMock as typeof fetch);

    expect(player).toEqual({ id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' });
  });

  it('omits userSlug when the player has no linked user', async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({ data: { player: { id: 1802316, gamerTag: 'Pandem1c', user: null } } }),
      );
    const player = await resolvePlayerById('server-token', 1802316, fetchMock as typeof fetch);
    expect(player).toEqual({ id: 1802316, gamerTag: 'Pandem1c' });
  });

  it('returns null when the id does not resolve', async () => {
    const fetchMock = async () => new Response(JSON.stringify({ data: { player: null } }));
    const player = await resolvePlayerById('server-token', 999999999, fetchMock as typeof fetch);
    expect(player).toBeNull();
  });
});

// ---- Phase 30 (ING-01/04/06): fetchResearchSetsPage / fetchResearchSetsProbePage ----

describe('fetchResearchSetsPage', () => {
  it('sends the lossless field selections and a showByes:true filter', async () => {
    let capturedBody = '';
    const fetchMock = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe('https://api.start.gg/gql/alpha');
      capturedBody = String(init?.body);
      return gqlResponse({ player: null });
    };

    await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);

    const body = JSON.parse(capturedBody) as { query: string; variables: Record<string, unknown> };
    for (const field of [
      'isDisqualified',
      'initialSeedNum',
      'state',
      'identifier',
      'createdAt',
      'updatedAt',
    ]) {
      expect(body.query).toContain(field);
    }
    expect(body.query).toMatch(/games\s*{\s*id/);
    expect(body.query).toContain('showByes: true');
  });

  it('sets showByes:true and passes a null updatedAfter variable when no filter is given', async () => {
    let capturedVariables: Record<string, unknown> = {};
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      capturedVariables = JSON.parse(String(init?.body)).variables as Record<string, unknown>;
      return gqlResponse({ player: null });
    };

    await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);

    expect(capturedVariables.updatedAfter).toBeNull();
  });

  it('passes the exact updatedAfter value when provided', async () => {
    let capturedVariables: Record<string, unknown> = {};
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      capturedVariables = JSON.parse(String(init?.body)).variables as Record<string, unknown>;
      return gqlResponse({ player: null });
    };

    await fetchResearchSetsPage(
      'server-token',
      1,
      1,
      10,
      { updatedAfter: 1700000000 },
      fetchMock as typeof fetch,
    );

    expect(capturedVariables.updatedAfter).toBe(1700000000);
  });

  it('returns an empty page rather than throwing when player is null', async () => {
    const fetchMock = async () => gqlResponse({ player: null });
    const result = await fetchResearchSetsPage(
      'server-token',
      1,
      1,
      10,
      {},
      fetchMock as typeof fetch,
    );
    expect(result).toEqual({ totalPages: 0, sets: [] });
  });

  it('parses a set node that omits state/identifier/isDisqualified/games', async () => {
    const fetchMock = async () =>
      gqlResponse({
        player: {
          sets: {
            pageInfo: { totalPages: 1 },
            nodes: [
              {
                id: 1,
                completedAt: 1000,
                slots: [{ entrant: { id: 1, name: 'A' } }, { entrant: { id: 2, name: 'B' } }],
              },
            ],
          },
        },
      });

    const result = await fetchResearchSetsPage(
      'server-token',
      1,
      1,
      10,
      {},
      fetchMock as typeof fetch,
    );

    expect(result.sets).toHaveLength(1);
    expect(result.sets[0]?.state).toBeUndefined();
    expect(result.sets[0]?.identifier).toBeUndefined();
    expect(result.sets[0]?.games).toBeUndefined();
    expect(result.sets[0]?.slots?.[0]?.entrant?.isDisqualified).toBeUndefined();
  });

  it('preserves a bye slot with a null entrant rather than dropping it', async () => {
    const fetchMock = async () =>
      gqlResponse({
        player: {
          sets: {
            pageInfo: { totalPages: 1 },
            nodes: [
              {
                id: 1,
                completedAt: 1000,
                slots: [{ entrant: null }, { entrant: { id: 2, name: 'B' } }],
              },
            ],
          },
        },
      });

    const result = await fetchResearchSetsPage(
      'server-token',
      1,
      1,
      10,
      {},
      fetchMock as typeof fetch,
    );

    expect(result.sets[0]?.slots).toHaveLength(2);
    expect(result.sets[0]?.slots?.[0]?.entrant ?? null).toBeNull();
  });

  it('carries a present Retry-After header verbatim on a non-2xx response', async () => {
    const fetchMock = async () =>
      new Response('rejected', { status: 429, headers: { 'Retry-After': '30' } });

    let error: unknown;
    try {
      await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StartggApiError);
    expect((error as StartggApiError).status).toBe(429);
    expect((error as StartggApiError).retryAfter).toBe('30');
  });

  it('leaves retryAfter undefined when start.gg sent no Retry-After header', async () => {
    const fetchMock = async () => new Response('rejected', { status: 500 });

    let error: unknown;
    try {
      await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StartggApiError);
    expect((error as StartggApiError).retryAfter).toBeUndefined();
  });

  it('captures a bounded responseBody excerpt while keeping the thrown message unchanged', async () => {
    const complexityBody = JSON.stringify({
      success: false,
      fields: null,
      message: 'Query complexity too high... (actual: 1235)',
    });
    const fetchMock = async () => new Response(complexityBody, { status: 400 });

    let error: unknown;
    try {
      await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StartggApiError);
    const apiError = error as StartggApiError;
    expect(apiError.message).toBe('start.gg API returned 400');
    expect(apiError.responseBody).toContain('Query complexity too high');
  });

  it('truncates a response body longer than the excerpt cap', async () => {
    const longBody = 'x'.repeat(STARTGG_ERROR_BODY_EXCERPT_MAX + 500);
    const fetchMock = async () => new Response(longBody, { status: 500 });

    let error: unknown;
    try {
      await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);
    } catch (err) {
      error = err;
    }

    expect((error as StartggApiError).responseBody).toHaveLength(STARTGG_ERROR_BODY_EXCERPT_MAX);
  });

  it('still throws the same error with responseBody undefined when the body read rejects', async () => {
    const fetchMock = async () =>
      ({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => {
          throw new Error('stream already consumed');
        },
      }) as unknown as Response;

    let error: unknown;
    try {
      await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StartggApiError);
    const apiError = error as StartggApiError;
    expect(apiError.message).toBe('start.gg API returned 503');
    expect(apiError.responseBody).toBeUndefined();
  });

  it('leaves responseBody undefined on a 2xx response carrying a GraphQL errors array', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ errors: [{ message: 'unknown field abc' }] }));

    let error: unknown;
    try {
      await fetchResearchSetsPage('server-token', 1, 1, 10, {}, fetchMock as typeof fetch);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StartggApiError);
    expect((error as StartggApiError).responseBody).toBeUndefined();
  });

  it('produces byte-identical request bodies for a string and a numeric playerId', async () => {
    const captures: string[] = [];
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      captures.push(String(init?.body));
      return gqlResponse({ player: null });
    };

    await fetchResearchSetsPage('server-token', '12345', 1, 10, {}, fetchMock as typeof fetch);
    await fetchResearchSetsPage('server-token', 12345, 1, 10, {}, fetchMock as typeof fetch);

    expect(captures[0]).toBe(captures[1]);
  });
});

describe('normalizeStartggPlayerId', () => {
  it('accepts a digits-only string', () => {
    expect(normalizeStartggPlayerId('12345')).toBe(12345);
  });

  it('accepts a positive integer number', () => {
    expect(normalizeStartggPlayerId(12345)).toBe(12345);
  });

  it.each(['12a', '', '-1', '1'.repeat(21)])('returns null for %j', (value) => {
    expect(normalizeStartggPlayerId(value)).toBeNull();
  });
});

describe('fetchResearchSetsProbePage', () => {
  it('sends an entrant-size variable and a matching filter argument', async () => {
    let capturedBody = '';
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return gqlResponse({ player: null });
    };

    await fetchResearchSetsProbePage('server-token', 1, 1, 10, 1, fetchMock as typeof fetch);

    const body = JSON.parse(capturedBody) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('$entrantSize: Int');
    expect(body.query).toContain('entrantSize: $entrantSize');
    expect(body.variables.entrantSize).toBe(1);
  });

  it('throws a StartggApiError when start.gg rejects entrantSize as an unknown argument', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Unknown argument "entrantSize"' }] }));

    await expect(
      fetchResearchSetsProbePage('server-token', 1, 1, 10, 1, fetchMock as typeof fetch),
    ).rejects.toBeInstanceOf(StartggApiError);
  });
});

describe('research/probe query separation (review C2-A1)', () => {
  it('fetchResearchSetsPage carries no entrant-size argument or variable, unlike the probe query', async () => {
    let researchBody = '';
    let probeBody = '';
    const researchFetch = async (_url: unknown, init?: RequestInit) => {
      researchBody = String(init?.body);
      return gqlResponse({ player: null });
    };
    const probeFetch = async (_url: unknown, init?: RequestInit) => {
      probeBody = String(init?.body);
      return gqlResponse({ player: null });
    };

    await fetchResearchSetsPage('server-token', 1, 1, 10, {}, researchFetch as typeof fetch);
    await fetchResearchSetsProbePage('server-token', 1, 1, 10, 1, probeFetch as typeof fetch);

    expect(researchBody).not.toContain('entrantSize');
    expect(probeBody).toContain('entrantSize');
  });
});
