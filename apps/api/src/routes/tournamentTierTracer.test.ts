import { describe, expect, it } from 'vitest';
import { resolveTournamentTier, type TierEntryFields } from '@smash-tracker/shared';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import { importPlayerMatches } from '../startgg/sync.js';
import type { StartggSet } from '../startgg/client.js';

/**
 * Phase 39.2 tracer (TIER-01): a start.gg event's stored fields travel
 * through the REAL sync writer, RTDB, the REAL `GET /api/tournaments` route
 * and into the one shared resolver. The negative property (F2 — an online or
 * unknown-setting mega-event is never estimated) is only meaningful on
 * persisted bytes, so nothing here hand-builds the resolver's input.
 */

const PLAYER_ID = 1802316;

function setFor(input: {
  setId: number;
  eventId: number;
  eventName: string;
  tournamentName: string;
  numEntrants: number;
  isOnline?: boolean;
  completedAt: number;
}): StartggSet {
  return {
    id: input.setId,
    completedAt: input.completedAt,
    fullRoundText: 'Winners Round 1',
    round: 1,
    displayScore: '2-0',
    totalGames: 2,
    event: {
      id: input.eventId,
      name: input.eventName,
      ...(input.isOnline !== undefined ? { isOnline: input.isOnline } : {}),
      numEntrants: input.numEntrants,
      videogame: { id: 1386 },
      tournament: { name: input.tournamentName },
    },
    slots: [
      {
        entrant: {
          id: 1,
          name: 'Team | Me',
          participants: [{ player: { id: PLAYER_ID } }],
          seeds: [{ seedNum: 4 }],
          standing: { placement: 9 },
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
        stage: { id: 311, name: 'Battlefield' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
        entrant1Score: 3,
        entrant2Score: 0,
      },
      {
        winnerId: 1,
        stage: { id: 378, name: 'Pokémon Stadium 2' },
        selections: [
          { character: { id: 1271 }, entrant: { id: 1 } },
          { character: { id: 1332 }, entrant: { id: 2 } },
        ],
        entrant1Score: 2,
        entrant2Score: 0,
      },
    ],
  };
}

function fetchFor(sets: StartggSet[]): typeof fetch {
  return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('PlayerSets')) {
      return new Response(
        JSON.stringify({
          data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
        }),
      );
    }
    // Event-detail enrichment is not under test; a failure is logged and skipped.
    return new Response('no details', { status: 500 });
  }) as typeof fetch;
}

/** The wire members this test reads back from GET /api/tournaments (both union shapes). */
type TournamentWire = TierEntryFields & {
  eventId?: number | null;
  entryKey?: string | null;
  origin?: string;
};

async function getTournaments(app: ReturnType<typeof buildTestApp>['app']) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/tournaments',
    headers: authHeader(),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as TournamentWire[];
}

