import { describe, expect, it, vi } from 'vitest';
import type { StartggSyncSummary } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import {
  accumulateRegistry,
  gamesFromSet,
  importPlayerMatches,
  normalizeOpponentTag,
} from './sync.js';
import { resolveStage, resolveStageByName } from './stageMap.js';
import type { StartggSet } from './client.js';

const PLAYER_ID = 1802316;

function emptySummary(): StartggSyncSummary {
  return {
    sets: 0,
    imported: 0,
    setsWithoutGames: 0,
    gamesUnmappedCharacter: 0,
    gamesMissingSelections: 0,
    gamesUnknownStage: 0,
    dqSets: 0,
  };
}

/** A realistic SSBU set: user (Mario, sgg id 1271) vs PowPow (Sonic, 1332) on Battlefield. */
function makeSet(overrides: Partial<StartggSet> = {}): StartggSet {
  return {
    id: 111,
    completedAt: 1_700_000_000,
    fullRoundText: 'Losers Round 2',
    round: -2,
    displayScore: '2-1',
    totalGames: 3,
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
          name: 'Team | Me',
          participants: [{ player: { id: PLAYER_ID } }],
          seeds: [{ seedNum: 408 }],
          standing: { placement: 257 },
        },
      },
      {
        entrant: {
          id: 2,
          name: 'PowPow',
          participants: [
            { player: { id: 999, gamerTag: 'PowPow' }, user: { slug: 'user/9fb774ae' } },
          ],
          seeds: [{ seedNum: 12 }],
          standing: { placement: 33 },
        },
      },
    ],
    games: [
      {
        winnerId: 1,
        // 311 is start.gg's real, verified-stable numeric id for Battlefield
        // (see stageMap.ts) — exercises the id-based resolution path by
        // default; a mismatched `name` here would still resolve correctly.
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

describe('normalizeOpponentTag', () => {
  it('strips sponsor prefixes and lowercases', () => {
    expect(normalizeOpponentTag('Sponsor | PowPow')).toBe('powpow');
    expect(normalizeOpponentTag('PowPow')).toBe('powpow');
  });

  it('strips RTDB-reserved characters but keeps spaces and dashes', () => {
    expect(normalizeOpponentTag('play.er#one')).toBe('playerone');
    expect(normalizeOpponentTag('Player One-Two')).toBe('player one-two');
  });

  it('falls back to unknown for empty/missing names', () => {
    expect(normalizeOpponentTag(undefined)).toBe('unknown');
    expect(normalizeOpponentTag('###')).toBe('unknown');
  });
});

describe('gamesFromSet', () => {
  it('imports fully-detailed games with correct attribution and stage mapping', () => {
    const summary = emptySummary();
    const games = gamesFromSet(makeSet(), PLAYER_ID, summary);

    expect(games).toHaveLength(2);
    // `imported` is counted by importPlayerMatches (unique-key dedup across
    // pages), not by gamesFromSet — see the importPlayerMatches tests below.
    expect(summary).toMatchObject({ sets: 1, imported: 0 });

    const [g1, g2] = games;
    expect(g1?.key).toBe('sgg-111-g1');
    expect(g1?.record).toMatchObject({
      time: 1_700_000_000_000,
      opponent: 'powpow',
      matchType: 'online-tourney',
      win: true,
      source: 'startgg',
      externalId: 'sgg:111:g1',
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
      roundText: 'Losers Round 2',
      bracketRound: -2,
      opponentSeed: 12,
      opponentPlacement: 33,
      opponentUserSlug: 'user/9fb774ae',
      // Game 1: user (slot 0) won with entrant1Score=3 remaining stocks.
      stocksLeft: 3,
    });
    expect(g1?.record.fighter_id).toBeGreaterThan(0);
    expect(g1?.record.map?.name).toBe('Battlefield');
    expect(g1?.record.map?.id).toBe(1); // resolved via start.gg stage id 311, not name
    // Game 2: lost, accent-insensitive stage resolution, opponent (slot 1)
    // won with entrant2Score=2 remaining stocks.
    expect(g2?.record.win).toBe(false);
    expect(g2?.record.map?.name).toContain('Stadium 2');
    expect(g2?.record.stocksLeft).toBe(2);
  });

  it('omits opponentSeed/opponentPlacement/opponentUserSlug when start.gg provides none', () => {
    const summary = emptySummary();
    const set = makeSet({
      slots: [
        {
          entrant: {
            id: 1,
            name: 'Team | Me',
            participants: [{ player: { id: PLAYER_ID } }],
          },
        },
        { entrant: { id: 2, name: 'PowPow', participants: [{ player: { id: 999 } }] } },
      ],
    });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games[0]).toBeDefined();
    expect('opponentSeed' in games[0]!.record).toBe(false);
    expect('opponentPlacement' in games[0]!.record).toBe(false);
    expect('opponentUserSlug' in games[0]!.record).toBe(false);
  });

  it('skips non-SSBU sets without counting them', () => {
    const summary = emptySummary();
    const set = makeSet({ event: { isOnline: true, videogame: { id: 1 } } });
    expect(gamesFromSet(set, PLAYER_ID, summary)).toHaveLength(0);
    expect(summary.sets).toBe(0);
  });

  it('counts sets without game data', () => {
    const summary = emptySummary();
    const set = makeSet({ games: [] });
    expect(gamesFromSet(set, PLAYER_ID, summary)).toHaveLength(0);
    expect(summary.setsWithoutGames).toBe(1);
  });

  it('skips games with unmapped characters (e.g. Random) and counts them', () => {
    const summary = emptySummary();
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
    expect(gamesFromSet(set, PLAYER_ID, summary)).toHaveLength(0);
    expect(summary.gamesUnmappedCharacter).toBe(1);
  });

  it('imports games with unresolvable stages under the unknown sentinel', () => {
    const summary = emptySummary();
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
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games).toHaveLength(1);
    expect(games[0]?.record.map).toEqual({ id: 0, name: 'unknown' });
    expect(summary.gamesUnknownStage).toBe(1);
  });

  it('resolves stage by start.gg numeric id even when name would not match (id takes priority)', () => {
    const summary = emptySummary();
    const set = makeSet({
      games: [
        {
          winnerId: 1,
          // 484 is start.gg's real id for Small Battlefield (verified during
          // the V6-W1b probe); a garbled/renamed `name` should not matter
          // when the id resolves.
          stage: { id: 484, name: 'Some Renamed Stage Label' },
          selections: [
            { character: { id: 1271 }, entrant: { id: 1 } },
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
        },
      ],
    });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games[0]?.record.map?.name).toBe('Small Battlefield');
    expect(summary.gamesUnknownStage).toBe(0);
  });

  it('falls back to name resolution when the start.gg stage id is not in the curated table', () => {
    const summary = emptySummary();
    const set = makeSet({
      games: [
        {
          winnerId: 1,
          // An id start.gg could plausibly use for some other stage, not in
          // our curated STARTGG_STAGE_ID_TO_NAME table — name resolution
          // should still succeed.
          stage: { id: 999999, name: 'Yoshi’s Story' },
          selections: [
            { character: { id: 1271 }, entrant: { id: 1 } },
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
        },
      ],
    });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games[0]?.record.map?.name).toBe("Yoshi's Story");
    expect(summary.gamesUnknownStage).toBe(0);
  });

  it('harvests vodUrl onto every game of the set when start.gg provides one', () => {
    const summary = emptySummary();
    const set = makeSet({ vodUrl: 'https://youtube.com/watch?v=abc123' });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games).toHaveLength(2);
    expect(games[0]?.record.vodUrl).toBe('https://youtube.com/watch?v=abc123');
    expect(games[1]?.record.vodUrl).toBe('https://youtube.com/watch?v=abc123');
  });

  it('omits vodUrl entirely when start.gg provides none (the common case)', () => {
    const summary = emptySummary();
    const set = makeSet({ vodUrl: null });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect('vodUrl' in games[0]!.record).toBe(false);
  });

  it('omits stocksLeft when start.gg tracks neither entrant score', () => {
    const summary = emptySummary();
    const set = makeSet({
      games: [
        {
          winnerId: 1,
          stage: { id: 311, name: 'Battlefield' },
          selections: [
            { character: { id: 1271 }, entrant: { id: 1 } },
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
          entrant1Score: null,
          entrant2Score: null,
        },
      ],
    });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect('stocksLeft' in games[0]!.record).toBe(false);
  });

  it("omits stocksLeft when the winner's own score is null even though the loser's reads 0", () => {
    // Regression guard: start.gg can report `{ entrant1Score: null,
    // entrant2Score: 0 }` where entrant1 (slot 0) is the WINNER — the
    // winner's stock count simply isn't tracked here, so max()-style logic
    // would wrongly report `stocksLeft: 0` ("won with zero stocks left").
    // Verified live during the V6-W1b probe (Genesis 9 set 56194830, game
    // 15505434).
    const summary = emptySummary();
    const set = makeSet({
      games: [
        {
          winnerId: 1, // entrant 1 = userEntrant, slot index 0
          stage: { id: 311, name: 'Battlefield' },
          selections: [
            { character: { id: 1271 }, entrant: { id: 1 } },
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
          entrant1Score: null,
          entrant2Score: 0,
        },
      ],
    });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games[0]?.record.win).toBe(true);
    expect('stocksLeft' in games[0]!.record).toBe(false);
  });

  it('marks offline events as offline-tourney', () => {
    const summary = emptySummary();
    const set = makeSet({ event: { isOnline: false, videogame: { id: 1386 } } });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games[0]?.record.matchType).toBe('offline-tourney');
  });

  it('omits event/tournament/round keys entirely when the API provides none', () => {
    const summary = emptySummary();
    const set = makeSet({
      event: { isOnline: true, videogame: { id: 1386 } },
      fullRoundText: null,
      round: null,
    });
    const games = gamesFromSet(set, PLAYER_ID, summary);
    expect(games[0]).toBeDefined();
    // RTDB rejects undefined values — the keys must be absent, not undefined.
    expect('eventName' in games[0]!.record).toBe(false);
    expect('tournamentName' in games[0]!.record).toBe(false);
    expect('roundText' in games[0]!.record).toBe(false);
    expect('bracketRound' in games[0]!.record).toBe(false);
  });

  it('skips DQ sets entirely and counts them separately from setsWithoutGames', () => {
    const summary = emptySummary();
    const set = makeSet({ displayScore: 'DQ' });
    expect(gamesFromSet(set, PLAYER_ID, summary)).toHaveLength(0);
    expect(summary.dqSets).toBe(1);
    expect(summary.setsWithoutGames).toBe(0);
    // DQ sets still count toward `sets` (examined), just not toward imports.
    expect(summary.sets).toBe(1);
  });
});

