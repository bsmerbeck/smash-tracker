import { describe, expect, it } from 'vitest';
import {
  fetchEventDetails,
  resolvePlayerById,
  resolvePlayerBySlug,
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
