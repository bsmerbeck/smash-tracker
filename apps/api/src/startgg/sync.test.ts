import { describe, expect, it } from 'vitest';
import type { StartggSyncSummary } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  accumulateRegistry,
  gamesFromSet,
  importPlayerMatches,
  normalizeOpponentTag,
} from './sync.js';
import { resolveStageByName } from './stageMap.js';
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
      { entrant: { id: 2, name: 'PowPow', participants: [{ player: { id: 999 } }] } },
    ],
    games: [
      {
        winnerId: 1,
        stage: { name: 'Battlefield' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
      },
      {
        winnerId: 2,
        stage: { name: 'Pokémon Stadium 2' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
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
    });
    expect(g1?.record.fighter_id).toBeGreaterThan(0);
    expect(g1?.record.map?.name).toBe('Battlefield');
    // Game 2: lost, accent-insensitive stage resolution
    expect(g2?.record.win).toBe(false);
    expect(g2?.record.map?.name).toContain('Stadium 2');
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

  it('counts imported games by unique key, not once per page (pagination overlap)', async () => {
    // Simulates the live bug: a set shifting position in the bracket between
    // paginated requests causes the same set (and thus the same game keys)
    // to be delivered on two separate pages. `imported` must reflect the
    // number of distinct games actually written, not one increment per
    // occurrence across pages.
    const database = new FakeDatabase();
    const set = makeSet();
    let call = 0;
    const fetchMock = async () => {
      call += 1;
      // Same set delivered on both pages of a 2-page result.
      return pageResponse([set], 2);
    };

    const summary = await importPlayerMatches(
      database as never,
      'uid-1',
      PLAYER_ID,
      'server-token',
      fetchMock as typeof fetch,
    );

    expect(call).toBe(2);
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
});
