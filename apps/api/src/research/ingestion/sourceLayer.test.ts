import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { isPathSafeProviderId } from '@smash-tracker/shared';
import { FakeDatabase, type FakeReference } from '../../test-support/fakeDatabase.js';
import {
  buildStoredSourceSet,
  deriveSafeProviderKey,
  providerContentFingerprint,
  ResearchIngestionWriteError,
  toProviderFields,
  upsertResearchSourceSet,
  type ResearchSourceProviderFields,
} from './sourceLayer.js';
import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from '../../startgg/client.js';
import { classifyResearchSet } from './classification.js';

function asDatabase(database: FakeDatabase | ThrowingOnPathDatabase): Database {
  return database as unknown as Database;
}

/** Minimal throwing wrapper: `.ref(path).transaction()` rejects for exactly ONE nominated path, proxying everything else to the inner FakeDatabase unchanged. */
class ThrowingOnPathDatabase {
  constructor(
    private readonly inner: FakeDatabase,
    private readonly path: string,
  ) {}

  ref(path?: string): FakeReference {
    const innerRef = this.inner.ref(path);
    if (path !== this.path) {
      return innerRef;
    }
    return {
      ...innerRef,
      transaction: async () => {
        throw new Error('simulated database rejection');
      },
    };
  }

  seed(path: string, value: unknown): void {
    this.inner.seed(path, value);
  }

  dump(): unknown {
    return this.inner.dump();
  }
}

const TENANT_ID = 'tenant-1';
const RUN_1 = 'run-1';
const RUN_2 = 'run-2';
const PLAYER_1 = 'player-1';
const PLAYER_2 = 'player-2';

function makeFields(
  overrides: Partial<ResearchSourceProviderFields> = {},
): ResearchSourceProviderFields {
  return {
    providerSetId: 'set-1',
    apiIds: { setId: 'set-1' },
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    subjectEntrantId: '10',
    opponentEntrantId: '20',
    completedAt: 1_000,
    displayScore: '2-1',
    ...overrides,
  };
}

function dumpRecord(database: FakeDatabase, storageKey = 'set-1'): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const tenant = dump.researchSource as Record<string, unknown> | undefined;
  const setsTree = (tenant?.[TENANT_ID] as Record<string, unknown> | undefined)?.sets as
    Record<string, unknown> | undefined;
  return (setsTree?.[storageKey] ?? {}) as Record<string, unknown>;
}

describe('providerContentFingerprint', () => {
  it('is stable across key ordering', () => {
    const a = providerContentFingerprint(makeFields());
    const b = providerContentFingerprint({
      classification: 'complete',
      providerSetId: 'set-1',
      ruleId: 'R-COMPLETE',
      completedAt: 1_000,
      apiIds: { setId: 'set-1' },
      opponentEntrantId: '20',
      subjectEntrantId: '10',
      displayScore: '2-1',
    });
    expect(a).toBe(b);
  });

  it('changes when a provider value changes', () => {
    const a = providerContentFingerprint(makeFields());
    const b = providerContentFingerprint(makeFields({ displayScore: '3-1' }));
    expect(a).not.toBe(b);
  });

  it('does not depend on bookkeeping members — it only ever sees ResearchSourceProviderFields', () => {
    // Bookkeeping members (ingestionRunId, ingestionPage, firstIngestionPlayerId,
    // fetchedAtMs, lastObservedAtMs, baselineFingerprint) are not part of
    // ResearchSourceProviderFields at all, so two fingerprints of the SAME
    // fields object are always equal regardless of what upsert call produced them.
    const fields = makeFields();
    expect(providerContentFingerprint(fields)).toBe(providerContentFingerprint(fields));
  });
});

describe('deriveSafeProviderKey', () => {
  it('is deterministic', () => {
    expect(deriveSafeProviderKey('abc')).toBe(deriveSafeProviderKey('abc'));
  });

  it('is itself path-safe', () => {
    expect(isPathSafeProviderId(deriveSafeProviderKey('bad/id.with#chars'))).toBe(true);
  });

  it('produces different keys for two ids differing only by an illegal character', () => {
    expect(deriveSafeProviderKey('set/1')).not.toBe(deriveSafeProviderKey('set/2'));
  });
});

