import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import {
  isSourceOwnedVodValue,
  type EnrichmentOwnershipWitness,
  type MatchRecord,
  type ResearchEnrichmentAttachmentRecord,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { ConcurrentEditDatabase } from '../../test-support/concurrentEditDatabase.js';
import {
  FaultInjectingDatabase,
  FaultInjectedError,
} from '../../test-support/faultInjectingDatabase.js';
import { writeEnrichmentObservation, confirmEnrichmentObservationByAdmin } from './store.js';
import { confirmVodCandidateByAdmin, writeVodCandidate } from './vodDiscovery.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
  deriveEnrichmentMatchRowKey,
  previewEnrichmentProjection,
  readEnrichmentOverlayForSet,
  readEnrichmentOverlayForTenant,
  type EnrichmentOverlay,
} from './projection.js';

const TENANT_ID = 'tenant-1';

function asDatabase(
  database: FakeDatabase | FaultInjectingDatabase | ConcurrentEditDatabase,
): Database {
  return database as unknown as Database;
}

function readRow(database: FakeDatabase, key: string): MatchRecord {
  return (
    (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
  )[key] as MatchRecord;
}

function readWitnessRecord(
  database: FakeDatabase,
  key: string,
): (EnrichmentOwnershipWitness & Record<string, unknown>) | undefined {
  const tree = database.dump().researchEnrichmentProjection as Record<string, unknown> | undefined;
  if (tree === undefined) {
    return undefined;
  }
  return (tree[TENANT_ID] as Record<string, unknown>)[key] as
    (EnrichmentOwnershipWitness & Record<string, unknown>) | undefined;
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

  it('requires the attachment fingerprint to match before it authorizes any VOD, stage, character, or stock evidence', () => {
    const targetSetId = 'startgg-set-fingerprint';
    const observation = makeObservation({
      vodUrl: 'https://www.youtube.com/watch?v=fingerprint',
      players: [{ rawTag: 'Subject' }, { rawTag: 'Opponent' }],
      games: [
        {
          ordinal: 1,
          canonicalStageId: 3,
          rawStage: 'FD',
          rawChars: ['cloud', 'diddy'],
          stocks: [2, 0],
          winnerSeat: 1,
        },
      ],
    });
    const matching: ResearchEnrichmentAttachmentRecord = {
      observationId: observation.observationId,
      targetSetId,
      attachmentSource: 'admin',
      attachedAtMs: 1,
      sourceRevisionId: observation.sourceRevisionId,
      sourceContentHash: observation.sourceContentHash,
      parserVersion: observation.parserVersion,
      confirmedByUid: 'admin-1',
      confirmedAtMs: 1,
    };

    const positive = buildEnrichmentOverlay({
      targetSetId,
      attachments: [matching],
      observations: { [observation.observationId]: observation },
    });
    expect(Object.keys(positive.enrichedVodUrlByKey)).toHaveLength(1);
    expect(Object.keys(positive.enrichedStageByKey)).toHaveLength(1);
    expect(Object.keys(positive.enrichedGameEvidenceByKey ?? {})).toHaveLength(1);

    for (const stale of [
      { ...matching, sourceRevisionId: matching.sourceRevisionId + 1 },
      { ...matching, sourceContentHash: 'b'.repeat(64) },
      { ...matching, parserVersion: `${matching.parserVersion}-stale` },
    ]) {
      const rejected = buildEnrichmentOverlay({
        targetSetId,
        attachments: [stale],
        observations: { [observation.observationId]: observation },
      });
      expect(rejected.enrichedVodUrlByKey).toEqual({});
      expect(rejected.enrichedVodSourceByKey).toEqual({});
      expect(rejected.enrichedStageByKey).toEqual({});
      expect(rejected.enrichedGameEvidenceByKey).toEqual({});
    }
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

  // 30.3 verifier closure 3: when a bracket observation and a vod-list row
  // both supply the same key's URL, the URL was always safe (corroborated
  // identical) but the last-iterated attachment named the source page —
  // truncated-hash order, so `enrichedVodSourceByKey` could point at the
  // vod-list page. Bracket provenance must win DETERMINISTICALLY.
  it('bracket-sourced VOD provenance outranks a vod-list row for the same key, in either attachment order', () => {
    const targetSetId = 'startgg-set-rank';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    const url = 'https://www.youtube.com/watch?v=ranked';
    const bracketObservation = makeObservation({
      observationId: 'zz-bracket-obs',
      contentType: 'stage-observation',
      sourcePageTitle: 'TestCup/2026/Bracket',
      vodUrl: url,
      games: [{ ordinal: 1 }],
    });
    const vodListObservation = makeObservation({
      observationId: 'aa-vodlist-obs',
      contentType: 'vod-reference',
      sourcePageTitle: 'TestPlayer/VODs',
      vodUrl: url,
    });
    const makeAttachment = (
      observation: ResearchEnrichmentObservationRecord,
    ): ResearchEnrichmentAttachmentRecord => ({
      observationId: observation.observationId,
      targetSetId,
      attachmentSource: 'admin',
      attachedAtMs: 1,
      sourceRevisionId: observation.sourceRevisionId,
      sourceContentHash: observation.sourceContentHash,
      parserVersion: observation.parserVersion,
      confirmedByUid: 'admin-1',
      confirmedAtMs: 1,
    });
    const observations = {
      'zz-bracket-obs': bracketObservation,
      'aa-vodlist-obs': vodListObservation,
    };

    for (const attachments of [
      [makeAttachment(bracketObservation), makeAttachment(vodListObservation)],
      [makeAttachment(vodListObservation), makeAttachment(bracketObservation)],
    ]) {
      const overlay = buildEnrichmentOverlay({ targetSetId, attachments, observations });
      expect(overlay.enrichedVodUrlByKey[key]).toBe(url);
      // The bracket page is the named source in BOTH iteration orders —
      // never the discovery-index page, even though its id sorts first and
      // it can iterate last.
      expect(overlay.enrichedVodSourceByKey?.[key]?.observationId).toBe('zz-bracket-obs');
    }
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

  it("records each VOD entry's OWN provenance, taken from the observation that carried the URL", () => {
    const targetSetId = 'startgg-set-vod-provenance';
    const observation = makeObservation({
      observationId: 'obs-vod-provenance',
      sourceRevisionId: 777,
      parserVersion: 'liquipedia-vodlist@2',
      vodUrl: 'https://youtube.example/set',
      games: [{ ordinal: 1 }, { ordinal: 2 }],
    });
    const overlay = buildEnrichmentOverlay({
      targetSetId,
      attachments: [
        {
          observationId: 'obs-vod-provenance',
          targetSetId,
          attachmentSource: 'admin',
          attachedAtMs: 1,
          sourceRevisionId: 777,
          sourceContentHash: 'a'.repeat(64),
          parserVersion: 'liquipedia-vodlist@2',
          confirmedByUid: 'admin-1',
          confirmedAtMs: 1,
        },
      ],
      observations: { 'obs-vod-provenance': observation },
    });
    expect(overlay.enrichedVodSourceByKey?.[deriveEnrichmentMatchRowKey(targetSetId, 2)]).toEqual({
      observationId: 'obs-vod-provenance',
      sourceRevisionId: 777,
      parserVersion: 'liquipedia-vodlist@2',
    });
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
// Idempotent re-apply over the applier's OWN prior projection (30.3 Gate 5,
// commit 1 — the latent stage-witness hazard). Before this fix,
// `resolveForRow` handed the STORED row stage to the shared resolver as
// `providerStage`; on a re-apply the stored stage IS the applier's own
// earlier projection, the resolver called it provider-authoritative, and the
// stage witness was CLEARED — silently converting an enrichment-owned stage
// into an uncorrectable, unattributable one.
// ---------------------------------------------------------------------------

describe('applyEnrichmentProjection — re-apply over its own prior projection', () => {
  const REAPPLY_VOD = 'https://liquipedia/vod';

  function stageAndVodOverlay(key: string): EnrichmentOverlay {
    return {
      enrichedVodUrlByKey: { [key]: REAPPLY_VOD },
      enrichedStageByKey: {
        [key]: {
          canonicalStageId: 3,
          raw: 'FD',
          observationId: 'obs-stage-1',
          sourceRevisionId: 500,
          parserVersion: 'p@1',
        },
      },
    };
  }

  it('REGRESSION: a second apply of the identical overlay preserves the stage witness and performs zero value-changing writes', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stage-reapply';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});

    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      stageAndVodOverlay(key),
      1000,
    );
    const witnessAfterFirst = readWitnessRecord(database, key);
    expect(witnessAfterFirst?.projectedStageId).toBe(3);
    expect(witnessAfterFirst?.projectedStageName).toBe('Final Destination');
    expect(witnessAfterFirst?.projectedStageRaw).toBe('FD');
    const dumpAfterFirst = JSON.stringify(database.dump());

    // Re-apply the SAME overlay with a LATER clock: any witness write at all
    // (including a clear, or a re-stamp of a timestamp member) changes the
    // dump and fails this assertion.
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      stageAndVodOverlay(key),
      2000,
    );
    expect(JSON.stringify(database.dump())).toBe(dumpAfterFirst);

    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedStageId).toBe(3);
    expect(witness?.projectedStageName).toBe('Final Destination');
    expect(witness?.projectedStageRaw).toBe('FD');
    expect(witness?.stageObservationId).toBe('obs-stage-1');

    // The replay row reports the settled outcomes run.ts's reconciliation
    // trigger expects for a healthy set — never a fresh 'enriched' (which
    // would make every rerun reproject every healthy set forever).
    expect(outcome.rows).toEqual([
      { matchKey: key, vodOutcome: 'unchanged', stageOutcome: 'provider-authoritative' },
    ]);
    expect(outcome.counts.stageEnriched).toBe(0);
  });

  it('preview over an already-applied set reports the stage settled (provider-authoritative), so the run-level reconciliation trigger still skips healthy sets', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stage-preview';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    const overlay = stageAndVodOverlay(key);
    await applyEnrichmentProjection(asDatabase(database), TENANT_ID, targetSetId, overlay, 1000);

    const preview = await previewEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
    );
    // Both halves of the merged dual fix, asserted together: the label says
    // settled (never a fresh 'enriched'), and the value-derived trigger
    // signal says no write would happen — so run.ts's reconciliation pass
    // skips the healthy set whichever signal it consults. The witness-delta
    // half (30.3 verifier B2) must ALSO read quiet on a converged set, or
    // reconciliation would reproject every healthy set every run.
    expect(preview.rows).toEqual([
      {
        matchKey: key,
        vodOutcome: 'unchanged',
        stageOutcome: 'provider-authoritative',
        wouldChangeRow: false,
        wouldChangeWitness: false,
      },
    ]);
    expect(preview.counts.stageEnriched).toBe(0);
  });

  it('preview reports wouldChangeRow=true for a genuinely stranded fill — the other direction of the merged trigger', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stranded-preview';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    const preview = await previewEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      stageAndVodOverlay(key),
    );
    expect(preview.rows[0]?.wouldChangeRow).toBe(true);
  });

  it('a source-corrected stage on a witness-owned row is REWRITTEN (the witness is what makes its own projection correctable)', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stage-correct';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      stageAndVodOverlay(key),
      1000,
    );

    const corrected: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: REAPPLY_VOD },
      enrichedStageByKey: {
        [key]: {
          canonicalStageId: 1,
          raw: 'BF',
          observationId: 'obs-stage-2',
          sourceRevisionId: 600,
          parserVersion: 'p@1',
        },
      },
    };
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      corrected,
      2000,
    );
    expect(outcome.rows[0]?.stageOutcome).toBe('enriched');
    expect(readRow(database, key).map).toEqual({ id: 1, name: 'Battlefield' });
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedStageId).toBe(1);
    expect(witness?.projectedStageRaw).toBe('BF');
    expect(witness?.stageObservationId).toBe('obs-stage-2');
  });

  it('a source that stops supplying a stage REMOVES a witness-owned stage (reverts to unknown) and clears the stage witness, while the VOD half is untouched', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stage-remove';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      stageAndVodOverlay(key),
      1000,
    );

    const withoutStage: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: REAPPLY_VOD },
      enrichedStageByKey: {},
    };
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      withoutStage,
      2000,
    );
    expect(readRow(database, key).map).toEqual({ id: 0, name: 'unknown' });
    expect(readRow(database, key).vodUrl).toBe(REAPPLY_VOD);
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedStageId).toBeUndefined();
    expect(witness?.projectedStageName).toBeUndefined();
    expect(witness?.projectedStageRaw).toBeUndefined();
    expect(witness?.projectedVodUrl).toBe(REAPPLY_VOD);
  });

  it('a stage-only witness key with NO overlay entry at all is still discovered (widened candidate set) and its removal converges', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stage-only-detach';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, { map: { id: 3, name: 'Final Destination' } });
    database.seed(`researchEnrichmentProjection/${TENANT_ID}/${key}`, {
      matchKey: key,
      targetSetId,
      projectedStageId: 3,
      projectedStageName: 'Final Destination',
      projectedStageRaw: 'FD',
    });

    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
      2000,
    );
    expect(outcome.rows).toHaveLength(1);
    expect(readRow(database, key).map).toEqual({ id: 0, name: 'unknown' });
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedStageId).toBeUndefined();
    expect(witness?.projectedStageRaw).toBeUndefined();
  });

  it('a GENUINE provider-resolved stage that the witness does not vouch for still wins and still clears the stale witness', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stage-provider-wins';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    // The row's stage does NOT match the witness claim — a provider refresh
    // resolved a different stage after our projection.
    seedMatch(database, key, { map: { id: 1, name: 'Battlefield' } });
    database.seed(`researchEnrichmentProjection/${TENANT_ID}/${key}`, {
      matchKey: key,
      targetSetId,
      projectedStageId: 3,
      projectedStageName: 'Final Destination',
      projectedVodUrl: REAPPLY_VOD,
    });
    seedMatch(database, key, { map: { id: 1, name: 'Battlefield' }, vodUrl: REAPPLY_VOD });

    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      stageAndVodOverlay(key),
      2000,
    );
    expect(outcome.rows[0]?.stageOutcome).toBe('provider-authoritative');
    expect(readRow(database, key).map).toEqual({ id: 1, name: 'Battlefield' });
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedStageId).toBeUndefined();
    expect(witness?.projectedStageName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Write-time ownership resolution (30.2 gap-closure BLOCKER 1)
//
// Every test here injects a FOREIGN write (a user editing their own match
// row) that lands AFTER the planning reads and AFTER phase A's witness
// pre-write, but BEFORE that row's phase B transaction. A plan-time-only
// resolver overwrites the user's value in every one of them; a write-time
// resolver preserves it.
// ---------------------------------------------------------------------------

describe('applyEnrichmentProjection — write-time ownership resolution', () => {
  const USER_URL = 'https://user-typed.example/their-own-clip';
  const LIQUIPEDIA_URL = 'https://liquipedia/vod';

  it('a user VOD edit landing between the witness pre-write and the row transaction is PRESERVED, and no witness vouches for it', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-interleave-vod';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    // Empty at PLAN time — the plan therefore decides "fill-empty".
    seedMatch(database, key, {});

    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: LIQUIPEDIA_URL },
      enrichedStageByKey: {},
    };
    const interleaved = new ConcurrentEditDatabase(database, {
      path: `matches/${TENANT_ID}/${key}`,
      edit: () => seedMatch(database, key, { vodUrl: USER_URL }),
    });

    const outcome = await applyEnrichmentProjection(
      asDatabase(interleaved),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(interleaved.editApplied).toBe(true);
    // ENR-08/D-21: a user-entered URL may NEVER be overwritten.
    expect(readRow(database, key).vodUrl).toBe(USER_URL);
    expect(outcome.rows).toEqual([
      { matchKey: key, vodOutcome: 'skipped-user-owned', stageOutcome: 'unknown' },
    ]);
    expect(outcome.counts.vodFilledEmpty).toBe(0);
    expect(outcome.counts.vodSkippedUserOwned).toBe(1);

    // The pending witness written in phase A was VOIDED, not promoted.
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedVodUrl).toBeUndefined();
    expect(witness?.pendingVodUrl).toBeUndefined();
    expect(isSourceOwnedVodValue(USER_URL, witness ?? null)).toBe(false);
  });

  it('a user stage edit landing in the same window wins over the enrichment stage that the plan had chosen for the unknown sentinel', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-interleave-stage';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    // No `map` member at all — the provider slot is the unknown sentinel, so
    // the plan decides "enriched" with the Liquipedia stage.
    seedMatch(database, key, {});

    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: {},
      enrichedStageByKey: {
        [key]: {
          canonicalStageId: 3,
          raw: 'FD',
          observationId: 'obs-stage',
          sourceRevisionId: 500,
          parserVersion: 'p@1',
        },
      },
    };
    const userStage = { id: 1, name: 'Battlefield' };
    const interleaved = new ConcurrentEditDatabase(database, {
      path: `matches/${TENANT_ID}/${key}`,
      edit: () => seedMatch(database, key, { map: userStage }),
    });

    const outcome = await applyEnrichmentProjection(
      asDatabase(interleaved),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(interleaved.editApplied).toBe(true);
    expect(readRow(database, key).map).toEqual(userStage);
    expect(outcome.rows[0]?.stageOutcome).toBe('provider-authoritative');
    expect(outcome.counts.stageEnriched).toBe(0);

    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedStageId).toBeUndefined();
    expect(witness?.projectedStageRaw).toBeUndefined();
    expect(witness?.pendingStageId).toBeUndefined();
    expect(witness?.pendingStageRaw).toBeUndefined();
  });

  it('when the plan-time and write-time resolutions differ, the COMMITTED snapshot decides the outcome, the counters and the witness', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-committed-wins';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    const sourceOldUrl = 'https://liquipedia/old';
    const sourceNewUrl = 'https://liquipedia/new';

    // At PLAN time the row holds a SOURCE-owned value the witness vouches
    // for, and the overlay supplies a different one — the plan therefore
    // decides "source-corrected" and pre-writes a pending witness for the
    // new URL. The user then replaces the value before the transaction runs.
    seedMatch(database, key, { vodUrl: sourceOldUrl });
    database.seed(`researchEnrichmentProjection/${TENANT_ID}/${key}`, {
      matchKey: key,
      targetSetId,
      projectedVodUrl: sourceOldUrl,
    });

    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: sourceNewUrl },
      enrichedStageByKey: {},
    };
    const interleaved = new ConcurrentEditDatabase(database, {
      path: `matches/${TENANT_ID}/${key}`,
      edit: () => seedMatch(database, key, { vodUrl: USER_URL }),
    });

    const outcome = await applyEnrichmentProjection(
      asDatabase(interleaved),
      TENANT_ID,
      targetSetId,
      overlay,
      2000,
    );

    expect(readRow(database, key).vodUrl).toBe(USER_URL);
    // The PLAN said 'source-corrected'; only the committed write counts.
    expect(outcome.rows[0]?.vodOutcome).toBe('skipped-user-owned');
    expect(outcome.counts.vodSkippedUserOwned).toBe(1);

    const witness = readWitnessRecord(database, key);
    // The pending half for the never-written correction is cleared.
    expect(witness?.pendingVodUrl).toBeUndefined();
    // The committed half is untouched — it still names the OLD source value,
    // which is no longer on the row and therefore vouches for nothing. That
    // is the whole point of `isSourceOwnedVodValue`'s value comparison: a
    // residual witness can never launder a user value into a source-owned one.
    expect(witness?.projectedVodUrl).toBe(sourceOldUrl);
    expect(isSourceOwnedVodValue(USER_URL, witness ?? null)).toBe(false);
  });

  it('with no interleaving, the committed-snapshot selection reproduces the ordinary fill and stamps the VOD half of the witness from the VOD observation', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-committed-fill';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {});

    const overlay: EnrichmentOverlay = {
      enrichedVodUrlByKey: { [key]: LIQUIPEDIA_URL },
      enrichedVodSourceByKey: {
        [key]: { observationId: 'obs-vod', sourceRevisionId: 700, parserVersion: 'vod@1' },
      },
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
    expect(readRow(database, key).vodUrl).toBe(LIQUIPEDIA_URL);

    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedVodUrl).toBe(LIQUIPEDIA_URL);
    expect(witness?.vodObservationId).toBe('obs-vod');
    expect(witness?.vodSourceRevisionId).toBe(700);
    expect(witness?.vodParserVersion).toBe('vod@1');
    expect(isSourceOwnedVodValue(LIQUIPEDIA_URL, witness ?? null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 30.3 Gate 5 — character/stock evidence projection (end to end)
// ---------------------------------------------------------------------------

describe('applyEnrichmentProjection — character/stock evidence', () => {
  function evidenceObservation(
    overrides: Partial<ResearchEnrichmentObservationRecord> = {},
  ): ResearchEnrichmentObservationRecord {
    return makeObservation({
      observationId: 'obs-evidence',
      game: 'ultimate',
      players: [{ rawTag: 'Sparg0' }, { rawTag: 'MkLeo' }],
      games: [
        {
          ordinal: 1,
          rawChars: ['cloud', 'joker'],
          stocks: [2, 0],
          winnerSeat: 1,
        },
      ],
      ...overrides,
    });
  }

  async function buildOverlayFor(
    database: FakeDatabase,
    targetSetId: string,
    record: ResearchEnrichmentObservationRecord,
  ): Promise<EnrichmentOverlay> {
    await seedAdminAttachedObservation(database, targetSetId, record, 500);
    const attachments = (
      (database.dump().researchEnrichmentAttachments as Record<string, unknown>)[
        TENANT_ID
      ] as Record<string, Record<string, unknown>>
    )[targetSetId]!;
    return buildEnrichmentOverlay({
      targetSetId,
      attachments: Object.values(attachments) as ResearchEnrichmentAttachmentRecord[],
      observations: { [record.observationId]: record },
    });
  }

  it('projects oriented characters onto the witness and fills stocksLeft when the winner-seat evidence agrees, and the re-apply is a witness-preserving no-op', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-evidence';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    // The subject WON this game (win: true) and the opponent tag matches the
    // observation's seat-2 player -> subject is seat 1, winner seat 1 agrees.
    seedMatch(database, key, { opponent: 'mkleo', win: true } as Partial<MatchRecord>);

    const overlay = await buildOverlayFor(database, targetSetId, evidenceObservation());
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.rows[0]?.charsOutcome).toBe('enriched');
    expect(outcome.rows[0]?.stocksOutcome).toBe('filled-empty');
    expect(outcome.evidenceCounts.charactersEnriched).toBe(1);
    expect(outcome.evidenceCounts.stocksFilledEmpty).toBe(1);

    expect(readRow(database, key).stocksLeft).toBe(2);
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedSubjectSeat).toBe(1);
    expect(witness?.projectedSubjectCharRaw).toBe('cloud');
    expect(witness?.projectedSubjectFighterId).toBe(65);
    expect(witness?.projectedOpponentCharRaw).toBe('joker');
    expect(witness?.projectedOpponentFighterId).toBe(76);
    expect(witness?.charsObservationId).toBe('obs-evidence');
    expect(witness?.projectedStocksLeft).toBe(2);
    expect(witness?.stocksObservationId).toBe('obs-evidence');
    expect(Object.prototype.hasOwnProperty.call(witness ?? {}, 'pendingStocksLeft')).toBe(false);

    // Idempotent re-apply: zero value-changing writes, later clock.
    const dumpAfterFirst = JSON.stringify(database.dump());
    await applyEnrichmentProjection(asDatabase(database), TENANT_ID, targetSetId, overlay, 2000);
    expect(JSON.stringify(database.dump())).toBe(dumpAfterFirst);
  });

  it('REFUSES Melee-scoped evidence end to end (the Hungrybox guard): no chars witness, no stocksLeft', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-melee';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, { opponent: 'mkleo', win: true } as Partial<MatchRecord>);

    const overlay = await buildOverlayFor(
      database,
      targetSetId,
      evidenceObservation({ observationId: 'obs-melee', game: 'melee' }),
    );
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.rows[0]?.charsOutcome).toBe('abstained-game-scope');
    expect(outcome.rows[0]?.stocksOutcome).toBe('abstained-game-scope');
    expect(outcome.evidenceCounts.charactersAbstained).toBe(1);
    expect(outcome.evidenceCounts.stocksAbstained).toBe(1);
    expect(readRow(database, key).stocksLeft).toBeUndefined();
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedSubjectSeat).toBeUndefined();
    expect(witness?.projectedStocksLeft).toBeUndefined();
  });

  it('abstains from characters and stocks when the seat orientation cannot be proven against the row opponent', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-unoriented';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    // The row's opponent matches NEITHER observed seat tag.
    seedMatch(database, key, { opponent: 'tweek', win: true } as Partial<MatchRecord>);

    const overlay = await buildOverlayFor(
      database,
      targetSetId,
      evidenceObservation({ observationId: 'obs-unoriented' }),
    );
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.rows[0]?.charsOutcome).toBe('abstained-orientation');
    expect(outcome.rows[0]?.stocksOutcome).toBe('abstained-orientation');
    expect(readRow(database, key).stocksLeft).toBeUndefined();
    expect(readWitnessRecord(database, key)?.projectedSubjectSeat).toBeUndefined();
  });

  it('never overwrites a provider-authored stocksLeft (weaker evidence loses)', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-stocks-owned';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, {
      opponent: 'mkleo',
      win: true,
      stocksLeft: 3,
    } as Partial<MatchRecord>);

    const overlay = await buildOverlayFor(
      database,
      targetSetId,
      evidenceObservation({ observationId: 'obs-owned' }),
    );
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.rows[0]?.stocksOutcome).toBe('skipped-owned');
    expect(outcome.evidenceCounts.stocksSkippedOwned).toBe(1);
    expect(readRow(database, key).stocksLeft).toBe(3);
    expect(readWitnessRecord(database, key)?.projectedStocksLeft).toBeUndefined();
  });

  it('refuses stocks when the source winner seat contradicts the row result, while characters still project', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-winner-conflict';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    // Row says the subject LOST; the observation says the subject's seat won.
    seedMatch(database, key, { opponent: 'mkleo', win: false } as Partial<MatchRecord>);

    const overlay = await buildOverlayFor(
      database,
      targetSetId,
      evidenceObservation({ observationId: 'obs-conflict' }),
    );
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.rows[0]?.charsOutcome).toBe('enriched');
    expect(outcome.rows[0]?.stocksOutcome).toBe('abstained-winner-disagreement');
    expect(readRow(database, key).stocksLeft).toBeUndefined();
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedSubjectFighterId).toBe(65);
    expect(witness?.projectedStocksLeft).toBeUndefined();
  });

  it('an unmapped raw character stays raw and flagged on the witness', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-unmapped-char';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedMatch(database, key, { opponent: 'mkleo', win: true } as Partial<MatchRecord>);

    const overlay = await buildOverlayFor(
      database,
      targetSetId,
      evidenceObservation({
        observationId: 'obs-unmapped',
        games: [
          { ordinal: 1, rawChars: ['someunreviewedname', 'joker'], stocks: [2, 0], winnerSeat: 1 },
        ],
      }),
    );
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      overlay,
      1000,
    );

    expect(outcome.rows[0]?.charsOutcome).toBe('partial-unmapped');
    expect(outcome.evidenceCounts.charactersUnmapped).toBe(1);
    const witness = readWitnessRecord(database, key);
    expect(witness?.projectedSubjectCharRaw).toBe('someunreviewedname');
    expect(witness?.projectedSubjectFighterId).toBeUndefined();
    expect(witness?.projectedOpponentFighterId).toBe(76);
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

  // 30.3 verifier B3: the ingestion-side overlay readers must see a set's
  // admin-CONFIRMED YouTube candidate exactly as the applier and preview do.
  // Without the widening, a stage-only-attached set with a
  // candidate-projected VOD hands the ingestion re-projection a witness-
  // owned URL with NO enrichment URL — and the shared resolver's
  // source-removed branch strips the confirmed candidate's URL.
  it('readEnrichmentOverlayForTenant widens with the confirmed candidate so ingestion re-projection preserves a candidate-projected VOD on a stage-only-attached set', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'startgg-set-cand-b3';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    const candidateUrl = 'https://www.youtube.com/watch?v=cand-b3';

    // Stage-ONLY observation (no vodUrl anywhere in the enrichment overlay).
    await seedAdminAttachedObservation(
      database,
      targetSetId,
      makeObservation({
        observationId: 'obs-stage-only-b3',
        games: [{ ordinal: 1, canonicalStageId: 3, rawStage: 'FD' }],
      }),
      1000,
    );
    // The candidate-projected production state: row exists and carries the
    // candidate's URL, the witness owns it.
    await database.ref(`matches/${TENANT_ID}/${key}`).set({ vodUrl: candidateUrl });
    await database.ref(`researchEnrichmentProjection/${TENANT_ID}/${key}`).set({
      matchKey: key,
      targetSetId,
      projectedVodUrl: candidateUrl,
      vodProjectedAtMs: 1000,
    });
    await writeVodCandidate(asDatabase(database), TENANT_ID, {
      candidateId: 'yt-cand-b3',
      targetSetId,
      provider: 'youtube-data-api',
      query: 'test query',
      videoId: 'cand-b3',
      videoUrl: candidateUrl,
      title: 'Test Set VOD',
      fetchedAtMs: 900,
      score: 4,
      status: 'proposed',
    });
    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      'yt-cand-b3',
      'admin-1',
      1000,
    );

    const perTenant = await readEnrichmentOverlayForTenant(asDatabase(database), TENANT_ID);
    const rowOverlay = perTenant?.get(key);
    expect(rowOverlay).toBeDefined();
    // The widened overlay carries the candidate URL, so the resolver sees a
    // matching enrichment URL ('unchanged'), never the source-removed branch.
    expect(rowOverlay?.enrichmentVodUrl).toBe(candidateUrl);
    expect(rowOverlay?.enrichmentStage?.canonicalStageId).toBe(3);

    const perSet = await readEnrichmentOverlayForSet(asDatabase(database), TENANT_ID, targetSetId);
    expect(perSet?.[key]?.enrichmentVodUrl).toBe(candidateUrl);
  });
});
