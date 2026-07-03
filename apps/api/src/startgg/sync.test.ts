import { describe, expect, it } from 'vitest';
import type { StartggSyncSummary } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { gamesFromSet, importPlayerMatches, normalizeOpponentTag } from './sync.js';
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
  };
}

/** A realistic SSBU set: user (Mario, sgg id 1271) vs PowPow (Sonic, 1332) on Battlefield. */
function makeSet(overrides: Partial<StartggSet> = {}): StartggSet {
  return {
    id: 111,
    completedAt: 1_700_000_000,
    event: { isOnline: true, videogame: { id: 1386 } },
    slots: [
      { entrant: { id: 1, name: 'Team | Me', participants: [{ player: { id: PLAYER_ID } }] } },
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
    expect(summary).toMatchObject({ sets: 1, imported: 2 });

    const [g1, g2] = games;
    expect(g1?.key).toBe('sgg-111-g1');
    expect(g1?.record).toMatchObject({
      time: 1_700_000_000_000,
      opponent: 'powpow',
      matchType: 'online-tourney',
      win: true,
      source: 'startgg',
      externalId: 'sgg:111:g1',
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
});