describe('toProviderFields', () => {
  function makeSet(overrides: Partial<StartggResearchSet> = {}): StartggResearchSet {
    return {
      id: 555,
      state: null,
      completedAt: 1_000,
      createdAt: null,
      updatedAt: null,
      fullRoundText: null,
      round: null,
      displayScore: '2-1',
      totalGames: null,
      vodUrl: null,
      identifier: null,
      event: {
        id: 1,
        name: 'Genesis',
        slug: null,
        isOnline: false,
        numEntrants: null,
        type: null,
        videogame: { id: SSBU_VIDEOGAME_ID },
        tournament: null,
      },
      slots: [
        {
          entrant: {
            id: 10,
            name: 'Sponsor | Subject',
            isDisqualified: null,
            initialSeedNum: null,
            participants: [{ player: { id: 100, gamerTag: 'Subject' }, user: null }],
            seeds: null,
            standing: null,
          },
        },
        {
          entrant: {
            id: 20,
            name: 'Opponent',
            isDisqualified: null,
            initialSeedNum: null,
            participants: [{ player: { id: 200, gamerTag: 'Opponent' }, user: null }],
            seeds: null,
            standing: null,
          },
        },
      ],
      games: [
        {
          id: 1,
          winnerId: 10,
          stage: { id: 1, name: 'Battlefield' },
          selections: [
            { character: { id: 1 }, entrant: { id: 10 } },
            { character: { id: 2 }, entrant: { id: 20 } },
          ],
          entrant1Score: null,
          entrant2Score: null,
        },
      ],
      ...overrides,
    };
  }

  it('keeps entrant name VERBATIM, sponsor prefix intact (D-13)', () => {
    const set = makeSet();
    const classification = classifyResearchSet({ set, confirmedPlayerIds: new Set(['100']) });
    const fields = toProviderFields(set, classification);
    expect(fields.entrants?.[0]?.name).toBe('Sponsor | Subject');
  });

  it('carries classification and ruleId through from the classifier', () => {
    const set = makeSet();
    const classification = classifyResearchSet({ set, confirmedPlayerIds: new Set(['100']) });
    const fields = toProviderFields(set, classification);
    expect(fields.classification).toBe('complete');
    expect(fields.ruleId).toBe('R-COMPLETE');
  });

  it('never invents a value for an absent field', () => {
    const set = makeSet({ vodUrl: null });
    const classification = classifyResearchSet({ set, confirmedPlayerIds: new Set(['100']) });
    const fields = toProviderFields(set, classification);
    expect(fields.vodUrl).toBeUndefined();
  });
});