describe('accumulateRegistry', () => {
  it('extracts eventName, tournamentName, numEntrants, seed, and placement', () => {
    const registry = new Map();
    accumulateRegistry(registry, makeSet(), PLAYER_ID);

    expect(registry.size).toBe(1);
    expect(registry.get(987)).toMatchObject({
      eventId: 987,
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
      numEntrants: 512,
      seed: 408,
      placement: 257,
      setsPlayed: 1,
      firstSetAt: 1_700_000_000_000,
      lastSetAt: 1_700_000_000_000,
    });
  });

  it('accumulates min/max completedAt and setsPlayed across multiple sets in the same event', () => {
    const registry = new Map();
    accumulateRegistry(registry, makeSet({ id: 1, completedAt: 1_700_000_000 }), PLAYER_ID);
    accumulateRegistry(registry, makeSet({ id: 2, completedAt: 1_700_100_000 }), PLAYER_ID);
    accumulateRegistry(registry, makeSet({ id: 3, completedAt: 1_699_900_000 }), PLAYER_ID);

    const entry = registry.get(987);
    expect(entry?.setsPlayed).toBe(3);
    expect(entry?.firstSetAt).toBe(1_699_900_000_000);
    expect(entry?.lastSetAt).toBe(1_700_100_000_000);
  });

  it('groups sets by event.id across multiple events', () => {
    const registry = new Map();
    accumulateRegistry(registry, makeSet({ id: 1 }), PLAYER_ID);
    accumulateRegistry(
      registry,
      makeSet({
        id: 2,
        event: {
          id: 555,
          name: 'Ultimate Doubles',
          isOnline: true,
          videogame: { id: 1386 },
        },
      }),
      PLAYER_ID,
    );

    expect(registry.size).toBe(2);
    expect(registry.get(987)?.eventName).toBe('Ultimate Singles');
    expect(registry.get(555)?.eventName).toBe('Ultimate Doubles');
  });

  it('does not accumulate DQ sets or non-SSBU sets', () => {
    const registry = new Map();
    accumulateRegistry(registry, makeSet({ displayScore: 'DQ' }), PLAYER_ID);
    accumulateRegistry(
      registry,
      makeSet({ event: { id: 1, name: 'Other Game', videogame: { id: 1 } } }),
      PLAYER_ID,
    );
    expect(registry.size).toBe(0);
  });

  it('skips sets with no event id (cannot be grouped into a registry entry)', () => {
    const registry = new Map();
    accumulateRegistry(
      registry,
      makeSet({ event: { name: 'Ultimate Singles', videogame: { id: 1386 } } }),
      PLAYER_ID,
    );
    expect(registry.size).toBe(0);
  });

  it('omits optional fields when start.gg does not provide them', () => {
    const registry = new Map();
    accumulateRegistry(
      registry,
      makeSet({
        event: { id: 987, name: 'Ultimate Singles', videogame: { id: 1386 } },
        slots: [
          { entrant: { id: 1, participants: [{ player: { id: PLAYER_ID } }] } },
          { entrant: { id: 2, participants: [{ player: { id: 999 } }] } },
        ],
      }),
      PLAYER_ID,
    );

    const entry = registry.get(987);
    expect(entry).toBeDefined();
    expect('tournamentName' in entry!).toBe(false);
    expect('numEntrants' in entry!).toBe(false);
    expect('seed' in entry!).toBe(false);
    expect('placement' in entry!).toBe(false);
  });
});

