import { describe, expect, it, vi } from 'vitest';
import type { StartggSet } from './client.js';
import {
  accumulateScoutSet,
  buildScoutReport,
  parseScoutInput,
  resolveScoutPlayer,
  ScoutCache,
  ScoutInputError,
  scoutPlayer,
  type ResolvedScoutPlayer,
} from './scout.js';

const PLAYER_ID = 1802316;

/** A realistic SSBU set: the scouted player (Bayonetta, sgg id 1271 -> fighter 67) vs PowPow (Sonic, 1332) on Battlefield. */
function makeSet(overrides: Partial<StartggSet> = {}): StartggSet {
  return {
    id: 111,
    completedAt: 1_700_000_000,
    fullRoundText: 'Losers Round 2',
    round: -2,
    displayScore: '2-1',
    totalGames: 2,
    event: {
      id: 987,
      name: 'Ultimate Singles',
      isOnline: true,
      numEntrants: 512,
      videogame: { id: 1386 },
      tournament: { name: 'Test Weekly 42' },
    },
    slots: [
      {
        entrant: {
          id: 1,
          name: 'Team | Pandem1c',
          participants: [{ player: { id: PLAYER_ID, gamerTag: 'Pandem1c' } }],
          seeds: [{ seedNum: 12 }],
          standing: { placement: 33 },
        },
      },
      {
        entrant: {
          id: 2,
          name: 'PowPow',
          participants: [
            { player: { id: 999, gamerTag: 'PowPow' }, user: { slug: 'user/9fb774ae' } },
          ],
        },
      },
    ],
    games: [
      {
        winnerId: 1,
        stage: { id: 311, name: 'Battlefield' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
        entrant1Score: 3,
        entrant2Score: 0,
      },
      {
        winnerId: 2,
        stage: { id: 378, name: 'Pokémon Stadium 2' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
        entrant1Score: 0,
        entrant2Score: 2,
      },
    ],
    ...overrides,
  };
}

function gqlResponse(data: unknown) {
  return new Response(JSON.stringify({ data }));
}

describe('parseScoutInput', () => {
  it('parses a full profile URL', () => {
    expect(parseScoutInput('https://start.gg/user/07dc2239')).toEqual({
      kind: 'slug',
      slug: 'user/07dc2239',
    });
  });

  it('parses a protocol-less URL', () => {
    expect(parseScoutInput('start.gg/user/07dc2239')).toEqual({
      kind: 'slug',
      slug: 'user/07dc2239',
    });
  });

  it('parses a URL with a trailing slash and extra path segments', () => {
    expect(parseScoutInput('https://start.gg/user/07dc2239/games')).toEqual({
      kind: 'slug',
      slug: 'user/07dc2239',
    });
  });

  it('parses a bare slug', () => {
    expect(parseScoutInput('user/07dc2239')).toEqual({ kind: 'slug', slug: 'user/07dc2239' });
  });

  it('parses a bare numeric player id', () => {
    expect(parseScoutInput('1802316')).toEqual({ kind: 'playerId', playerId: 1802316 });
  });

  it('trims whitespace before parsing', () => {
    expect(parseScoutInput('  user/07dc2239  ')).toEqual({
      kind: 'slug',
      slug: 'user/07dc2239',
    });
  });

  it('throws ScoutInputError for an empty query', () => {
    expect(() => parseScoutInput('')).toThrow(ScoutInputError);
    expect(() => parseScoutInput('   ')).toThrow(ScoutInputError);
  });

  it('throws ScoutInputError for unrecognizable input', () => {
    expect(() => parseScoutInput('not a valid query at all')).toThrow(ScoutInputError);
    expect(() => parseScoutInput('https://example.com/whatever')).toThrow(ScoutInputError);
  });
});

describe('resolveScoutPlayer', () => {
  it('resolves a slug via user(slug:)', async () => {
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      expect(body.variables).toEqual({ slug: 'user/07dc2239' });
      return gqlResponse({
        user: {
          id: 1111624,
          slug: 'user/07dc2239',
          player: { id: PLAYER_ID, gamerTag: 'Pandem1c' },
        },
      });
    };

    const player = await resolveScoutPlayer(
      'server-token',
      { kind: 'slug', slug: 'user/07dc2239' },
      fetchMock as typeof fetch,
    );

    expect(player).toEqual({ id: PLAYER_ID, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' });
  });

  it('returns null when the slug does not resolve to a user', async () => {
    const fetchMock = async () => gqlResponse({ user: null });
    const player = await resolveScoutPlayer(
      'server-token',
      { kind: 'slug', slug: 'user/doesnotexist' },
      fetchMock as typeof fetch,
    );
    expect(player).toBeNull();
  });

  it('returns null when the user has no linked player', async () => {
    const fetchMock = async () =>
      gqlResponse({ user: { id: 1, slug: 'user/spectator', player: null } });
    const player = await resolveScoutPlayer(
      'server-token',
      { kind: 'slug', slug: 'user/spectator' },
      fetchMock as typeof fetch,
    );
    expect(player).toBeNull();
  });

  it('resolves a numeric id via player(id:)', async () => {
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      expect(body.variables).toEqual({ id: PLAYER_ID });
      return gqlResponse({
        player: {
          id: PLAYER_ID,
          gamerTag: 'Pandem1c',
          user: { id: 1111624, slug: 'user/07dc2239' },
        },
      });
    };

    const player = await resolveScoutPlayer(
      'server-token',
      { kind: 'playerId', playerId: PLAYER_ID },
      fetchMock as typeof fetch,
    );

    expect(player).toEqual({ id: PLAYER_ID, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' });
  });

  it('resolves a numeric id whose player has no linked user (userSlug omitted)', async () => {
    const fetchMock = async () =>
      gqlResponse({ player: { id: PLAYER_ID, gamerTag: 'Pandem1c', user: null } });

    const player = await resolveScoutPlayer(
      'server-token',
      { kind: 'playerId', playerId: PLAYER_ID },
      fetchMock as typeof fetch,
    );

    expect(player).toEqual({ id: PLAYER_ID, gamerTag: 'Pandem1c' });
  });

  it('returns null when the numeric id does not resolve to a player', async () => {
    const fetchMock = async () => gqlResponse({ player: null });
    const player = await resolveScoutPlayer(
      'server-token',
      { kind: 'playerId', playerId: 999999999 },
      fetchMock as typeof fetch,
    );
    expect(player).toBeNull();
  });
});

describe('accumulateScoutSet', () => {
  function emptyAcc() {
    return {
      sampledSets: 0,
      sampledGames: 0,
      characters: new Map<number, { games: number; wins: number }>(),
      stages: new Map<number, { games: number; wins: number }>(),
      events: new Map<
        number,
        {
          eventName: string;
          tournamentName?: string;
          placement?: number;
          numEntrants?: number;
          lastSetAt: number;
        }
      >(),
      opponents: new Map<string, number>(),
    };
  }

  it('aggregates characters, stages, events, and opponents from the scouted player perspective', () => {
    const acc = emptyAcc();
    accumulateScoutSet(acc, makeSet(), PLAYER_ID);

    expect(acc.sampledSets).toBe(1);
    expect(acc.sampledGames).toBe(2);
    // Bayonetta (fighter 67) played both games: won game 1, lost game 2.
    expect(acc.characters.get(67)).toEqual({ games: 2, wins: 1 });
    // Battlefield (stage 1): won. Pokémon Stadium 2: lost.
    expect(acc.stages.size).toBe(2);
    expect(acc.opponents.get('PowPow')).toBe(1);
    const event = acc.events.get(987);
    expect(event).toMatchObject({
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
      placement: 33,
      numEntrants: 512,
    });
  });

  it('strips a sponsor prefix from the common-opponent tag', () => {
    const acc = emptyAcc();
    const set = makeSet({
      slots: [
        {
          entrant: {
            id: 1,
            name: 'Me',
            participants: [{ player: { id: PLAYER_ID } }],
          },
        },
        { entrant: { id: 2, name: 'Sponsor | PowPow', participants: [{ player: { id: 999 } }] } },
      ],
    });
    accumulateScoutSet(acc, set, PLAYER_ID);
    expect(acc.opponents.get('PowPow')).toBe(1);
    expect(acc.opponents.has('Sponsor | PowPow')).toBe(false);
  });

  it('groups unmapped characters under fighterId 0', () => {
    const acc = emptyAcc();
    const set = makeSet({
      games: [
        {
          winnerId: 1,
          stage: { name: 'Battlefield' },
          selections: [
            { character: { id: 1746 }, entrant: { id: 1 } }, // Random Character
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
        },
      ],
    });
    accumulateScoutSet(acc, set, PLAYER_ID);
    expect(acc.characters.get(0)).toEqual({ games: 1, wins: 1 });
  });

  it('groups unresolvable stages under stageId 0', () => {
    const acc = emptyAcc();
    const set = makeSet({
      games: [
        {
          winnerId: 1,
          stage: { name: 'Not A Real Stage' },
          selections: [
            { character: { id: 1271 }, entrant: { id: 1 } },
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
        },
      ],
    });
    accumulateScoutSet(acc, set, PLAYER_ID);
    expect(acc.stages.get(0)).toEqual({ games: 1, wins: 1 });
  });

  it('skips non-SSBU sets', () => {
    const acc = emptyAcc();
    accumulateScoutSet(
      acc,
      makeSet({ event: { isOnline: true, videogame: { id: 1 } } }),
      PLAYER_ID,
    );
    expect(acc.sampledSets).toBe(0);
  });

  it('skips DQ sets', () => {
    const acc = emptyAcc();
    accumulateScoutSet(acc, makeSet({ displayScore: 'DQ' }), PLAYER_ID);
    expect(acc.sampledSets).toBe(0);
  });

  it('skips sets missing the scouted player entrant entirely', () => {
    const acc = emptyAcc();
    const set = makeSet({
      slots: [
        { entrant: { id: 1, name: 'Someone Else', participants: [{ player: { id: 5 } }] } },
        { entrant: { id: 2, name: 'PowPow', participants: [{ player: { id: 999 } }] } },
      ],
    });
    accumulateScoutSet(acc, set, PLAYER_ID);
    expect(acc.sampledSets).toBe(0);
  });

  it('keeps the most recent lastSetAt per event across multiple sampled sets', () => {
    const acc = emptyAcc();
    accumulateScoutSet(acc, makeSet({ id: 1, completedAt: 1_700_000_000 }), PLAYER_ID);
    accumulateScoutSet(
      acc,
      makeSet({ id: 2, completedAt: 1_700_100_000, event: { ...makeSet().event, id: 987 } }),
      PLAYER_ID,
    );
    expect(acc.events.get(987)?.lastSetAt).toBe(1_700_100_000_000);
  });
});

describe('buildScoutReport', () => {
  const player: ResolvedScoutPlayer = {
    id: PLAYER_ID,
    gamerTag: 'Pandem1c',
    userSlug: 'user/07dc2239',
  };

  it('paginates and aggregates into a full ScoutReportData', async () => {
    let calls = 0;
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { variables: { page: number } };
      expect(body.variables.page).toBe(calls);
      return gqlResponse({
        player: {
          sets: {
            pageInfo: { totalPages: 2 },
            nodes: [makeSet({ id: calls })],
          },
        },
      });
    }) as typeof fetch;

    const report = await buildScoutReport('server-token', player, fetchMock);

    expect(calls).toBe(2);
    expect(report.player).toEqual({
      id: PLAYER_ID,
      gamerTag: 'Pandem1c',
      userSlug: 'user/07dc2239',
    });
    expect(report.sampledSets).toBe(2);
    expect(report.sampledGames).toBe(4);
    expect(report.characters[0]).toMatchObject({ fighterId: 67, games: 4, wins: 2 });
    expect(report.commonOpponents[0]).toEqual({ gamerTag: 'PowPow', sets: 2 });
    expect(report.recentEvents).toHaveLength(1);
    expect(report.recentEvents[0]).toMatchObject({ eventName: 'Ultimate Singles', placement: 33 });
  });

  it('caps pagination at 15 pages even when start.gg reports more', async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return gqlResponse({
        player: { sets: { pageInfo: { totalPages: 999 }, nodes: [makeSet({ id: calls })] } },
      });
    }) as typeof fetch;

    const report = await buildScoutReport('server-token', player, fetchMock);

    expect(calls).toBe(15);
    expect(report.sampledSets).toBe(15);
  });

  it('sorts characters, stages, and commonOpponents by games/sets descending', async () => {
    const fetchMock = (async () =>
      gqlResponse({
        player: {
          sets: {
            pageInfo: { totalPages: 1 },
            nodes: [
              makeSet({
                id: 1,
                slots: [
                  {
                    entrant: {
                      id: 1,
                      name: 'Me',
                      participants: [{ player: { id: PLAYER_ID } }],
                    },
                  },
                  {
                    entrant: { id: 2, name: 'RareOpponent', participants: [{ player: { id: 2 } }] },
                  },
                ],
                games: [
                  {
                    winnerId: 1,
                    stage: { id: 311, name: 'Battlefield' },
                    selections: [
                      { character: { id: 1302 }, entrant: { id: 1 } }, // Mario, fighter 1
                      { character: { id: 1332 }, entrant: { id: 2 } },
                    ],
                  },
                ],
              }),
              makeSet({
                id: 2,
                event: { ...makeSet().event, id: 555, name: 'Another Event' },
                slots: [
                  {
                    entrant: {
                      id: 1,
                      name: 'Me',
                      participants: [{ player: { id: PLAYER_ID } }],
                    },
                  },
                  {
                    entrant: {
                      id: 3,
                      name: 'FrequentOpponent',
                      participants: [{ player: { id: 3 } }],
                    },
                  },
                ],
                games: [
                  {
                    winnerId: 1,
                    stage: { id: 378, name: 'Pokémon Stadium 2' },
                    selections: [
                      { character: { id: 1286 }, entrant: { id: 1 } }, // Fox, fighter 8
                      { character: { id: 1332 }, entrant: { id: 3 } },
                    ],
                  },
                  {
                    winnerId: 1,
                    stage: { id: 378, name: 'Pokémon Stadium 2' },
                    selections: [
                      { character: { id: 1286 }, entrant: { id: 1 } },
                      { character: { id: 1332 }, entrant: { id: 3 } },
                    ],
                  },
                ],
              }),
              // A second set against FrequentOpponent (different event), so
              // their `sets` count (2) exceeds RareOpponent's (1).
              makeSet({
                id: 3,
                event: { ...makeSet().event, id: 556, name: 'Yet Another Event' },
                slots: [
                  {
                    entrant: {
                      id: 1,
                      name: 'Me',
                      participants: [{ player: { id: PLAYER_ID } }],
                    },
                  },
                  {
                    entrant: {
                      id: 3,
                      name: 'FrequentOpponent',
                      participants: [{ player: { id: 3 } }],
                    },
                  },
                ],
                games: [
                  {
                    winnerId: 1,
                    stage: { id: 378, name: 'Pokémon Stadium 2' },
                    selections: [
                      { character: { id: 1286 }, entrant: { id: 1 } },
                      { character: { id: 1332 }, entrant: { id: 3 } },
                    ],
                  },
                ],
              }),
            ],
          },
        },
      })) as typeof fetch;

    const report = await buildScoutReport('server-token', player, fetchMock);

    // Fox (3 games) should rank above Mario (1 game).
    expect(report.characters.map((c) => c.fighterId)).toEqual([8, 1]);
    // Pokémon Stadium 2 (3 games) should rank above Battlefield (1 game).
    expect(report.stages[0]?.games).toBe(3);
    expect(report.commonOpponents[0]?.gamerTag).toBe('FrequentOpponent');
    expect(report.commonOpponents[0]?.sets).toBe(2);
  });
});

describe('ScoutCache', () => {
  it('returns null on a miss, then the cached value on a hit', () => {
    const cache = new ScoutCache();
    expect(cache.get(1)).toBeNull();
    const report = {
      player: { id: 1, gamerTag: 'X' },
      sampledSets: 0,
      sampledGames: 0,
      characters: [],
      stages: [],
      recentEvents: [],
      commonOpponents: [],
    };
    cache.set(1, report);
    expect(cache.get(1)).toEqual(report);
  });

  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new ScoutCache(50, 1000, () => now);
    const report = {
      player: { id: 1, gamerTag: 'X' },
      sampledSets: 0,
      sampledGames: 0,
      characters: [],
      stages: [],
      recentEvents: [],
      commonOpponents: [],
    };
    cache.set(1, report);
    now = 999;
    expect(cache.get(1)).toEqual(report);
    now = 1001;
    expect(cache.get(1)).toBeNull();
  });

  it('evicts the least-recently-used entry once past maxEntries', () => {
    const cache = new ScoutCache(2, 60_000);
    const reportFor = (id: number) => ({
      player: { id, gamerTag: `P${id}` },
      sampledSets: 0,
      sampledGames: 0,
      characters: [],
      stages: [],
      recentEvents: [],
      commonOpponents: [],
    });
    cache.set(1, reportFor(1));
    cache.set(2, reportFor(2));
    expect(cache.size).toBe(2);
    // Touch 1 so it becomes most-recently-used; 2 becomes the LRU victim.
    expect(cache.get(1)).not.toBeNull();
    cache.set(3, reportFor(3));
    expect(cache.size).toBe(2);
    expect(cache.get(2)).toBeNull();
    expect(cache.get(1)).not.toBeNull();
    expect(cache.get(3)).not.toBeNull();
  });
});

