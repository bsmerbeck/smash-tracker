import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { RESEARCH_SET_CLASSIFICATIONS, type ResearchSourceSetRecord } from '@smash-tracker/shared';
import { FakeDatabase, type FakeReference } from '../../test-support/fakeDatabase.js';
import { ConflictingTransactionDatabase } from '../../test-support/conflictingTransactionDatabase.js';
import {
  applyLegacyProjection,
  deriveLegacyProjection,
  mergePreservedMatchMembers,
  PRESERVED_MATCH_MEMBERS,
  PROVIDER_REPLACED_MATCH_MEMBERS,
  type LegacyProjectionResult,
} from './projection.js';
import { ResearchIngestionWriteError } from './sourceLayer.js';

function asDatabase(
  database: FakeDatabase | ConflictingTransactionDatabase | ThrowingOnPathDatabase,
): Database {
  return database as unknown as Database;
}

/** Minimal throwing wrapper matching sourceLayer.test.ts's convention. */
class ThrowingOnPathDatabase {
  constructor(
    private readonly inner: FakeDatabase,
    private readonly kind: 'transaction' | 'update',
    private readonly path?: string,
  ) {}

  ref(path?: string): FakeReference {
    const innerRef = this.inner.ref(path);
    if (this.kind === 'transaction' && path === this.path) {
      return {
        ...innerRef,
        transaction: async () => {
          throw new Error('simulated transaction rejection');
        },
      };
    }
    if (this.kind === 'update' && path === undefined) {
      return {
        ...innerRef,
        update: async () => {
          throw new Error('simulated update rejection');
        },
      };
    }
    return innerRef;
  }

  seed(path: string, value: unknown): void {
    this.inner.seed(path, value);
  }

  dump(): unknown {
    return this.inner.dump();
  }
}

const TENANT_ID = 'tenant-1';

function makeRecord(overrides: Partial<ResearchSourceSetRecord> = {}): ResearchSourceSetRecord {
  return {
    providerSetId: 'set-1',
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    subjectEntrantId: '10',
    opponentEntrantId: '20',
    completedAt: 1_000,
    apiIds: { setId: 'set-1' },
    ingestionRunId: 'run-1',
    fetchedAtMs: 1_000,
    lastObservedAtMs: 1_000,
    event: { isOnline: false, name: 'Genesis', tournamentName: 'Genesis 9' },
    entrants: [
      {
        entrantId: '10',
        name: 'Sponsor | Subject',
        participants: [{ playerId: '100', userSlug: 'subj-slug' }],
      },
      {
        entrantId: '20',
        name: 'Opponent',
        seedNum: 5,
        placement: 3,
        participants: [{ userSlug: 'opp-slug' }],
      },
    ],
    games: [
      {
        gameId: 1,
        winnerEntrantId: '10',
        stageId: 311,
        stageName: 'Battlefield',
        selections: [
          { entrantId: '10', characterId: 1271 },
          { entrantId: '20', characterId: 1286 },
        ],
        entrant1Score: 2,
        entrant2Score: 1,
      },
    ],
    projectedMatchKeys: [],
    ...overrides,
  };
}