describe('upsertResearchSourceSet', () => {
  it('writes a created record on a never-seen set', async () => {
    const database = new FakeDatabase();
    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    expect(result.outcome).toBe('created');
    expect(result.contributes).toBe(true);
    expect(result.uniqueToTenant).toBe(true);
    expect(result.firstIngestionPlayerId).toBe(PLAYER_1);
    expect(result.previousIngestionRunId).toBeNull();
    expect(result.previousIngestionPage).toBeNull();
    expect(result.baselineFingerprint).toBeNull();

    const stored = dumpRecord(database);
    expect(stored.fetchedAtMs).toBe(1_000);
    expect(stored.lastObservedAtMs).toBe(1_000);
    expect(stored.ingestionRunId).toBe(RUN_1);
    expect(stored.ingestionPage).toBe(1);
    expect(stored.firstIngestionPlayerId).toBe(PLAYER_1);
  });

  it('re-upserting identical content preserves fetchedAtMs, advances lastObservedAtMs, updates ingestionRunId, and returns replaced-unchanged', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    const second = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 2_000,
    });

    expect(second.outcome).toBe('replaced-unchanged');
    const stored = dumpRecord(database);
    expect(stored.fetchedAtMs).toBe(1_000);
    expect(stored.lastObservedAtMs).toBe(2_000);
    expect(stored.ingestionRunId).toBe(RUN_2);
  });

  it('re-upserting a changed provider value returns replaced-changed and the stored record shows the new value', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: '3-0' }),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_100,
    });

    expect(result.outcome).toBe('replaced-changed');
    expect(dumpRecord(database).displayScore).toBe('3-0');
  });

  it('re-upserting a set whose response no longer carries vodUrl produces a stored record with no vodUrl key at all', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ vodUrl: 'https://youtube.com/watch?v=abc' }),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 2_000,
    });

    expect('vodUrl' in dumpRecord(database)).toBe(false);
  });

  it('CONTRIBUTION AND THE PAGE MARKER — a four-case table read from both the returned contributes and the STORED ingestionPage', async () => {
    const database = new FakeDatabase();

    // Case 1: first-ever upsert.
    const case1 = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    expect(case1.contributes).toBe(true);
    expect(dumpRecord(database).ingestionPage).toBe(1);

    // Case 2: re-upsert in a DIFFERENT run.
    const case2 = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 3,
      fetchedSnapshotAtMs: 2_000,
    });
    expect(case2.contributes).toBe(true);
    expect(dumpRecord(database).ingestionPage).toBe(3);

    // Case 3: re-upsert in the SAME run at the SAME page.
    const case3 = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 3,
      fetchedSnapshotAtMs: 2_100,
    });
    expect(case3.contributes).toBe(true);
    expect(dumpRecord(database).ingestionPage).toBe(3);

    // Case 4: re-upsert in the SAME run at a LATER page — the cross-page
    // overlap case — contributes false and the stored page stays at its
    // EARLIER value.
    const case4 = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 4,
      fetchedSnapshotAtMs: 2_200,
    });
    expect(case4.contributes).toBe(false);
    expect(dumpRecord(database).ingestionPage).toBe(3);

    // Case 5: a RETRY of that later page still returns contributes: false.
    const case5 = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 4,
      fetchedSnapshotAtMs: 2_300,
    });
    expect(case5.contributes).toBe(false);
    expect(dumpRecord(database).ingestionPage).toBe(3);
  });

  it('firstIngestionPlayerId is written on create, unchanged by a re-upsert supplying a different player id, and drives uniqueToTenant in both directions', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    const sameOwner = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 2_000,
    });
    expect(sameOwner.uniqueToTenant).toBe(true);
    expect(sameOwner.firstIngestionPlayerId).toBe(PLAYER_1);

    const differentOwner = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: 'run-3',
      playerId: PLAYER_2,
      page: 1,
      fetchedSnapshotAtMs: 3_000,
    });
    expect(differentOwner.uniqueToTenant).toBe(false);
    expect(differentOwner.firstIngestionPlayerId).toBe(PLAYER_1);
    expect(dumpRecord(database).firstIngestionPlayerId).toBe(PLAYER_1);
  });

  it('a record whose stored firstIngestionPlayerId is ABSENT is claimed by the upserting run', async () => {
    const database = new FakeDatabase();
    // Seed a record predating the member — no firstIngestionPlayerId at all.
    database.seed(`researchSource/${TENANT_ID}/sets/set-1`, {
      providerSetId: 'set-1',
      apiIds: { setId: 'set-1' },
      classification: 'complete',
      ruleId: 'R-COMPLETE',
      ingestionRunId: RUN_1,
      fetchedAtMs: 500,
      lastObservedAtMs: 500,
      contentFingerprint: providerContentFingerprint(makeFields()),
    });

    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_2,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    expect(result.uniqueToTenant).toBe(true);
    expect(result.firstIngestionPlayerId).toBe(PLAYER_2);
    expect(dumpRecord(database).firstIngestionPlayerId).toBe(PLAYER_2);
  });

  it('STALE-WRITE COMPARE-AND-SKIP: an older fetchedSnapshotAtMs than the stored lastObservedAtMs writes nothing and leaves the record byte-identical, even with DIFFERENT provider content', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 5_000,
    });
    const before = dumpRecord(database);

    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: 'DIFFERENT-CONTENT' }),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000, // older than the stored lastObservedAtMs of 5000
    });

    expect(result.outcome).toBe('stale-write-skipped');
    expect(result.contributes).toBe(false);
    expect(result.uniqueToTenant).toBe(false);
    expect(dumpRecord(database)).toEqual(before);
  });

  it('an EQUAL fetchedSnapshotAtMs applies the write normally', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 5_000,
    });

    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: '3-0' }),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 5_000,
    });

    expect(result.outcome).toBe('replaced-changed');
    expect(dumpRecord(database).displayScore).toBe('3-0');
  });

  it('re-upserting preserves projectedMatchKeys and returns them as previousProjectedMatchKeys', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    // Simulate a prior projection having recorded keys directly on the child.
    database.seed(`researchSource/${TENANT_ID}/sets/set-1/projectedMatchKeys`, [
      'sgg-set-1-g1',
      'sgg-set-1-g2',
    ]);

    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: '3-0' }),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_100,
    });

    expect(result.previousProjectedMatchKeys).toEqual(['sgg-set-1-g1', 'sgg-set-1-g2']);
    expect(dumpRecord(database).projectedMatchKeys).toEqual(['sgg-set-1-g1', 'sgg-set-1-g2']);
  });

  it('previousIngestionRunId is null on first write, equals the current run id on a same-run re-upsert, and equals the earlier run id on a later-run re-upsert — previousIngestionPage tracks the same way', async () => {
    const database = new FakeDatabase();
    const first = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    expect(first.previousIngestionRunId).toBeNull();
    expect(first.previousIngestionPage).toBeNull();

    const sameRun = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_100,
    });
    expect(sameRun.previousIngestionRunId).toBe(RUN_1);
    expect(sameRun.previousIngestionPage).toBe(1);

    const laterRun = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_200,
    });
    expect(laterRun.previousIngestionRunId).toBe(RUN_1);
  });

  it('baselineFingerprint (review C2-H2): first upsert null; a same-run same-page RE-upsert after a content change returns the SAME baseline the first attempt of that (run,page) SAW, never the value that attempt WROTE; a later run resets the baseline to the fingerprint the prior run committed', async () => {
    const database = new FakeDatabase();

    // Call A: the very first upsert ever — no prior record, baseline null.
    const callA = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    expect(callA.baselineFingerprint).toBeNull();

    // Call B: a NEW (run, page) pair — RUN_2/page 1 touches this record for
    // the first time, so its baseline resets to call A's committed fingerprint.
    const callB = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: '3-0' }),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_100,
    });
    expect(callB.baselineFingerprint).toBe(callA.fingerprint);
    expect(callB.outcome).toBe('replaced-changed');

    // Call C: a RETRY of the SAME (RUN_2, page 1) after ANOTHER content
    // change — the baseline must equal what call B SAW (callA's fingerprint),
    // never what call B WROTE (callB's own fingerprint).
    const callC = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: '5-0' }),
      ingestionRunId: RUN_2,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_200,
    });
    expect(callC.baselineFingerprint).toBe(callA.fingerprint);
    expect(callC.baselineFingerprint).not.toBe(callB.fingerprint);
    expect(dumpRecord(database).baselineFingerprint).toBe(callA.fingerprint);
  });

  it('the stored baselineFingerprint resets whenever the (run, page) pair changes', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields({ displayScore: '9-0' }),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 2,
      fetchedSnapshotAtMs: 1_100,
    });
    // A new page in the same run resets the baseline to the prior committed
    // fingerprint (the "9-0" content's own fingerprint), not carried forward.
    const stored = dumpRecord(database);
    expect(stored.baselineFingerprint).toBe(providerContentFingerprint(makeFields()));
  });

  it('an RTDB-illegal provider set id stores the record under deriveSafeProviderKey, preserving the raw id and reporting keyDerived', async () => {
    const database = new FakeDatabase();
    const rawId = 'set/with/slash';
    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: rawId,
      fields: makeFields({ providerSetId: rawId }),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    expect(result.keyDerived).toBe(true);
    expect(result.storageKey).toBe(deriveSafeProviderKey(rawId));
    expect(isPathSafeProviderId(result.storageKey!)).toBe(true);

    const stored = dumpRecord(database, result.storageKey!);
    expect(stored.providerSetId).toBe(rawId);
    expect(stored.providerKeyDerived).toBe(true);
    expect(stored.storageKey).toBe(result.storageKey);
  });

  it('an RTDB-illegal TENANT id returns rejected-key, writes nothing, and throws nothing', async () => {
    const database = new FakeDatabase();
    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: 'tenant.bad',
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    expect(result.outcome).toBe('rejected-key');
    expect(database.dump()).toEqual({});
  });

  it('a rejected database write throws ResearchIngestionWriteError and writes nothing', async () => {
    const inner = new FakeDatabase();
    const throwing = new ThrowingOnPathDatabase(inner, `researchSource/${TENANT_ID}/sets/set-1`);

    await expect(
      upsertResearchSourceSet(asDatabase(throwing), {
        tenantId: TENANT_ID,
        providerSetId: 'set-1',
        fields: makeFields(),
        ingestionRunId: RUN_1,
        playerId: PLAYER_1,
        page: 1,
        fetchedSnapshotAtMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ResearchIngestionWriteError);

    expect(inner.dump()).toEqual({});
  });

  it('a stored record that fails schema parse degrades to an empty prior state and proceeds as a fresh write', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSource/${TENANT_ID}/sets/set-1`, { garbage: true });

    const result = await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });

    expect(result.outcome).toBe('created');
    expect(dumpRecord(database).classification).toBe('complete');
  });

  it('fetchedAtMs is preserved and lastObservedAtMs advances across a re-upsert', async () => {
    const database = new FakeDatabase();
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 1_000,
    });
    await upsertResearchSourceSet(asDatabase(database), {
      tenantId: TENANT_ID,
      providerSetId: 'set-1',
      fields: makeFields(),
      ingestionRunId: RUN_1,
      playerId: PLAYER_1,
      page: 1,
      fetchedSnapshotAtMs: 9_999,
    });
    const stored = dumpRecord(database);
    expect(stored.fetchedAtMs).toBe(1_000);
    expect(stored.lastObservedAtMs).toBe(9_999);
  });
});

describe('buildStoredSourceSet', () => {
  it('omits keyDerived-related members when the key was not derived', () => {
    const stored = buildStoredSourceSet({
      providerSetId: 'set-1',
      storageKey: 'set-1',
      keyDerived: false,
      fields: makeFields(),
      fingerprint: 'fp',
      baselineFingerprint: null,
      ingestionRunId: RUN_1,
      ingestionPage: 1,
      firstIngestionPlayerId: PLAYER_1,
      fetchedAtMs: 1_000,
      lastObservedAtMs: 1_000,
      projectedMatchKeys: [],
    });
    expect('storageKey' in stored).toBe(false);
    expect('providerKeyDerived' in stored).toBe(false);
    expect('baselineFingerprint' in stored).toBe(false);
    expect('projectedMatchKeys' in stored).toBe(false);
  });
});