describe('scoutPlayer', () => {
  it('resolves, aggregates, and caches; a second call for the same player does not refetch', async () => {
    let fetchCalls = 0;
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('ResolveBySlug')) {
        return gqlResponse({
          user: { id: 1, slug: 'user/07dc2239', player: { id: PLAYER_ID, gamerTag: 'Pandem1c' } },
        });
      }
      return gqlResponse({
        player: { sets: { pageInfo: { totalPages: 1 }, nodes: [makeSet()] } },
      });
    }) as typeof fetch;

    const cache = new ScoutCache();
    const input = { kind: 'slug' as const, slug: 'user/07dc2239' };

    const first = await scoutPlayer('server-token', input, fetchMock, cache);
    expect(first).not.toBeNull();
    expect(first?.sampledSets).toBe(1);
    const callsAfterFirst = fetchCalls;

    const second = await scoutPlayer('server-token', input, fetchMock, cache);
    expect(second).toEqual(first);
    // Resolution still happens (cheap, cheap to always re-verify identity),
    // but the sets pagination must not repeat.
    expect(fetchCalls).toBeLessThanOrEqual(callsAfterFirst + 1);
  });

  it('returns null without aggregating when resolution fails', async () => {
    const fetchMock = vi.fn(async () => gqlResponse({ user: null })) as unknown as typeof fetch;
    const cache = new ScoutCache();
    const result = await scoutPlayer(
      'server-token',
      { kind: 'slug', slug: 'user/nobody' },
      fetchMock,
      cache,
    );
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