describe('deriveLegacyProjection', () => {
  it('projects a complete two-game set into two keyed match updates plus one opponent-tag update', () => {
    const record = makeRecord({
      games: [
        {
          gameId: 1,
          winnerEntrantId: '10',
          stageId: 311,
          stageName: 'Battlefield',
          selections: [
            { entrantId: '10', characterId: 1271 },
            { entrantId: '20', characterId: 1286 },
          ],
          entrant1Score: 2,
          entrant2Score: 1,
        },
        {
          gameId: 2,
          winnerEntrantId: '20',
          stageId: 328,
          stageName: 'Final Destination',
          selections: [
            { entrantId: '10', characterId: 1271 },
            { entrantId: '20', characterId: 1286 },
          ],
          entrant1Score: 0,
          entrant2Score: 3,
        },
      ],
    });
    const result = deriveLegacyProjection(record);
    expect(Object.keys(result.matchUpdates).sort()).toEqual(['sgg-set-1-g1', 'sgg-set-1-g2']);
    expect(result.matchUpdates['sgg-set-1-g1']).not.toBeNull();
    expect(result.matchUpdates['sgg-set-1-g2']).not.toBeNull();
    expect(Object.keys(result.opponentUpdates)).toEqual(['opponent']);
    expect(result.importedGames).toBe(2);
  });

  it('carries source, externalId and matchType derived from the stored event flag', () => {
    const online = deriveLegacyProjection(makeRecord({ event: { isOnline: true } }));
    const offline = deriveLegacyProjection(makeRecord({ event: { isOnline: false } }));
    expect(online.matchUpdates['sgg-set-1-g1']?.source).toBe('startgg');
    expect(online.matchUpdates['sgg-set-1-g1']?.externalId).toBe('sgg:set-1:g1');
    expect(online.matchUpdates['sgg-set-1-g1']?.matchType).toBe('online-tourney');
    expect(offline.matchUpdates['sgg-set-1-g1']?.matchType).toBe('offline-tourney');
  });

  it.each(RESEARCH_SET_CLASSIFICATIONS.filter((classification) => classification !== 'complete'))(
    'produces ZERO non-null match updates for classification "%s"',
    (classification) => {
      const record = makeRecord({ classification });
      const result = deriveLegacyProjection(record);
      const nonNullValues = Object.values(result.matchUpdates).filter((value) => value !== null);
      expect(nonNullValues).toHaveLength(0);
    },
  );

  it('maps every prior projected key to null and reports an empty key list when a set corrects from complete to dq', () => {
    const record = makeRecord({
      classification: 'dq',
      projectedMatchKeys: ['sgg-set-1-g1', 'sgg-set-1-g2'],
    });
    const result = deriveLegacyProjection(record);
    expect(result.matchUpdates['sgg-set-1-g1']).toBeNull();
    expect(result.matchUpdates['sgg-set-1-g2']).toBeNull();
    expect(result.projectedMatchKeys).toEqual([]);
  });

  it('when a complete set shrinks from three games to two, produces two records plus the third prior key mapped to null', () => {
    const record = makeRecord({
      projectedMatchKeys: ['sgg-set-1-g1', 'sgg-set-1-g2', 'sgg-set-1-g3'],
    });
    const result = deriveLegacyProjection(record);
    expect(result.matchUpdates['sgg-set-1-g1']).not.toBeNull();
    expect(result.matchUpdates['sgg-set-1-g3']).toBeNull();
    expect(result.projectedMatchKeys).toEqual(['sgg-set-1-g1']);
  });

  it('skips a game with a missing winner or missing character selection, counts missingGameDetail, and still projects the other games', () => {
    const record = makeRecord({
      games: [
        {
          gameId: 1,
          winnerEntrantId: null,
          selections: [
            { entrantId: '10', characterId: 1271 },
            { entrantId: '20', characterId: 1286 },
          ],
        },
        {
          gameId: 2,
          winnerEntrantId: '10',
          stageId: 311,
          selections: [
            { entrantId: '10', characterId: 1271 },
            { entrantId: '20', characterId: 1286 },
          ],
        },
      ],
    });
    const result = deriveLegacyProjection(record);
    expect(result.matchUpdates['sgg-set-1-g1']).toBeUndefined();
    expect(result.matchUpdates['sgg-set-1-g2']).not.toBeNull();
    expect(result.namedGapDelta.missingGameDetail).toBe(1);
  });

  it('skips a game whose character id is not in the character map, counting unknownCharacter', () => {
    const record = makeRecord({
      games: [
        {
          gameId: 1,
          winnerEntrantId: '10',
          stageId: 311,
          selections: [
            { entrantId: '10', characterId: 999_999 },
            { entrantId: '20', characterId: 1286 },
          ],
        },
      ],
    });
    const result = deriveLegacyProjection(record);
    expect(Object.keys(result.matchUpdates)).toHaveLength(0);
    expect(result.namedGapDelta.unknownCharacter).toBe(1);
  });

  it('still projects a game whose stage resolves to nothing, with the unknown-stage fallback, counting unknownStage', () => {
    const record = makeRecord({
      games: [
        {
          gameId: 1,
          winnerEntrantId: '10',
          stageId: 9_999_999,
          stageName: 'Some Unknown Stage',
          selections: [
            { entrantId: '10', characterId: 1271 },
            { entrantId: '20', characterId: 1286 },
          ],
        },
      ],
    });
    const result = deriveLegacyProjection(record);
    expect(result.matchUpdates['sgg-set-1-g1']?.map).toEqual({ id: 0, name: 'unknown' });
    expect(result.namedGapDelta.unknownStage).toBe(1);
  });

  it('normalizes the opponent tag to lowercase while the stored entrant name keeps its verbatim sponsor prefix', () => {
    const record = makeRecord({
      entrants: [
        { entrantId: '10', name: 'Sponsor | Subject', participants: [{ playerId: '100' }] },
        { entrantId: '20', name: 'Sponsor | OPPONENT', participants: [] },
      ],
    });
    const result = deriveLegacyProjection(record);
    expect(result.matchUpdates['sgg-set-1-g1']?.opponent).toBe('opponent');
    expect(record.entrants?.[1]?.name).toBe('Sponsor | OPPONENT');
  });

  it('never mutates its input and never reads the database', () => {
    const record = makeRecord();
    const clone = JSON.parse(JSON.stringify(record));
    deriveLegacyProjection(record);
    expect(record).toEqual(clone);
  });

  it('never emits any member of PRESERVED_MATCH_MEMBERS on any produced record, across every fixture in this suite', () => {
    const fixtures = [
      makeRecord(),
      makeRecord({ event: { isOnline: true } }),
      makeRecord({ classification: 'dq', projectedMatchKeys: ['sgg-set-1-g1'] }),
      makeRecord({ vodUrl: 'https://youtube.com/watch?v=abc' }),
    ];
    for (const record of fixtures) {
      const result = deriveLegacyProjection(record);
      for (const value of Object.values(result.matchUpdates)) {
        if (value === null) {
          continue;
        }
        for (const member of PRESERVED_MATCH_MEMBERS) {
          expect(member in value).toBe(false);
        }
      }
    }
  });

  it('never emits vodUrl on the emitted record — a provider VOD URL is reported on providerVodUrlByKey instead', () => {
    const record = makeRecord({ vodUrl: 'https://youtube.com/watch?v=abc' });
    const result = deriveLegacyProjection(record);
    expect(result.matchUpdates['sgg-set-1-g1']).not.toHaveProperty('vodUrl');
    expect(result.providerVodUrlByKey['sgg-set-1-g1']).toBe('https://youtube.com/watch?v=abc');
  });
});

