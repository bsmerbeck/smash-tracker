import type { Database } from 'firebase-admin/database';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { describe, expect, it } from 'vitest';
import { FakeDatabase, type FakeReference } from '../../test-support/fakeDatabase.js';
import {
  buildCandidateIndex,
  buildCompetitorPairKey,
  normalizeCompetitorTag,
} from './candidateIndex.js';
import { resolveObservation } from './resolution.js';

const TENANT_ID = 'tenant-1';

function asDatabase(database: unknown): Database {
  return database as Database;
}

/**
 * Write-guarded wrapper mirroring `sourceLayer.test.ts`'s
 * `ThrowingOnPathDatabase` convention: every mutating method throws AND is
 * recorded, so a test can assert BOTH "no write method was invoked" (the
 * `writeMethodCalls` array) and "if one somehow were invoked, the test fails
 * loudly rather than silently succeeding against a mutated tree."
 */
class WriteGuardedDatabase {
  readonly writeMethodCalls: string[] = [];

  constructor(private readonly inner: FakeDatabase) {}

  ref(path?: string): FakeReference {
    const innerRef = this.inner.ref(path);
    const guard = (method: string) => () => {
      this.writeMethodCalls.push(method);
      throw new Error(`unexpected write via ${method}() during read-only candidate index build`);
    };
    return {
      ...innerRef,
      set: guard('set'),
      update: guard('update'),
      remove: guard('remove'),
      push: guard('push') as unknown as FakeReference['push'],
      transaction: guard('transaction'),
    };
  }

  seed(path: string, value: unknown): void {
    this.inner.seed(path, value);
  }

  dump(): unknown {
    return this.inner.dump();
  }
}

function seedProviderSet(
  database: FakeDatabase,
  storageKeyOrProviderSetId: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`researchSource/${TENANT_ID}/sets/${storageKeyOrProviderSetId}`, {
    providerSetId: overrides.providerSetId ?? storageKeyOrProviderSetId,
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    ingestionRunId: 'run-1',
    fetchedAtMs: 1000,
    lastObservedAtMs: 1000,
    apiIds: { setId: storageKeyOrProviderSetId },
    entrants: [
      { entrantId: 'e1', name: 'TEAM | Sparg0' },
      { entrantId: 'e2', name: 'Tweek' },
    ],
    games: [
      { gameId: 1, winnerEntrantId: 'e1' },
      { gameId: 2, winnerEntrantId: 'e2' },
      { gameId: 3, winnerEntrantId: 'e1' },
    ],
    totalGames: 3,
    completedAt: 1_754_784_000, // 2025-08-09T20:00:00Z in provider SECONDS
    event: {
      name: 'Ultimate Singles',
      tournamentSlug: 'supernova-2026',
      tournamentName: 'Supernova 2026',
    },
    fullRoundText: 'Grand Final',
    identifier: 'r3m1',
    ...overrides,
  });
}

describe('normalizeCompetitorTag', () => {
  it('delegates to normalizeOpponentTag for sponsor-prefix stripping and lowercasing', () => {
    expect(normalizeCompetitorTag('TEAM | Sparg0')).toBe('sparg0');
  });

  it('strips a trailing parenthetical disambiguation suffix, case-insensitively', () => {
    expect(normalizeCompetitorTag('Light (American player)')).toBe('light');
    expect(normalizeCompetitorTag('Light (AMERICAN PLAYER)')).toBe('light');
  });

  it('handles a sponsor prefix AND a disambiguation suffix together', () => {
    expect(normalizeCompetitorTag('TEAM | Dany (American player)')).toBe('dany');
  });
});

describe('buildCompetitorPairKey', () => {
  it('is seat-order independent', () => {
    expect(buildCompetitorPairKey('sparg0', 'tweek')).toBe(
      buildCompetitorPairKey('tweek', 'sparg0'),
    );
  });
});