describe('resolveStageByName', () => {
  it('resolves accent and punctuation-insensitively', () => {
    expect(resolveStageByName('Pokemon Stadium 2')?.name).toBe('Pokémon Stadium 2');
    expect(resolveStageByName("Yoshi's Story")?.name).toBe("Yoshi's Story");
  });

  it('returns null for unknown names', () => {
    expect(resolveStageByName('Hyrule Warriors Arena')).toBeNull();
  });
});

describe('resolveStage', () => {
  it("resolves every start.gg stage id observed during the V6-W1b probe that exists in this app's stage list", () => {
    // id -> expected app stage name, taken verbatim from live start.gg data
    // (player 1802316's set history + Genesis 9 Ultimate Singles).
    const observed: [number, string][] = [
      [311, 'Battlefield'],
      [328, 'Final Destination'],
      [348, 'Kalos Pokémon League'],
      [353, 'Lylat Cruise'],
      [378, 'Pokémon Stadium 2'],
      [385, 'Skyloft'],
      [387, 'Smashville'],
      [397, 'Town and City'],
      [484, 'Small Battlefield'],
    ];
    for (const [id, name] of observed) {
      expect(resolveStage(id, 'irrelevant-mismatched-name')?.name).toBe(name);
    }
  });

  it("resolves Hollow Bastion (id 513), added to this app's stage list in quick 260726-r3", () => {
    expect(resolveStage(513, 'irrelevant-mismatched-name')?.name).toBe('Hollow Bastion');
  });

  it('prefers the numeric id over the name when both are present', () => {
    expect(resolveStage(311, 'Not Battlefield At All')?.name).toBe('Battlefield');
  });

  it('falls back to name resolution when the id is unmapped or absent', () => {
    expect(resolveStage(123456789, 'Pokemon Stadium 2')?.name).toBe('Pokémon Stadium 2');
    expect(resolveStage(null, 'Pokemon Stadium 2')?.name).toBe('Pokémon Stadium 2');
    expect(resolveStage(undefined, 'Pokemon Stadium 2')?.name).toBe('Pokémon Stadium 2');
  });

  it('returns null when neither the id nor the name resolve', () => {
    expect(resolveStage(123456789, 'Not A Real Stage')).toBeNull();
    expect(resolveStage(null, null)).toBeNull();
  });
});

