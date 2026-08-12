import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type {
  MatchRecord,
  ResearchEnrichmentAttachmentRecord,
  ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  FaultInjectingDatabase,
  FaultInjectedError,
} from '../../test-support/faultInjectingDatabase.js';
import { writeEnrichmentObservation, confirmEnrichmentObservationByAdmin } from './store.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
  deriveEnrichmentMatchRowKey,
  readEnrichmentOverlayForSet,
  readEnrichmentOverlayForTenant,
  type EnrichmentOverlay,
} from './projection.js';

const TENANT_ID = 'tenant-1';

function asDatabase(database: FakeDatabase | FaultInjectingDatabase): Database {
  return database as unknown as Database;
}

function seedMatch(database: FakeDatabase, key: string, record: Partial<MatchRecord>): void {
  database.seed(`matches/${TENANT_ID}/${key}`, {
    fighter_id: 1,
    opponent_id: 2,
    time: 1000,
    win: true,
    source: 'startgg',
    ...record,
  });
}

function makeObservation(
  overrides: Partial<ResearchEnrichmentObservationRecord> = {},
): ResearchEnrichmentObservationRecord {
  return {
    observationId: 'obs-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    sourceRevisionId: 500,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-legacy@1',
    templateFamily: 'legacy',
    fetchedAtMs: 1000,
    observedAtMs: 1000,
    matchingStatus: 'unmatched',
    ...overrides,
  };
}

async function seedAdminAttachedObservation(
  database: FakeDatabase,
  targetSetId: string,
  record: ResearchEnrichmentObservationRecord,
  nowMs: number,
): Promise<void> {
  await writeEnrichmentObservation(asDatabase(database), TENANT_ID, {
    ...record,
    candidateTargetSetIds: [targetSetId],
  });
  const result = await confirmEnrichmentObservationByAdmin(
    asDatabase(database),
    TENANT_ID,
    record.observationId,
    targetSetId,
    'admin-1',
    nowMs,
  );
  expect(result.outcome).toBe('created');
}

// ---------------------------------------------------------------------------
// buildEnrichmentOverlay
// ---------------------------------------------------------------------------