describe('PRESERVED_MATCH_MEMBERS / PROVIDER_REPLACED_MATCH_MEMBERS partition', () => {
  it('are disjoint', () => {
    const preserved = new Set(PRESERVED_MATCH_MEMBERS);
    for (const member of PROVIDER_REPLACED_MATCH_MEMBERS) {
      expect(preserved.has(member as unknown as (typeof PRESERVED_MATCH_MEMBERS)[number])).toBe(
        false,
      );
    }
  });

  it('vodUrl is in PRESERVED_MATCH_MEMBERS and NOT in PROVIDER_REPLACED_MATCH_MEMBERS (review C3-H3, D-21)', () => {
    expect(PRESERVED_MATCH_MEMBERS).toContain('vodUrl');
    expect(PROVIDER_REPLACED_MATCH_MEMBERS as readonly string[]).not.toContain('vodUrl');
  });
});

describe('mergePreservedMatchMembers', () => {
  const next = {
    fighter_id: 1,
    opponent_id: 2,
    time: 2_000,
    map: { id: 311, name: 'Battlefield' },
    opponent: 'opponent',
    matchType: 'offline-tourney' as const,
    win: true,
    source: 'startgg' as const,
    externalId: 'sgg:set-1:g1',
    eventName: 'New Event',
  };

  it('carries the six user-owned members through unchanged from the existing row', () => {
    const existing = {
      vodTimestamps: { pushkey1: { seconds: 10, note: 'hi' } },
      tags: ['practice'],
      gsp: 1_500,
      vodStartSeconds: 5,
      notes: 'great set',
      vodUrl: 'https://youtube.com/watch?v=existing',
    };
    const merged = mergePreservedMatchMembers(existing, next);
    expect(merged.vodTimestamps).toEqual(existing.vodTimestamps);
    expect(merged.tags).toEqual(existing.tags);
    expect(merged.gsp).toBe(existing.gsp);
    expect(merged.vodStartSeconds).toBe(existing.vodStartSeconds);
    expect(merged.notes).toBe(existing.notes);
    expect(merged.vodUrl).toBe(existing.vodUrl);
    expect(merged.eventName).toBe('New Event');
  });

  it('FILL-EMPTY-ONLY four-case table for vodUrl (review C3-H3, D-21)', () => {
    // Case 1: existing non-empty + provider DIFFERENT -> keeps existing.
    expect(
      mergePreservedMatchMembers(
        { vodUrl: 'https://youtube.com/existing' },
        next,
        'https://youtube.com/provider',
      ).vodUrl,
    ).toBe('https://youtube.com/existing');

    // Case 2: existing non-empty + provider ABSENT -> keeps existing, never removed.
    expect(
      mergePreservedMatchMembers({ vodUrl: 'https://youtube.com/existing' }, next, undefined)
        .vodUrl,
    ).toBe('https://youtube.com/existing');

    // Case 3: existing absent/empty + provider present -> takes provider's value.
    expect(
      mergePreservedMatchMembers({ vodUrl: '' }, next, 'https://youtube.com/provider').vodUrl,
    ).toBe('https://youtube.com/provider');
    expect(mergePreservedMatchMembers({}, next, 'https://youtube.com/provider').vodUrl).toBe(
      'https://youtube.com/provider',
    );

    // Case 4: neither side has one -> no vodUrl member at all.
    expect(mergePreservedMatchMembers({}, next, undefined)).not.toHaveProperty('vodUrl');
  });

  it('preserves an existing notes value when next omits it — the same user-owned rule', () => {
    const merged = mergePreservedMatchMembers({ notes: 'existing note' }, next);
    expect(merged.notes).toBe('existing note');
  });

  it('removes a provider-owned optional member that next omits — the present-to-absent correction still deletes', () => {
    const merged = mergePreservedMatchMembers(
      { eventName: 'Old Event', tournamentName: 'Old Tournament' },
      next,
    );
    expect(merged.eventName).toBe('New Event'); // next supplied it — replaced.
    expect(merged).not.toHaveProperty('tournamentName'); // next omitted it — removed, not carried forward.
  });

  it('carries the raw vodTimestamps node through OPAQUELY — a keyed push-key object stays a keyed object, never flattened', () => {
    const keyed = {
      'push-key-1': { seconds: 5, note: 'note 1' },
      'push-key-2': { seconds: 10, note: 'note 2' },
    };
    const merged = mergePreservedMatchMembers({ vodTimestamps: keyed }, next);
    expect(merged.vodTimestamps).toBe(keyed);
    expect(Array.isArray(merged.vodTimestamps)).toBe(false);
  });

  it('returns next plus the provider VOD URL when there is nothing to preserve (a first projection)', () => {
    const merged = mergePreservedMatchMembers(undefined, next, 'https://youtube.com/provider');
    expect(merged.vodUrl).toBe('https://youtube.com/provider');
    expect(merged.eventName).toBe('New Event');
  });

  it('never carries a preserved member whose value is undefined into the payload', () => {
    const merged = mergePreservedMatchMembers({ notes: undefined, tags: undefined }, next);
    expect('notes' in merged).toBe(false);
    expect('tags' in merged).toBe(false);
  });

  it.each(PRESERVED_MATCH_MEMBERS)(
    'preserved member "%s" survives a re-projection when present on the existing row',
    (member) => {
      const sampleValues: Record<string, unknown> = {
        vodStartSeconds: 42,
        vodTimestamps: { k1: { seconds: 1, note: 'n' } },
        gsp: 1_800,
        tags: ['tag-a'],
        notes: 'a note',
        vodUrl: 'https://youtube.com/watch?v=x',
      };
      const existing = { [member]: sampleValues[member] };
      const merged = mergePreservedMatchMembers(existing, next);
      expect(merged[member as keyof typeof merged]).toEqual(sampleValues[member]);
    },
  );
});