describe('importPlayerMatches', () => {
  function pageResponse(sets: StartggSet[], totalPages = 1) {
    return new Response(
      JSON.stringify({
        data: { player: { sets: { pageInfo: { totalPages }, nodes: sets } } },
      }),
    );
  }

  it('writes idempotent keys, updates opponents, and stamps lastSyncAt', async () => {
    const database = new FakeDatabase();
    const fetchMock = async () => pageResponse([makeSet()]);

    const summary = await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    expect(summary.imported).toBe(2);
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const matches = tree['matches']?.['uid-1'] as Record<string, { win: boolean }>;
    expect(Object.keys(matches).sort()).toEqual(['sgg-111-g1', 'sgg-111-g2']);
    expect(tree['opponents']?.['uid-1']).toEqual({ powpow: true });
    expect((tree['startggLinks']?.['uid-1'] as { lastSyncAt: number }).lastSyncAt).toBeGreaterThan(
      0,
    );

    // Re-sync: same keys, no duplicates.
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );
    const matchesAfter = tree['matches']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(matchesAfter)).toHaveLength(2);
  });

  it('writes vodUrl and stocksLeft through to RTDB end-to-end', async () => {
    const database = new FakeDatabase();
    const fetchMock = async () =>
      pageResponse([makeSet({ vodUrl: 'https://youtube.com/watch?v=abc123' })]);

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const matches = tree['matches']?.['uid-1'] as Record<
      string,
      { vodUrl?: string; stocksLeft?: number }
    >;
    expect(matches['sgg-111-g1']?.vodUrl).toBe('https://youtube.com/watch?v=abc123');
    expect(matches['sgg-111-g1']?.stocksLeft).toBe(3);
    expect(matches['sgg-111-g2']?.vodUrl).toBe('https://youtube.com/watch?v=abc123');
    expect(matches['sgg-111-g2']?.stocksLeft).toBe(2);
  });

  it('counts imported games by unique key, not once per page (pagination overlap)', async () => {
    // Simulates the live bug: a set shifting position in the bracket between
    // paginated requests causes the same set (and thus the same game keys)
    // to be delivered on two separate pages. `imported` must reflect the
    // number of distinct games actually written, not one increment per
    // occurrence across pages.
    const database = new FakeDatabase();
    const set = makeSet();
    let setsPageCalls = 0;
    const fetchMock = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('PlayerSets')) {
        setsPageCalls += 1;
        // Same set delivered on both pages of a 2-page result.
        return pageResponse([set], 2);
      }
      // Event detail enrichment call — not under test here.
      return new Response(JSON.stringify({ data: { event: null } }));
    };

    const summary = await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    expect(setsPageCalls).toBe(2);
    expect(summary.imported).toBe(2); // the set has 2 games, not 4
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const matches = tree['matches']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(matches).sort()).toEqual(['sgg-111-g1', 'sgg-111-g2']);
  });

  it('never touches manually-entered push-keyed matches', async () => {
    const database = new FakeDatabase();
    database.seed('matches/uid-1/-manualKey1', { win: true, fighter_id: 1 });
    const fetchMock = async () => pageResponse([makeSet()]);

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const matches = tree['matches']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(matches).sort()).toEqual(['-manualKey1', 'sgg-111-g1', 'sgg-111-g2']);
  });

  it('writes a tournament registry entry keyed by event id, and re-syncs idempotently', async () => {
    const database = new FakeDatabase();
    const fetchMock = async () => pageResponse([makeSet()]);

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(registry)).toEqual(['987']);
    expect(registry['987']).toMatchObject({
      eventId: 987,
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
      numEntrants: 512,
      seed: 408,
      placement: 257,
      setsPlayed: 1,
    });

    // Re-sync: same single entry, no duplication.
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );
    const registryAfter = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    expect(Object.keys(registryAfter)).toEqual(['987']);
  });

  it('does not write a registry entry when no sets were processed', async () => {
    const database = new FakeDatabase();
    const fetchMock = async () => pageResponse([makeSet({ displayScore: 'DQ' })]);

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['tournamentEntries']).toBeUndefined();
  });

  function eventDetailsResponse(overrides: Record<string, unknown> = {}) {
    return new Response(
      JSON.stringify({
        data: {
          event: {
            slug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
            tournament: { slug: 'tournament/the-box-juice-box-26' },
            standings: {
              nodes: [
                {
                  placement: 1,
                  entrant: {
                    name: 'Champ',
                    participants: [
                      { player: { id: 1, gamerTag: 'Champ' }, user: { slug: 'user/abc123' } },
                    ],
                  },
                },
              ],
            },
            ...overrides,
          },
        },
      }),
    );
  }

  /** Splits a combined fetch mock into sets-page vs event-detail calls by query text. */
  function routedFetchMock(
    onSetsPage: () => Promise<Response>,
    onEventDetails: (eventId: number) => Promise<Response>,
  ) {
    return async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes('PlayerSets')) {
        return onSetsPage();
      }
      return onEventDetails(body.variables['eventId'] as number);
    };
  }

  it('enriches the registry with slug/eventSlug/topStandings after pagination', async () => {
    const database = new FakeDatabase();
    let eventDetailCalls = 0;
    const fetchMock = routedFetchMock(
      async () => pageResponse([makeSet()]),
      async () => {
        eventDetailCalls += 1;
        return eventDetailsResponse();
      },
    );

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    expect(eventDetailCalls).toBe(1);
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    expect(registry['987']).toMatchObject({
      slug: 'tournament/the-box-juice-box-26',
      eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
      topStandings: [{ placement: 1, name: 'Champ', gamerTag: 'Champ', userSlug: 'user/abc123' }],
    });
  });

  it('logs and skips enrichment for an event whose detail fetch fails, without failing the sync', async () => {
    const database = new FakeDatabase();
    const fetchMock = routedFetchMock(
      async () => pageResponse([makeSet()]),
      async () => new Response('boom', { status: 500 }),
    );
    const logger = { warn: vi.fn() };

    const summary = await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
      logger,
    );

    expect(summary.sets).toBe(1); // sync itself succeeded
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ eventId: 987 });

    const tree = database.dump() as Record<string, Record<string, unknown>>;
    const registry = tree['tournamentEntries']?.['uid-1'] as Record<string, unknown>;
    // Base registry fields are still present; enrichment fields are simply absent.
    expect(registry['987']).toMatchObject({ eventId: 987, eventName: 'Ultimate Singles' });
    expect('slug' in (registry['987'] as object)).toBe(false);
    expect('eventSlug' in (registry['987'] as object)).toBe(false);
    expect('topStandings' in (registry['987'] as object)).toBe(false);
  });

  it('caps event detail enrichment at 20 events, preferring the most recently active', async () => {
    const database = new FakeDatabase();
    // 25 distinct events, each with one set, with increasing completedAt so
    // recency order is deterministic (event N+1 is more recent than N).
    const sets = Array.from({ length: 25 }, (_, i) =>
      makeSet({
        id: i + 1,
        completedAt: 1_700_000_000 + i,
        event: {
          id: 1000 + i,
          name: `Event ${i}`,
          isOnline: true,
          videogame: { id: 1386 },
        },
      }),
    );
    const requestedEventIds: number[] = [];
    const fetchMock = routedFetchMock(
      async () => pageResponse(sets),
      async (eventId) => {
        requestedEventIds.push(eventId);
        return eventDetailsResponse();
      },
    );

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    expect(requestedEventIds).toHaveLength(20);
    // Most-recent-first: events 1005..1024 (the last 20 by completedAt), not 1000..1004.
    const expectedIds = Array.from({ length: 20 }, (_, i) => 1024 - i);
    expect(requestedEventIds).toEqual(expectedIds);
  });

  // Walkthrough amendment round 2 (07-10): every sync rebuilds registryUpdates
  // from scratch off THIS run's own paginated sets, and the closing
  // `.update()` REPLACES each event's whole node — so without a
  // read-and-merge-forward step, a resync whose enrichment fetch fails (or
  // whose event drops outside the MAX_EVENT_DETAIL_FETCHES recency window)
  // would silently WIPE the previously-fetched slug/eventSlug/topStandings,
  // permanently breaking a recap's "View bracket on start.gg" link for that
  // tournament. These two tests pin the fix.
  it('preserves a previously-fetched slug/eventSlug/topStandings when a resync enrichment fetch fails', async () => {
    const database = new FakeDatabase();

    // First sync: enrichment succeeds, registry gets slug/eventSlug/topStandings.
    const firstFetchMock = routedFetchMock(
      async () => pageResponse([makeSet()]),
      async () => eventDetailsResponse(),
    );
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      firstFetchMock as typeof fetch,
    );
    const afterFirstSync = database.dump() as Record<string, Record<string, unknown>>;
    expect(
      (afterFirstSync['tournamentEntries']?.['uid-1'] as Record<string, unknown>)['987'],
    ).toMatchObject({ slug: 'tournament/the-box-juice-box-26' });

    // Second sync: same event, but this time the detail fetch fails.
    const secondFetchMock = routedFetchMock(
      async () => pageResponse([makeSet()]),
      async () => new Response('boom', { status: 500 }),
    );
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      secondFetchMock as typeof fetch,
      { warn: vi.fn() },
    );

    const afterSecondSync = database.dump() as Record<string, Record<string, unknown>>;
    const entry = (afterSecondSync['tournamentEntries']?.['uid-1'] as Record<string, unknown>)[
      '987'
    ] as Record<string, unknown>;
    expect(entry).toMatchObject({
      slug: 'tournament/the-box-juice-box-26',
      eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
    });
    expect(entry['topStandings']).toEqual([
      { placement: 1, name: 'Champ', gamerTag: 'Champ', userSlug: 'user/abc123' },
    ]);
  });

  it('preserves a previously-fetched slug/eventSlug when an event drops outside the MAX_EVENT_DETAIL_FETCHES recency window on resync', async () => {
    const database = new FakeDatabase();

    // First sync: a single event gets enriched (well within the top-20 cap).
    const firstFetchMock = routedFetchMock(
      async () => pageResponse([makeSet()]),
      async () => eventDetailsResponse(),
    );
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      firstFetchMock as typeof fetch,
    );

    // Second sync: 25 NEW, more-recent events push event 987 outside the
    // top-20 most-recently-active enrichment window — it's still present in
    // this run's registry (still returned by the sets query), just not
    // re-fetched for detail.
    const newerSets = Array.from({ length: 25 }, (_, i) =>
      makeSet({
        id: 2000 + i,
        completedAt: 1_700_000_100 + i,
        event: { id: 3000 + i, name: `Newer Event ${i}`, isOnline: true, videogame: { id: 1386 } },
      }),
    );
    const secondFetchMock = routedFetchMock(
      async () => pageResponse([makeSet(), ...newerSets]),
      async () => eventDetailsResponse(),
    );
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      secondFetchMock as typeof fetch,
    );

    const afterSecondSync = database.dump() as Record<string, Record<string, unknown>>;
    const entry = (afterSecondSync['tournamentEntries']?.['uid-1'] as Record<string, unknown>)[
      '987'
    ] as Record<string, unknown>;
    // Event 987 is no longer in the top-20-by-recency (25 newer events exist),
    // but its slug/eventSlug from the FIRST sync must survive this resync.
    expect(entry).toMatchObject({
      slug: 'tournament/the-box-juice-box-26',
      eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
    });
  });

  // Phase 13 (ONBD-04): the sync-driven happy path must be measured too, not
  // just manual entry (matches.ts's personal-write call sites).
  it('fires tournament_prep_activated once after a sync populates the registry', async () => {
    const database = new FakeDatabase();
    const fetchMock = async () => pageResponse([makeSet()]);

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
    const rows = Object.values(dump.eventLedger ?? {}).flatMap((day) => Object.values(day)) as {
      eventName: string;
      actorId: string;
    }[];
    const fired = rows.filter((row) => row.eventName === 'tournament_prep_activated');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe('uid-1');

    // A second sync must not re-fire (dedup marker already set).
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dumpAfter = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
    const rowsAfter = Object.values(dumpAfter.eventLedger ?? {}).flatMap((day) =>
      Object.values(day),
    ) as { eventName: string }[];
    expect(rowsAfter.filter((row) => row.eventName === 'tournament_prep_activated')).toHaveLength(
      1,
    );
  });
});