describe('buildEnrichmentOverlay', () => {
  it('derives the same row key shape the shipped ingestion projection uses for a seeded set', () => {
    const targetSetId = 'startgg-set-parity';
    expect(deriveEnrichmentMatchRowKey(targetSetId, 1)).toBe(`sgg-${targetSetId}-g1`);
    expect(deriveEnrichmentMatchRowKey(targetSetId, 3)).toBe(`sgg-${targetSetId}-g3`);
  });

  it('applies a set-level VOD to every declared game row, and a game-level stage only to its matching ordinal', () => {
    const targetSetId = 'startgg-set-gf';
    const observation = makeObservation({
      observationId: 'obs-gf',
      vodUrl: 'https://youtube.example/gf',
      games: [{ ordinal: 1 }, { ordinal: 2, canonicalStageId: 3, rawStage: 'FD' }, { ordinal: 3 }],
    });
    const attachment: ResearchEnrichmentAttachmentRecord = {
      observationId: 'obs-gf',
      targetSetId,
      attachmentSource: 'admin',
      attachedAtMs: 1,
      sourceRevisionId: 500,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      confirmedByUid: 'admin-1',
      confirmedAtMs: 1,
    };
    const overlay = buildEnrichmentOverlay({
      targetSetId,
      attachments: [attachment],
      observations: { 'obs-gf': observation },
    });
    expect(Object.keys(overlay.enrichedVodUrlByKey).sort()).toEqual([
      deriveEnrichmentMatchRowKey(targetSetId, 1),
      deriveEnrichmentMatchRowKey(targetSetId, 2),
      deriveEnrichmentMatchRowKey(targetSetId, 3),
    ]);
    expect(overlay.enrichedVodUrlByKey[deriveEnrichmentMatchRowKey(targetSetId, 1)]).toBe(
      'https://youtube.example/gf',
    );
    expect(Object.keys(overlay.enrichedStageByKey)).toEqual([
      deriveEnrichmentMatchRowKey(targetSetId, 2),
    ]);
    expect(overlay.enrichedStageByKey[deriveEnrichmentMatchRowKey(targetSetId, 2)]).toMatchObject({
      canonicalStageId: 3,
      raw: 'FD',
    });
  });

  it('the grand final (3 rows) and its reset (5 rows) both receive the shared URL as two sets of distinct keys', () => {
    const gfSetId = 'startgg-set-gf2';
    const resetSetId = 'startgg-set-reset2';
    const gfObservation = makeObservation({
      observationId: 'obs-gf2',
      vodUrl: 'https://youtube.example/gfset',
      games: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
    });
    const resetObservation = makeObservation({
      observationId: 'obs-reset2',
      vodUrl: 'https://youtube.example/resetset',
      games: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }, { ordinal: 4 }, { ordinal: 5 }],
    });
    const gfOverlay = buildEnrichmentOverlay({
      targetSetId: gfSetId,
      attachments: [
        {
          observationId: 'obs-gf2',
          targetSetId: gfSetId,
          attachmentSource: 'admin',
          attachedAtMs: 1,
          sourceRevisionId: 500,
          sourceContentHash: 'a'.repeat(64),
          parserVersion: 'liquipedia-bracket-legacy@1',
          confirmedByUid: 'admin-1',
          confirmedAtMs: 1,
        },
      ],
      observations: { 'obs-gf2': gfObservation },
    });
    const resetOverlay = buildEnrichmentOverlay({
      targetSetId: resetSetId,
      attachments: [
        {
          observationId: 'obs-reset2',
          targetSetId: resetSetId,
          attachmentSource: 'admin',
          attachedAtMs: 1,
          sourceRevisionId: 500,
          sourceContentHash: 'a'.repeat(64),
          parserVersion: 'liquipedia-bracket-legacy@1',
          confirmedByUid: 'admin-1',
          confirmedAtMs: 1,
        },
      ],
      observations: { 'obs-reset2': resetObservation },
    });
    expect(Object.keys(gfOverlay.enrichedVodUrlByKey)).toHaveLength(3);
    expect(Object.keys(resetOverlay.enrichedVodUrlByKey)).toHaveLength(5);
    const gfKeys = new Set(Object.keys(gfOverlay.enrichedVodUrlByKey));
    const resetKeys = new Set(Object.keys(resetOverlay.enrichedVodUrlByKey));
    for (const key of gfKeys) {
      expect(resetKeys.has(key)).toBe(false);
    }
  });

  it('an unattached observation produces no candidate key at all', () => {
    const targetSetId = 'startgg-set-unattached';
    const observation = makeObservation({
      observationId: 'obs-x',
      vodUrl: 'https://x',
      games: [{ ordinal: 1 }],
    });
    const overlay = buildEnrichmentOverlay({
      targetSetId,
      attachments: [],
      observations: { 'obs-x': observation },
    });
    expect(overlay.enrichedVodUrlByKey).toEqual({});
    expect(overlay.enrichedStageByKey).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// applyEnrichmentProjection — core behaviors
// ---------------------------------------------------------------------------

describe('applyEnrichmentProjection', () => {
  it('fills an empty VOD and an unknown stage on an existing match row', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-fill';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});

    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: 'https://liquipedia/vod' },
      enrichedStageByKey: {
        [key]: {
          canonicalStageId: 3,
          observationId: 'obs-1',
          sourceRevisionId: 500,
          parserVersion: 'p@1',
        },
      },
    };
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.counts.vodFilledEmpty).toBe(1);
    expect(outcome.counts.stageEnriched).toBe(1);
    const row = (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<
      string,
      unknown
    >;
    const stored = row[key] as MatchRecord;
    expect(stored.vodUrl).toBe('https://liquipedia/vod');
    expect(stored.map).toEqual({ id: 3, name: 'Final Destination' });
  });

  it('when no match row exists for the target set, nothing is written and the row is counted as attached-with-no-projectable-rows', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-missing';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: 'https://liquipedia/vod' },
      enrichedStageByKey: {},
    };
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );
    expect(outcome.counts.attachedNoProjectableRows).toBe(1);
    expect(outcome.rows).toHaveLength(0);
    expect(database.dump()).toEqual({});
  });

  it('a game with more declared ordinals than actual match rows leaves the surplus unapplied and counted', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-surplus';
    const key1 = deriveEnrichmentMatchRowKey(targetSetId, 1);
    const key2 = deriveEnrichmentMatchRowKey(targetSetId, 2);
    seedMatch(database, key1, {});
    // key2 deliberately not seeded — a "surplus" row Liquipedia declares but start.gg never produced.
    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key1]: 'https://liquipedia/vod', [key2]: 'https://liquipedia/vod' },
      enrichedStageByKey: {},
    };
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );
    expect(outcome.counts.vodFilledEmpty).toBe(1);
    expect(outcome.counts.attachedNoProjectableRows).toBe(1);
  });

  it('an identical replay produces no value-changing write and the second pass reports every row unchanged', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-replay';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: 'https://liquipedia/vod' },
      enrichedStageByKey: {},
    };
    await applyEnrichmentProjection(asDatabase(database), TENANT_ID, targetSetId, overlay, 1000);
    const dumpAfterFirst = JSON.stringify(database.dump());

    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      2000,
    );
    expect(outcome.rows.every((row) => row.vodOutcome === 'unchanged')).toBe(true);
    expect(JSON.stringify(database.dump())).toBe(dumpAfterFirst);
  });

  it('the witness pending half is ABSENT (not null) after a clean run', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-absent-pending';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: 'https://liquipedia/vod' },
      enrichedStageByKey: {},
    };
    await applyEnrichmentProjection(asDatabase(database), TENANT_ID, targetSetId, overlay, 1000);
    const witness = (
      (database.dump().researchEnrichmentProjection as Record<string, unknown>)[
        TENANT_ID
      ] as Record<string, unknown>
    )[key] as Record<string, unknown>;
    expect(witness.projectedVodUrl).toBe('https://liquipedia/vod');
    expect(Object.prototype.hasOwnProperty.call(witness, 'pendingVodUrl')).toBe(false);
  });

  it('an unsafe tenant id or target set id writes nothing and does not throw', async () => {
    const database = new FakeDatabase();
    const key = deriveEnrichmentMatchRowKey('set-1', 1);
    seedMatch(database, key, {});
    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: 'https://liquipedia/vod' },
      enrichedStageByKey: {},
    };
    await expect(
      applyEnrichmentProjection(asDatabase(database), 'unsafe/tenant', 'set-1', overlay, 1000),
    ).resolves.toMatchObject({ counts: { vodFilledEmpty: 0 } });
    await expect(
      applyEnrichmentProjection(asDatabase(database), TENANT_ID, 'unsafe/set', overlay, 1000),
    ).resolves.toMatchObject({ counts: { vodFilledEmpty: 0 } });
    expect((database.dump().matches as Record<string, unknown>)[TENANT_ID]).toBeDefined();
  });

  it('a source that stops supplying a value removes a previously source-owned VOD, discovered via the witness even though the fresh overlay has no entry for the row', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-removed';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, { vodUrl: 'https://liquipedia/old' });
    database.seed(`researchEnrichmentProjection/${TENANT_ID}/${key}`, {
      matchKey: key,
      targetSetId,
      projectedVodUrl: 'https://liquipedia/old',
    });

    const overlay: EnrichmentOverlay = { enrichedVodUrlByKey: {}, enrichedStageByKey: {} };
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      2000,
    );

    expect(outcome.rows).toEqual([
      { matchKey: key, vodOutcome: 'source-removed', stageOutcome: 'unknown' },
    ]);
    const row = (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<
      string,
      unknown
    >;
    expect((row[key] as MatchRecord).vodUrl).toBeUndefined();
    const witness = (
      (database.dump().researchEnrichmentProjection as Record<string, unknown>)[
        TENANT_ID
      ] as Record<string, unknown>
    )[key] as Record<string, unknown>;
    expect(witness.projectedVodUrl).toBeUndefined();
    expect(witness.vodOwnershipReleasedAtMs).toBe(2000);
  });

  it('applying an enrichment for a target set with no attachment writes nothing, even when an observation exists for it', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-no-attach';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    await writeEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      makeObservation({
        observationId: 'obs-orphan',
        vodUrl: 'https://liquipedia/vod',
        games: [{ ordinal: 1 }],
      }),
    );
    // No attachment created — buildEnrichmentOverlay never sees this observation.
    const overlay = buildEnrichmentOverlay({ targetSetId, attachments: [], observations: {} });
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );
    expect(outcome.counts.vodFilledEmpty).toBe(0);
    const row = (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<
      string,
      unknown
    >;
    expect((row[key] as MatchRecord).vodUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fault injection — the crash-safe three-phase protocol
// ---------------------------------------------------------------------------

describe('applyEnrichmentProjection — fault injection', () => {
  const TARGET_SET_ID = 'startgg-set-crash';
  const KEY_A = deriveEnrichmentMatchRowKey(TARGET_SET_ID, 1); // gets the enrichment fill/correction
  const KEY_B = deriveEnrichmentMatchRowKey(TARGET_SET_ID, 2); // holds a user-typed value throughout

  const USER_URL = 'https://user-typed.example/clip';
  const NOW_MS = 5000;

  // KEY_B also carries a decoy overlay entry — its OWN enrichment target is
  // never applicable (the row already holds a genuine user-typed value that
  // matches no witness), but including it means BOTH rows go through their
  // own `.transaction()` this run, which is what makes "between two row
  // transactions of the same set" a meaningful crash point.
  function fillEmptyOverlay(): EnrichmentOverlay {
    return {
      enrichedVodUrlByKey: {
        [KEY_A]: 'https://liquipedia/vod',
        [KEY_B]: 'https://liquipedia/decoy-for-b',
      },
      enrichedStageByKey: {},
    };
  }

  function correctionOverlay(newUrl: string): EnrichmentOverlay {
    return {
      enrichedVodUrlByKey: { [KEY_A]: newUrl, [KEY_B]: 'https://liquipedia/decoy-for-b' },
      enrichedStageByKey: {},
    };
  }

  function seedScenario(database: FakeDatabase, existingKeyAVodUrl?: string): void {
    seedMatch(database, KEY_A, existingKeyAVodUrl ? { vodUrl: existingKeyAVodUrl } : {});
    seedMatch(database, KEY_B, { vodUrl: USER_URL });
  }

  async function runCrashFree(overlay: EnrichmentOverlay): Promise<Record<string, unknown>> {
    const database = new FakeDatabase();
    seedScenario(database);
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      TARGET_SET_ID,
      overlay,
      NOW_MS,
    );
    return database.dump() as Record<string, unknown>;
  }

  const CRASH_POINTS = [
    { label: 'after pre-write, before any row transaction', writeNumber: 2 },
    { label: 'between two row transactions of the same set', writeNumber: 3 },
    { label: 'after the last row transaction, before the commit', writeNumber: 4 },
  ];

  describe.each(CRASH_POINTS)('crash $label', ({ writeNumber }) => {
    it('fill-empty case: retry converges on the crash-free final state, the user-typed row is untouched, and the value stays correctable/removable', async () => {
      const overlay = fillEmptyOverlay();

      const database = new FakeDatabase();
      seedScenario(database);
      const faultDb = new FaultInjectingDatabase(database, writeNumber);

      await expect(
        applyEnrichmentProjection(asDatabase(faultDb), TENANT_ID, TARGET_SET_ID, overlay, NOW_MS),
      ).rejects.toBeInstanceOf(FaultInjectedError);

      // Retry over the SAME underlying store, no further injected faults.
      const retryOutcome = await applyEnrichmentProjection(
        asDatabase(database),
        TENANT_ID,
        TARGET_SET_ID,
        overlay,
        NOW_MS,
      );

      const crashFreeDump = await runCrashFree(overlay);
      expect(database.dump()).toEqual(crashFreeDump);

      // The user-typed row was never classified user-owned incorrectly, nor touched.
      const keyBOutcome = retryOutcome.rows.find((row) => row.matchKey === KEY_B);
      const rowB = (
        (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
      )[KEY_B] as MatchRecord;
      expect(rowB.vodUrl).toBe(USER_URL);
      if (keyBOutcome) {
        expect(keyBOutcome.vodOutcome).toBe('skipped-user-owned');
      }

      // The projected value on row A is still correctable by a subsequent run.
      const correctionOutcome = await applyEnrichmentProjection(
        asDatabase(database),
        TENANT_ID,
        TARGET_SET_ID,
        correctionOverlay('https://liquipedia/corrected'),
        NOW_MS + 1,
      );
      const correctedRowA = (
        (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
      )[KEY_A] as MatchRecord;
      expect(correctedRowA.vodUrl).toBe('https://liquipedia/corrected');
      expect(correctionOutcome.rows.find((row) => row.matchKey === KEY_A)?.vodOutcome).toBe(
        'source-corrected',
      );

      // And removable by a subsequent run with an absent source value — the
      // key has no overlay entry at all, but the witness (from the
      // correction just above) still attributes it to this target set, so
      // it is discovered and removed.
      const removalOutcome = await applyEnrichmentProjection(
        asDatabase(database),
        TENANT_ID,
        TARGET_SET_ID,
        { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
        NOW_MS + 2,
      );
      expect(removalOutcome.rows.find((row) => row.matchKey === KEY_A)?.vodOutcome).toBe(
        'source-removed',
      );
      const removedRowA = (
        (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
      )[KEY_A] as MatchRecord;
      expect(removedRowA.vodUrl).toBeUndefined();
    });

    it('correction case: a previously source-owned value is corrected across the crash, the user-typed row is untouched, and vodSkippedUserOwned counts it exactly once', async () => {
      const database = new FakeDatabase();
      seedScenario(database, 'https://liquipedia/old');
      // Seed a committed witness for KEY_A matching the existing row value.
      database.seed(`researchEnrichmentProjection/${TENANT_ID}/${KEY_A}`, {
        matchKey: KEY_A,
        targetSetId: TARGET_SET_ID,
        projectedVodUrl: 'https://liquipedia/old',
      });

      const overlay = correctionOverlay('https://liquipedia/new');
      const faultDb = new FaultInjectingDatabase(database, writeNumber);

      await expect(
        applyEnrichmentProjection(asDatabase(faultDb), TENANT_ID, TARGET_SET_ID, overlay, NOW_MS),
      ).rejects.toBeInstanceOf(FaultInjectedError);

      const retryOutcome = await applyEnrichmentProjection(
        asDatabase(database),
        TENANT_ID,
        TARGET_SET_ID,
        overlay,
        NOW_MS,
      );

      const rowA = (
        (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
      )[KEY_A] as MatchRecord;
      expect(rowA.vodUrl).toBe('https://liquipedia/new');

      const rowB = (
        (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
      )[KEY_B] as MatchRecord;
      expect(rowB.vodUrl).toBe(USER_URL);

      const userOwnedCount = retryOutcome.rows.filter(
        (row) => row.matchKey === KEY_B && row.vodOutcome === 'skipped-user-owned',
      ).length;
      expect(userOwnedCount).toBe(1);

      // Still correctable/removable after the crash+retry.
      const removalOutcome = await applyEnrichmentProjection(
        asDatabase(database),
        TENANT_ID,
        TARGET_SET_ID,
        { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
        NOW_MS + 1,
      );
      expect(removalOutcome.rows.find((row) => row.matchKey === KEY_A)?.vodOutcome).toBe(
        'source-removed',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Overlay readers
// ---------------------------------------------------------------------------

describe('readEnrichmentOverlayForSet / readEnrichmentOverlayForTenant', () => {
  it('readEnrichmentOverlayForTenant returns null when the tenant has no enrichment tree at all', async () => {
    const database = new FakeDatabase();
    const result = await readEnrichmentOverlayForTenant(asDatabase(database), TENANT_ID);
    expect(result).toBeNull();
  });

  it('readEnrichmentOverlayForSet returns an empty object (not null) when this specific set has no attachments', async () => {
    const database = new FakeDatabase();
    const result = await readEnrichmentOverlayForSet(
      asDatabase(database),
      TENANT_ID,
      'startgg-set-empty',
    );
    expect(result).toEqual({});
  });

  it('composes attachments + observations + witness into the row overlay shape, and readEnrichmentOverlayForTenant sees the same data keyed globally', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-reader';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    await seedAdminAttachedObservation(
      database,
      targetSetId,
      makeObservation({
        observationId: 'obs-reader',
        vodUrl: 'https://liquipedia/vod',
        games: [{ ordinal: 1, canonicalStageId: 3, rawStage: 'FD' }],
      }),
      1000,
    );

    const perSet = await readEnrichmentOverlayForSet(asDatabase(database), TENANT_ID, targetSetId);
    expect(perSet?.[key]?.enrichmentVodUrl).toBe('https://liquipedia/vod');
    expect(perSet?.[key]?.enrichmentStage?.canonicalStageId).toBe(3);

    const perTenant = await readEnrichmentOverlayForTenant(asDatabase(database), TENANT_ID);
    expect(perTenant?.get(key)?.enrichmentVodUrl).toBe('https://liquipedia/vod');
  });
});