describe('tier tracer: sync writer -> RTDB -> GET /api/tournaments -> resolveTournamentTier', () => {
  it('resolves a synced offline 1,581-entrant event as an estimated supermajor and an online 5,605-entrant event as unknown/online', async () => {
    const { app, database } = buildTestApp();
    const sets = [
      setFor({
        setId: 1,
        eventId: 4001,
        eventName: 'Ultimate Singles',
        tournamentName: 'Supernova Fixture',
        numEntrants: 1581,
        isOnline: false,
        completedAt: 1_700_000_000,
      }),
      setFor({
        setId: 2,
        eventId: 4002,
        eventName: 'Ultimate Singles',
        tournamentName: 'Online Mega Fixture',
        numEntrants: 5605,
        isOnline: true,
        completedAt: 1_700_100_000,
      }),
    ];

    await importPlayerMatches(
      database as never,
      TEST_UID,
      PLAYER_ID,
      'server-token',
      fetchFor(sets),
      { warn: () => undefined },
    );

    const entries = await getTournaments(app);
    const offline = entries.find((e) => e.eventId === 4001);
    const online = entries.find((e) => e.eventId === 4002);
    expect(offline).toBeDefined();
    expect(online).toBeDefined();
    // isOnline survives the real GET serializer, false included.
    expect(offline?.isOnline).toBe(false);
    expect(online?.isOnline).toBe(true);

    expect(resolveTournamentTier({ entry: offline as TierEntryFields })).toMatchObject({
      tier: 'supermajor',
      basis: 'estimated',
      source: 'heuristic',
      setting: 'offline',
      eventKind: 'main',
    });
    expect(resolveTournamentTier({ entry: online as TierEntryFields })).toMatchObject({
      tier: 'unknown',
      basis: 'unknown',
      reason: 'online',
    });

    // Resolution is read-time only: nothing resolved was persisted (D-04).
    const stored = (database.dump() as Record<string, Record<string, Record<string, unknown>>>)[
      'tournamentEntries'
    ]?.[TEST_UID];
    for (const child of Object.values(stored ?? {})) {
      expect(child).not.toHaveProperty('tier');
      expect(child).not.toHaveProperty('basis');
      expect(child).not.toHaveProperty('estimate');
    }
  });

  it('stores an absent isOnline as an absent key and resolves the event as unknown/settingUnknown even at 8,158 entrants', async () => {
    const { app, database } = buildTestApp();

    await importPlayerMatches(
      database as never,
      TEST_UID,
      PLAYER_ID,
      'server-token',
      fetchFor([
        setFor({
          setId: 3,
          eventId: 4003,
          eventName: 'Ultimate Singles',
          tournamentName: 'Unknown Setting Fixture',
          numEntrants: 8158,
          completedAt: 1_700_200_000,
        }),
      ]),
      { warn: () => undefined },
    );

    const stored = (database.dump() as Record<string, Record<string, Record<string, unknown>>>)[
      'tournamentEntries'
    ]?.[TEST_UID]?.['4003'] as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect('isOnline' in stored).toBe(false);

    const entries = await getTournaments(app);
    const entry = entries.find((e) => e.eventId === 4003);
    expect(entry?.isOnline).toBeUndefined();
    expect(resolveTournamentTier({ entry: entry as TierEntryFields })).toMatchObject({
      tier: 'unknown',
      reason: 'settingUnknown',
    });
  });

  it('serialises isOnline, eventType and tierOverride for a registry-row-shaped entry too (both union members declare them)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      'histimport:5001': {
        entryId: 'histimport:5001',
        origin: 'admin-imported',
        provider: 'startgg',
        startggEventId: '5001',
        eventName: 'Ultimate Singles',
        tournamentName: 'Registry Fixture',
        numEntrants: 700,
        isOnline: false,
        eventType: 'singles',
        tierOverride: { contractVersion: 1, tier: 'minor', setAtMs: 1_700_000_000_000 },
        playedSetCount: 3,
        provenance: { source: 'research-import', importedAtMs: 1_700_000_000_000 },
        registryWitness: 'research-import:v1:5001',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_100_000,
        setsPlayed: 3,
      },
    });

    const entries = await getTournaments(app);
    const row = entries.find((e) => e.entryKey === 'histimport:5001') as
      (TierEntryFields & { origin?: string }) | undefined;
    expect(row).toBeDefined();
    // Only a parsed registry-row-shaped member carries `origin`; if the row
    // failed its schema it would have been skipped, not returned.
    expect(row?.origin).toBe('admin-imported');
    expect(row?.isOnline).toBe(false);
    expect(row?.eventType).toBe('singles');
    expect(row?.tierOverride).toEqual({
      contractVersion: 1,
      tier: 'minor',
      setAtMs: 1_700_000_000_000,
    });
    expect(resolveTournamentTier({ entry: row as TierEntryFields })).toMatchObject({
      tier: 'minor',
      basis: 'manual',
    });
  });
});