// Phase 39.2 plan 01 (D-20, isOnline half): the live sync persists `isOnline`
// on the registry entry with a `!= null` conditional spread. `false` is real
// data (an offline event) and must be stored; an absent value must store NO
// key (never null — RTDB null-stripping house rule).
describe('importPlayerMatches — registry isOnline', () => {
  function pagesFetch(sets: StartggSet[]): typeof fetch {
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('PlayerSets')) {
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
          }),
        );
      }
      return new Response('no details', { status: 500 });
    }) as typeof fetch;
  }

  /** The set's event with the `isOnline` key removed entirely (the provider omitted it). */
  function withoutIsOnline(set: StartggSet): NonNullable<StartggSet['event']> {
    const event = { ...set.event } as Record<string, unknown>;
    delete event['isOnline'];
    return event as NonNullable<StartggSet['event']>;
  }

  function storedEntry(database: FakeDatabase): Record<string, unknown> {
    const tree = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    return tree['tournamentEntries']?.['uid-1']?.['987'] as Record<string, unknown>;
  }

  it('stores isOnline: false as false (not omitted, not null)', async () => {
    const database = new FakeDatabase();
    const base = makeSet();
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([{ ...base, event: { ...base.event, isOnline: false } }]),
      { warn: vi.fn() },
    );

    const entry = storedEntry(database);
    expect(entry['isOnline']).toBe(false);
  });

  it('stores isOnline: true as true', async () => {
    const database = new FakeDatabase();
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([makeSet()]),
      { warn: vi.fn() },
    );

    expect(storedEntry(database)['isOnline']).toBe(true);
  });

  it('stores NO isOnline key when the provider omits it (never null)', async () => {
    const database = new FakeDatabase();
    const base = makeSet();
    const eventWithoutIsOnline = withoutIsOnline(base);
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([{ ...base, event: eventWithoutIsOnline }]),
      { warn: vi.fn() },
    );

    const entry = storedEntry(database);
    expect(entry).toBeDefined();
    expect('isOnline' in entry).toBe(false);
  });

  it('keeps an already-known isOnline when a later set of the same event omits it', async () => {
    const database = new FakeDatabase();
    const first = makeSet({ id: 1, completedAt: 1_700_000_000 });
    const base = makeSet({ id: 2, completedAt: 1_700_000_100 });
    const eventWithoutIsOnline = withoutIsOnline(base);
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([
        { ...first, event: { ...first.event, isOnline: false } },
        { ...base, event: eventWithoutIsOnline },
      ]),
      { warn: vi.fn() },
    );

    expect(storedEntry(database)['isOnline']).toBe(false);
  });
});