describe('buildCandidateIndex', () => {
  it('indexes a set by tournament slug, competitor pair, and calendar day', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'set-1');

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);

    expect(index.size).toBe(1);
    expect(index.byTournamentSlug.get('supernova-2026')).toHaveLength(1);
    const pairKey = buildCompetitorPairKey('sparg0', 'tweek');
    expect(index.byCompetitorPair.get(pairKey)).toHaveLength(1);
    expect(index.byCalendarDay.get('2025-08-10')).toHaveLength(1);
  });

  it('keys an indexed entry by storageKey when present, never by providerSetId in that case', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'derived-key-1', {
      providerSetId: 'raw/illegal-id',
      storageKey: 'derived-key-1',
      providerKeyDerived: true,
    });

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);

    expect(index.getByTargetSetId('derived-key-1')).toBeDefined();
    expect(index.getByTargetSetId('raw/illegal-id')).toBeUndefined();
  });

  it('converts a seconds-valued completion timestamp to milliseconds exactly once', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'set-1', { completedAt: 1_754_784_000 });

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);

    const entry = index.getByTargetSetId('set-1')!;
    expect(entry.completedAtMs).toBe(1_754_784_000_000);
  });

  it('normalizes a sponsor-prefixed tag and a disambiguated tag for the pair index', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'set-1', {
      entrants: [
        { entrantId: 'e1', name: 'TEAM | Sparg0' },
        { entrantId: 'e2', name: 'Dany (American player)' },
      ],
    });

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);
    const pairKey = buildCompetitorPairKey('sparg0', 'dany');
    expect(index.byCompetitorPair.get(pairKey)).toHaveLength(1);
  });

  it('retains and separately addresses two sets between the same pair at the same tournament', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'set-1', { identifier: 'r3m1' });
    seedProviderSet(database, 'set-2', { identifier: 'r3m2' });

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);
    const pairKey = buildCompetitorPairKey('sparg0', 'tweek');
    const entries = index.byCompetitorPair.get(pairKey)!;
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.targetSetId))).toEqual(new Set(['set-1', 'set-2']));
  });

  it('resolves bare Liquipedia slugs against namespaced start.gg provider slugs', async () => {
    const database = new FakeDatabase();
    const event = {
      name: 'Ultimate Singles',
      tournamentSlug: 'tournament/supernova-2026',
      tournamentName: 'Supernova 2026',
    };
    seedProviderSet(database, 'set-1', { event, identifier: 'r3m1' });
    seedProviderSet(database, 'set-2', {
      event,
      identifier: 'r3m2',
      games: [
        { gameId: 1, winnerEntrantId: 'e1' },
        { gameId: 2, winnerEntrantId: 'e2' },
        { gameId: 3, winnerEntrantId: 'e1' },
        { gameId: 4, winnerEntrantId: 'e2' },
        { gameId: 5, winnerEntrantId: 'e1' },
      ],
      totalGames: 5,
    });

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);
    const makeObservation = (input: {
      observationId: string;
      scores: [number, number];
      totalGames: number;
      tournamentStartggSlug?: string;
    }): ResearchEnrichmentObservationRecord => ({
      observationId: input.observationId,
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
      sourceRevisionId: 100,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 1000,
      observedAtMs: 1000,
      matchingStatus: 'unmatched',
      tournamentStartggSlug: input.tournamentStartggSlug ?? 'supernova-2026',
      game: 'ultimate',
      date: '2025-08-10',
      scores: input.scores,
      players: [{ rawTag: 'Sparg0' }, { rawTag: 'Tweek' }],
      games: Array.from({ length: input.totalGames }, (_, index) => ({ ordinal: index + 1 })),
    });

    const namespacedGrandFinalOutcome = resolveObservation(
      makeObservation({
        observationId: 'obs-gf-control',
        scores: [2, 1],
        totalGames: 3,
        tournamentStartggSlug: 'tournament/supernova-2026',
      }),
      index,
    );
    const namespacedResetOutcome = resolveObservation(
      makeObservation({
        observationId: 'obs-reset-control',
        scores: [3, 2],
        totalGames: 5,
        tournamentStartggSlug: 'tournament/supernova-2026',
      }),
      index,
    );
    expect([namespacedGrandFinalOutcome.type, namespacedResetOutcome.type]).toEqual([
      'matched',
      'matched',
    ]);

    const grandFinalOutcome = resolveObservation(
      makeObservation({ observationId: 'obs-gf', scores: [2, 1], totalGames: 3 }),
      index,
    );
    const resetOutcome = resolveObservation(
      makeObservation({ observationId: 'obs-reset', scores: [3, 2], totalGames: 5 }),
      index,
    );

    expect([grandFinalOutcome.type, resetOutcome.type]).toEqual(['matched', 'matched']);
    if (grandFinalOutcome.type === 'matched' && resetOutcome.type === 'matched') {
      expect(grandFinalOutcome.targetSetId).toBe('set-1');
      expect(resetOutcome.targetSetId).toBe('set-2');
    }
  });

  it('skips one malformed record independently rather than aborting the whole build', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'set-1');
    database.seed(`researchSource/${TENANT_ID}/sets/set-bad`, { not: 'a valid record' });

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);

    expect(index.size).toBe(1);
    expect(index.skippedCount).toBe(1);
  });

  it('performs no write while building the index', async () => {
    const database = new FakeDatabase();
    seedProviderSet(database, 'set-1');
    const guarded = new WriteGuardedDatabase(database);

    const index = await buildCandidateIndex(asDatabase(guarded), TENANT_ID);

    expect(index.size).toBe(1);
    expect(guarded.writeMethodCalls).toEqual([]);
  });

  it('returns an empty index for an unsafe tenant id rather than throwing', async () => {
    const database = new FakeDatabase();

    const index = await buildCandidateIndex(asDatabase(database), 'unsafe/tenant.id');

    expect(index.size).toBe(0);
    expect(index.byTournamentSlug.size).toBe(0);
  });
});