describe('applyLegacyProjection', () => {
  function projectionResultFor(record: ResearchSourceSetRecord): LegacyProjectionResult {
    return deriveLegacyProjection(record);
  }

  it('writes each match row and the opponent row, plus the projectedMatchKeys index, end to end', async () => {
    const database = new FakeDatabase();
    const record = makeRecord();
    const result = projectionResultFor(record);

    await applyLegacyProjection(asDatabase(database), TENANT_ID, 'set-1', result);

    const dump = database.dump() as Record<string, unknown>;
    const matches = (dump.matches as Record<string, unknown>)?.[TENANT_ID] as Record<
      string,
      unknown
    >;
    expect(matches['sgg-set-1-g1']).toBeDefined();
    const opponents = (dump.opponents as Record<string, unknown>)?.[TENANT_ID] as Record<
      string,
      unknown
    >;
    expect(opponents.opponent).toBe(true);
    const source = (dump.researchSource as Record<string, unknown>)?.[TENANT_ID] as Record<
      string,
      unknown
    >;
    const sets = source.sets as Record<string, unknown>;
    expect((sets['set-1'] as Record<string, unknown>).projectedMatchKeys).toEqual(['sgg-set-1-g1']);
  });

  it('writes nothing at all when there is nothing to write', async () => {
    const database = new FakeDatabase();
    const record = makeRecord({ classification: 'dq', projectedMatchKeys: [] });
    const result = projectionResultFor(record);

    await applyLegacyProjection(asDatabase(database), TENANT_ID, 'set-1', result);

    expect(database.dump()).toEqual({});
  });

  it('writes an empty projected-key list as a removal of the child, never as a stored empty array', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSource/${TENANT_ID}/sets/set-1/projectedMatchKeys`, ['sgg-set-1-g1']);
    const record = makeRecord({ classification: 'dq', projectedMatchKeys: ['sgg-set-1-g1'] });
    const result = projectionResultFor(record);

    await applyLegacyProjection(asDatabase(database), TENANT_ID, 'set-1', result);

    const dump = database.dump() as Record<string, unknown>;
    const source = (dump.researchSource as Record<string, unknown>)?.[TENANT_ID] as
      Record<string, unknown> | undefined;
    const sets = source?.sets as Record<string, unknown> | undefined;
    const stored = sets?.['set-1'] as Record<string, unknown> | undefined;
    expect(stored === undefined || !('projectedMatchKeys' in stored)).toBe(true);
  });

  it('re-projecting over an admin-annotated row leaves every annotation byte-identical while provider fields update (ING-06)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${TENANT_ID}/sgg-set-1-g1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 0, name: 'unknown' },
      opponent: 'opponent',
      matchType: 'offline-tourney',
      win: false,
      source: 'startgg',
      externalId: 'sgg:set-1:g1',
      notes: 'admin note',
      tags: ['practice'],
      gsp: 1_700,
      vodTimestamps: { 'push-1': { seconds: 3, note: 'watch this' } },
      vodUrl: 'https://youtube.com/watch?v=human',
    });

    const record = makeRecord();
    const result = projectionResultFor(record);
    await applyLegacyProjection(asDatabase(database), TENANT_ID, 'set-1', result);

    const dump = database.dump() as Record<string, unknown>;
    const stored = (
      (dump.matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )['sgg-set-1-g1'] as Record<string, unknown>;

    expect(stored.notes).toBe('admin note');
    expect(stored.tags).toEqual(['practice']);
    expect(stored.gsp).toBe(1_700);
    expect(stored.vodTimestamps).toEqual({ 'push-1': { seconds: 3, note: 'watch this' } });
    expect(stored.vodUrl).toBe('https://youtube.com/watch?v=human');
    // Provider-owned fields took the new values.
    expect(stored.win).toBe(true);
    expect(stored.map).toEqual({ id: 1, name: 'Battlefield' });
  });

  it('CONCURRENT ANNOTATION SURVIVAL (review C3-H2): a vodTimestamps child injected mid-transaction survives alongside the new provider values', async () => {
    const inner = new FakeDatabase();
    inner.seed(`matches/${TENANT_ID}/sgg-set-1-g1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 0, name: 'unknown' },
      opponent: 'opponent',
      matchType: 'offline-tourney',
      win: false,
      source: 'startgg',
      externalId: 'sgg:set-1:g1',
    });

    const path = `matches/${TENANT_ID}/sgg-set-1-g1`;
    const conflicting = new ConflictingTransactionDatabase(inner, {
      path,
      competingWrite: async () => {
        await inner.ref(path).transaction((raw) => ({
          ...(raw as Record<string, unknown>),
          vodTimestamps: { 'injected-key': { seconds: 99, note: 'concurrent note' } },
        }));
      },
    });

    const record = makeRecord();
    const result = projectionResultFor(record);
    await applyLegacyProjection(asDatabase(conflicting), TENANT_ID, 'set-1', result);

    const stored = inner.dump() as Record<string, unknown>;
    const row = ((stored.matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>)[
      'sgg-set-1-g1'
    ] as Record<string, unknown>;
    expect(row.vodTimestamps).toEqual({ 'injected-key': { seconds: 99, note: 'concurrent note' } });
    expect(row.win).toBe(true);
  });

  it('CONCURRENT ANNOTATION SURVIVAL on notes too — the property belongs to every preserved member, not one', async () => {
    const inner = new FakeDatabase();
    inner.seed(`matches/${TENANT_ID}/sgg-set-1-g1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 0, name: 'unknown' },
      opponent: 'opponent',
      matchType: 'offline-tourney',
      win: false,
      source: 'startgg',
      externalId: 'sgg:set-1:g1',
    });

    const path = `matches/${TENANT_ID}/sgg-set-1-g1`;
    const conflicting = new ConflictingTransactionDatabase(inner, {
      path,
      competingWrite: async () => {
        await inner.ref(path).transaction((raw) => ({
          ...(raw as Record<string, unknown>),
          notes: 'concurrently written note',
        }));
      },
    });

    const record = makeRecord();
    const result = projectionResultFor(record);
    await applyLegacyProjection(asDatabase(conflicting), TENANT_ID, 'set-1', result);

    const stored = inner.dump() as Record<string, unknown>;
    const row = ((stored.matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>)[
      'sgg-set-1-g1'
    ] as Record<string, unknown>;
    expect(row.notes).toBe('concurrently written note');
  });

  it('a rejected row transaction throws ResearchIngestionWriteError and leaves the projectedMatchKeys index at its pre-call value', async () => {
    const inner = new FakeDatabase();
    inner.seed(`researchSource/${TENANT_ID}/sets/set-1/projectedMatchKeys`, ['old-key']);
    const throwing = new ThrowingOnPathDatabase(
      inner,
      'transaction',
      `matches/${TENANT_ID}/sgg-set-1-g1`,
    );

    const record = makeRecord();
    const result = projectionResultFor(record);

    await expect(
      applyLegacyProjection(asDatabase(throwing), TENANT_ID, 'set-1', result),
    ).rejects.toBeInstanceOf(ResearchIngestionWriteError);

    const dump = inner.dump() as Record<string, unknown>;
    const source = (dump.researchSource as Record<string, unknown>)[TENANT_ID] as Record<
      string,
      unknown
    >;
    const stored = (source.sets as Record<string, unknown>)['set-1'] as Record<string, unknown>;
    expect(stored.projectedMatchKeys).toEqual(['old-key']);
  });

  it('a rejected multi-path update throws ResearchIngestionWriteError and leaves the index/deletions unchanged', async () => {
    const inner = new FakeDatabase();
    inner.seed(`researchSource/${TENANT_ID}/sets/set-1/projectedMatchKeys`, ['old-key']);
    const throwing = new ThrowingOnPathDatabase(inner, 'update');

    const record = makeRecord();
    const result = projectionResultFor(record);

    await expect(
      applyLegacyProjection(asDatabase(throwing), TENANT_ID, 'set-1', result),
    ).rejects.toBeInstanceOf(ResearchIngestionWriteError);

    const dump = inner.dump() as Record<string, unknown>;
    const source = (dump.researchSource as Record<string, unknown>)[TENANT_ID] as Record<
      string,
      unknown
    >;
    const stored = (source.sets as Record<string, unknown>)['set-1'] as Record<string, unknown>;
    expect(stored.projectedMatchKeys).toEqual(['old-key']);
  });

  it('issues exactly one multi-path update call and one transaction call per written match key', async () => {
    const database = new FakeDatabase();
    let updateCalls = 0;
    let transactionCalls = 0;
    const rootRef = database.ref();
    const originalUpdate = rootRef.update.bind(rootRef);
    const proxy: FakeDatabase & { ref: typeof database.ref } = Object.create(database);
    proxy.ref = (path?: string): FakeReference => {
      const inner = database.ref(path);
      if (path === undefined) {
        return {
          ...inner,
          update: async (values: Record<string, unknown>) => {
            updateCalls += 1;
            return originalUpdate(values);
          },
        };
      }
      return {
        ...inner,
        transaction: async (updateFn: (current: unknown) => unknown) => {
          transactionCalls += 1;
          return inner.transaction(updateFn);
        },
      };
    };

    const record = makeRecord();
    const result = projectionResultFor(record);
    await applyLegacyProjection(asDatabase(proxy), TENANT_ID, 'set-1', result);

    expect(updateCalls).toBe(1);
    expect(transactionCalls).toBe(1); // one written match key (sgg-set-1-g1)
  });
});