// Phase 39.2 plan 03 (F1, D-20): the closing registry `.update()` replaces each
// event's whole node, so user-authored per-event overrides must be carried
// forward or every re-sync deletes them. `rulesetOverride` (37-04) was being
// wiped by every sync before this fix — a live defect found by this phase.
describe('importPlayerMatches — per-event override carry-forward', () => {
  function pagesFetch(sets: StartggSet[]): typeof fetch {
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('PlayerSets')) {
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
          }),
        );
      }
      return new Response('no details', { status: 500 });
    }) as typeof fetch;
  }

  function storedEntry(database: FakeDatabase): Record<string, unknown> {
    const tree = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    return tree['tournamentEntries']?.['uid-1']?.['987'] as Record<string, unknown>;
  }

  const TIER_OVERRIDE = { contractVersion: 1, tier: 'major', setAtMs: 1_700_000_000_000 };
  const RULESET_OVERRIDE = { contractVersion: 1, dsr: 'none' };

  it('store -> sync -> assert: a stored tierOverride AND rulesetOverride survive a re-sync byte-equal', async () => {
    const database = new FakeDatabase();
    database.seed('tournamentEntries/uid-1', {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1,
        lastSetAt: 2,
        setsPlayed: 1,
        tierOverride: TIER_OVERRIDE,
        rulesetOverride: RULESET_OVERRIDE,
      },
    });

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([makeSet()]),
      { warn: vi.fn() },
    );

    const entry = storedEntry(database);
    // The re-sync really rewrote the entry (sync-derived members are fresh)...
    expect(entry['numEntrants']).toBe(512);
    expect(entry['setsPlayed']).toBe(1);
    // ...and both user-authored overrides came through unchanged.
    expect(entry['tierOverride']).toEqual(TIER_OVERRIDE);
    expect(entry['rulesetOverride']).toEqual(RULESET_OVERRIDE);
  });

  it('writes neither override key when none was stored (never null, never empty)', async () => {
    const database = new FakeDatabase();

    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([makeSet()]),
      { warn: vi.fn() },
    );

    const entry = storedEntry(database);
    expect(entry).toBeDefined();
    expect('tierOverride' in entry).toBe(false);
    expect('rulesetOverride' in entry).toBe(false);
  });
});

// 39.2 code review API-CR-01: the user's PATCH can commit while a sync is in
// its enrichment loop (up to MAX_EVENT_DETAIL_FETCHES sequential network
// calls). The fetch stub below performs that PATCH through the REAL route in
// the middle of the REAL sync, so the override the sync commits must be the
// one stored at commit time — a set made mid-sync survives, a clear made
// mid-sync stays cleared.
describe('importPlayerMatches — an override PATCHed mid-sync (API-CR-01)', () => {
  type TestApp = ReturnType<typeof buildTestApp>['app'];
  type Patch = { url: string; payload: object };

  /** PlayerSets answers one page; the FIRST event-detail call runs `midSync` (the user's PATCH) before failing. */
  function fetchPatchingMidSync(sets: StartggSet[], midSync: () => Promise<void>): typeof fetch {
    let fired = false;
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('PlayerSets')) {
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
          }),
        );
      }
      if (!fired) {
        fired = true;
        await midSync();
      }
      return new Response('no details', { status: 500 });
    }) as typeof fetch;
  }

  async function patchAll(app: TestApp, patches: Patch[]): Promise<void> {
    for (const { url, payload } of patches) {
      const response = await app.inject({ method: 'PATCH', url, headers: authHeader(), payload });
      expect(response.statusCode).toBe(200);
    }
  }

  function sync(database: FakeDatabase, fetchImpl: typeof fetch) {
    return importPlayerMatches(database as never, TEST_UID, PLAYER_ID, 'server-token', fetchImpl, {
      warn: vi.fn(),
    });
  }

  function storedRow(database: FakeDatabase): Record<string, unknown> {
    const tree = structuredClone(database.dump()) as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >;
    return tree['tournamentEntries']?.[TEST_UID]?.['987'] ?? {};
  }

  const SET_TIER: Patch = {
    url: '/api/tournaments/987/tier',
    payload: { tierOverride: { tier: 'major' } },
  };
  const SET_RULESET: Patch = {
    url: '/api/tournaments/987/ruleset',
    payload: { rulesetOverride: { contractVersion: 1, dsr: 'none' } },
  };
  const CLEAR_TIER: Patch = { url: '/api/tournaments/987/tier', payload: { tierOverride: null } };
  const CLEAR_RULESET: Patch = {
    url: '/api/tournaments/987/ruleset',
    payload: { rulesetOverride: null },
  };

  it('an override SET while the sync is enriching survives the sync commit', async () => {
    const { app, database } = buildTestApp();
    await sync(
      database,
      fetchPatchingMidSync([makeSet()], async () => undefined),
    );
    expect(storedRow(database)).not.toHaveProperty('tierOverride');

    await sync(
      database,
      fetchPatchingMidSync([makeSet()], () => patchAll(app, [SET_TIER, SET_RULESET])),
    );

    const row = storedRow(database);
    // The sync really committed this run's rebuilt row...
    expect(row['numEntrants']).toBe(512);
    // ...without deleting the override the user set during it.
    expect(row['tierOverride']).toMatchObject({ contractVersion: 1, tier: 'major' });
    expect(row['rulesetOverride']).toEqual({ contractVersion: 1, dsr: 'none' });
  });

  it('an override CLEARED while the sync is enriching stays cleared after the sync commit', async () => {
    const { app, database } = buildTestApp();
    await sync(
      database,
      fetchPatchingMidSync([makeSet()], async () => undefined),
    );
    await patchAll(app, [SET_TIER, SET_RULESET]);
    expect(storedRow(database)).toHaveProperty('tierOverride');

    await sync(
      database,
      fetchPatchingMidSync([makeSet()], () => patchAll(app, [CLEAR_TIER, CLEAR_RULESET])),
    );

    const row = storedRow(database);
    expect(row['numEntrants']).toBe(512);
    expect(row).not.toHaveProperty('tierOverride');
    expect(row).not.toHaveProperty('rulesetOverride');
  });
});

// Phase 39.2 plan 03 (D-20, eventType half): the provider's event-type integer
// is persisted as a bounded string, uninterpreted, with a `!= null` spread.
describe('importPlayerMatches — registry eventType', () => {
  function pagesFetch(sets: StartggSet[]): typeof fetch {
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('PlayerSets')) {
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
          }),
        );
      }
      return new Response('no details', { status: 500 });
    }) as typeof fetch;
  }

  function storedEntry(database: FakeDatabase): Record<string, unknown> {
    const tree = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    return tree['tournamentEntries']?.['uid-1']?.['987'] as Record<string, unknown>;
  }

  it("stores a set's event type: 1 as eventType '1'", async () => {
    const database = new FakeDatabase();
    const base = makeSet();
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([{ ...base, event: { ...base.event, type: 1 } }]),
      { warn: vi.fn() },
    );

    expect(storedEntry(database)['eventType']).toBe('1');
  });

  it('stores NO eventType key when the provider omits or nulls type (never null)', async () => {
    for (const type of [undefined, null]) {
      const database = new FakeDatabase();
      const base = makeSet();
      await importPlayerMatches(
        database as never,
        'uid-1',
        PLAYER_ID,
        'server-token',
        pagesFetch([{ ...base, event: { ...base.event, type } }]),
        { warn: vi.fn() },
      );

      const entry = storedEntry(database);
      expect(entry).toBeDefined();
      expect('eventType' in entry).toBe(false);
    }
  });

  it('keeps an already-known eventType when a later set of the same event omits it', async () => {
    const database = new FakeDatabase();
    const first = makeSet({ id: 1, completedAt: 1_700_000_000 });
    const later = makeSet({ id: 2, completedAt: 1_700_000_100 });
    await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      pagesFetch([
        { ...first, event: { ...first.event, type: 5 } },
        { ...later, event: { ...later.event, type: undefined } },
      ]),
      { warn: vi.fn() },
    );

    expect(storedEntry(database)['eventType']).toBe('5');
  });
});
