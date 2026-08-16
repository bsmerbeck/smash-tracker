import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type { ResearchEnrichmentProjectionStateRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  classifyStageCohort,
  foldEnrichmentCohortCounts,
  foldEnrichmentCounters,
  publishEnrichmentCoverage,
  readEnrichmentCoverage,
  stageEnrichmentProgress,
  composeEnrichmentCoverageResponse,
  deriveEnrichmentFieldCoverage,
  readEnrichmentFieldCoverage,
} from './rollup.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-1';
const RUN_ID = 'run-1';

function witness(
  overrides: Partial<ResearchEnrichmentProjectionStateRecord> = {},
): ResearchEnrichmentProjectionStateRecord {
  return {
    matchKey: 'match-1',
    targetSetId: 'set-1',
    ...overrides,
  };
}

describe('foldEnrichmentCounters', () => {
  it('folding two counter deltas sums every member and treats an absent member as zero', () => {
    const result = foldEnrichmentCounters(undefined, { matched: 2 });
    expect(result.matched).toBe(2);
    expect(result.ambiguous).toBe(0);
  });

  it('adds present delta members onto an existing base and leaves absent members unchanged', () => {
    const result = foldEnrichmentCounters({ matched: 5, ambiguous: 1 }, { matched: 2 });
    expect(result.matched).toBe(7);
    expect(result.ambiguous).toBe(1);
  });

  it('every member of the enrichment counters schema is present with a zero value after normalizing an empty object', () => {
    const result = foldEnrichmentCounters(undefined, {});
    expect(Object.values(result).every((value) => value === 0)).toBe(true);
    expect(Object.keys(result)).toContain('unknownStageAfterEnrichment');
    expect(Object.keys(result)).toContain('adminConfirmed');
    expect(Object.keys(result)).toContain('vodEnriched');
  });
});

describe('foldEnrichmentCohortCounts', () => {
  it('folding two cohort-count deltas sums every member and treats an absent member as zero', () => {
    const result = foldEnrichmentCohortCounts(undefined, { startggOnly: 3 });
    expect(result).toEqual({ startggOnly: 3, liquipediaSupplemented: 0, missing: 0 });
  });

  it('adds present delta members onto an existing base and leaves absent members unchanged', () => {
    const result = foldEnrichmentCohortCounts(
      { startggOnly: 2, missing: 1 },
      { liquipediaSupplemented: 4 },
    );
    expect(result).toEqual({ startggOnly: 2, liquipediaSupplemented: 4, missing: 1 });
  });
});

describe('classifyStageCohort', () => {
  it('a resolved provider stage is the start.gg-only cohort even when a witness also exists', () => {
    expect(
      classifyStageCohort({
        providerStageId: 311,
        witness: witness({ projectedStageId: 5 }),
      }),
    ).toBe('startggOnly');
  });

  it('an unknown provider stage with a projected witness is the liquipediaSupplemented cohort', () => {
    expect(
      classifyStageCohort({
        providerStageId: 0,
        witness: witness({ projectedStageId: 5 }),
      }),
    ).toBe('liquipediaSupplemented');
  });

  it('an unknown provider stage still carrying the sentinel after enrichment is the missing cohort — no witness at all', () => {
    expect(classifyStageCohort({ providerStageId: 0, witness: null })).toBe('missing');
  });

  it('an unknown provider stage with a witness that never projected a stage is still the missing cohort', () => {
    expect(classifyStageCohort({ providerStageId: 0, witness: witness() })).toBe('missing');
  });

  it('the three cohort counts sum exactly to the number of classified rows', () => {
    const rows: {
      providerStageId: number;
      witness: ResearchEnrichmentProjectionStateRecord | null;
    }[] = [
      { providerStageId: 311, witness: null },
      { providerStageId: 311, witness: witness({ projectedStageId: 5 }) },
      { providerStageId: 0, witness: witness({ projectedStageId: 5 }) },
      { providerStageId: 0, witness: null },
      { providerStageId: 0, witness: witness() },
    ];
    let cohortCounts = foldEnrichmentCohortCounts(undefined, {});
    for (const row of rows) {
      const cohort = classifyStageCohort(row);
      cohortCounts = foldEnrichmentCohortCounts(cohortCounts, { [cohort]: 1 });
    }
    const total =
      cohortCounts.startggOnly + cohortCounts.liquipediaSupplemented + cohortCounts.missing;
    expect(total).toBe(rows.length);
    expect(cohortCounts).toEqual({ startggOnly: 2, liquipediaSupplemented: 1, missing: 2 });
  });
});

describe('stageEnrichmentProgress', () => {
  it("a run's counters accumulate through a transaction", async () => {
    const database = new FakeDatabase();
    await stageEnrichmentProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      countsDelta: { matched: 1 },
      cohortCountsDelta: { startggOnly: 1 },
      now: 1_000,
    });

    const snapshot = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(snapshot?.counts.matched).toBe(1);
    expect(snapshot?.cohortCounts.startggOnly).toBe(1);
  });

  it('two concurrent counter contributions both survive', async () => {
    const database = new FakeDatabase();
    await Promise.all([
      stageEnrichmentProgress(asDatabase(database), {
        tenantId: TENANT_ID,
        runId: RUN_ID,
        countsDelta: { matched: 1 },
        now: 1_000,
      }),
      stageEnrichmentProgress(asDatabase(database), {
        tenantId: TENANT_ID,
        runId: RUN_ID,
        countsDelta: { matched: 1 },
        now: 1_000,
      }),
    ]);

    const snapshot = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(snapshot?.counts.matched).toBe(2);
  });

  it('rejects an unsafe tenantId rather than writing', async () => {
    const database = new FakeDatabase();
    await expect(
      stageEnrichmentProgress(asDatabase(database), {
        tenantId: 'bad/tenant',
        runId: RUN_ID,
        countsDelta: { matched: 1 },
      }),
    ).rejects.toThrow();
  });
});

describe('publishEnrichmentCoverage', () => {
  it('builds every freshness entry sourcePageUrl from buildLiquipediaPageUrl at publish time, matching the Liquipedia article-path pattern', async () => {
    const database = new FakeDatabase();

    const result = await publishEnrichmentCoverage(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      now: 1_000,
      perSourcePage: {
        'Supernova/2026': {
          pageTitle: 'Supernova/2026',
          revisionId: 1,
          contentHash: 'a'.repeat(64),
          fetchedAtMs: 900,
          observationCount: 8,
        },
      },
    });

    expect(result.reason).toBe('published');
    expect(result.snapshot.perSourcePage?.['Supernova/2026']?.sourcePageUrl).toMatch(
      /^https:\/\/liquipedia\.net\/smash\//,
    );

    const reread = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(reread?.perSourcePage?.['Supernova/2026']?.sourcePageUrl).toBe(
      result.snapshot.perSourcePage?.['Supernova/2026']?.sourcePageUrl,
    );
  });

  it('publishing a freshness entry without a source page URL is impossible: the schema rejects it rather than publishing it', async () => {
    const database = new FakeDatabase();

    await expect(
      publishEnrichmentCoverage(asDatabase(database), {
        tenantId: TENANT_ID,
        runId: RUN_ID,
        now: 1_000,
        perSourcePage: {
          'Supernova/2026': {
            // pageTitle deliberately omitted — no sourcePageUrl can be derived.
            revisionId: 1,
            contentHash: 'a'.repeat(64),
            fetchedAtMs: 900,
            observationCount: 8,
          },
        },
      }),
    ).rejects.toThrow();

    expect(await readEnrichmentCoverage(asDatabase(database), TENANT_ID)).toBeNull();
  });

  it('preserves counts/cohortCounts already staged by stageEnrichmentProgress rather than resetting them', async () => {
    const database = new FakeDatabase();
    await stageEnrichmentProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      countsDelta: { matched: 3, stageEnriched: 2 },
      cohortCountsDelta: { liquipediaSupplemented: 2 },
      now: 500,
    });

    const result = await publishEnrichmentCoverage(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      now: 1_000,
    });

    expect(result.snapshot.counts.matched).toBe(3);
    expect(result.snapshot.counts.stageEnriched).toBe(2);
    expect(result.snapshot.cohortCounts.liquipediaSupplemented).toBe(2);
  });

  it('a player with no source page contributes an explicit zero row and a note carrying the stated reason, rather than being omitted', async () => {
    const database = new FakeDatabase();

    const result = await publishEnrichmentCoverage(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      now: 1_000,
      notes: ['izaw: no Liquipedia VOD page found — reported as an explicit zero, not omitted'],
    });

    expect(result.snapshot.notes).toEqual([
      'izaw: no Liquipedia VOD page found — reported as an explicit zero, not omitted',
    ]);
    expect(result.snapshot.counts.vodEnriched).toBe(0);
  });

  it('republishing an identical snapshot is a no-op', async () => {
    const database = new FakeDatabase();
    const baseInput = {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      notes: ['no change here'],
    };

    const first = await publishEnrichmentCoverage(asDatabase(database), {
      ...baseInput,
      now: 1_000,
    });
    expect(first.reason).toBe('published');

    const second = await publishEnrichmentCoverage(asDatabase(database), {
      ...baseInput,
      now: 2_000,
    });
    expect(second.reason).toBe('unchanged');
    // No write happened on the second call — asOfMs stays at the FIRST call's stamp.
    expect(second.snapshot.asOfMs).toBe(first.snapshot.asOfMs);
  });

  it('rejects an unsafe tenantId rather than writing', async () => {
    const database = new FakeDatabase();
    await expect(
      publishEnrichmentCoverage(asDatabase(database), {
        tenantId: 'bad/tenant',
        runId: RUN_ID,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 30.3 Gate 5 — field coverage (present/missing/ambiguous per evidence field)
// ---------------------------------------------------------------------------

describe('deriveEnrichmentFieldCoverage', () => {
  function witness(
    overrides: Partial<ResearchEnrichmentProjectionStateRecord>,
  ): ResearchEnrichmentProjectionStateRecord {
    return { matchKey: 'k', targetSetId: 's', ...overrides };
  }

  it('classifies every witnessed row into exactly one cell per field, with latest revision/projection stamps', () => {
    const coverage = deriveEnrichmentFieldCoverage(
      [
        witness({
          // stage present, chars present, stocks present, vod present
          projectedStageId: 3,
          projectedStageName: 'Final Destination',
          stageSourceRevisionId: 500,
          stageProjectedAtMs: 1000,
          projectedSubjectSeat: 1,
          projectedSubjectFighterId: 65,
          projectedOpponentFighterId: 76,
          charsSourceRevisionId: 510,
          charsProjectedAtMs: 1100,
          projectedStocksLeft: 2,
          stocksSourceRevisionId: 520,
          stocksProjectedAtMs: 1200,
          projectedVodUrl: 'https://www.youtube.com/watch?v=a',
          vodSourceRevisionId: 530,
          vodProjectedAtMs: 1300,
        }),
        witness({
          // stage raw-only (ambiguous), chars flagged-unmapped (ambiguous),
          // stocks pending (ambiguous), vod pending (ambiguous)
          projectedStageRaw: 'Φ',
          projectedSubjectSeat: 2,
          projectedSubjectCharRaw: 'unreviewedname',
          pendingStocksLeft: 1,
          pendingVodUrl: 'https://www.youtube.com/watch?v=b',
        }),
        witness({}), // all four missing
      ],
      9999,
    );

    expect(coverage.asOfMs).toBe(9999);
    expect(coverage.witnessedRows).toBe(3);
    expect(coverage.stages).toEqual({
      present: 1,
      missing: 1,
      ambiguous: 1,
      latestSourceRevisionId: 500,
      latestProjectedAtMs: 1000,
    });
    expect(coverage.characters).toEqual({
      present: 1,
      missing: 1,
      ambiguous: 1,
      latestSourceRevisionId: 510,
      latestProjectedAtMs: 1100,
    });
    expect(coverage.stocks).toEqual({
      present: 1,
      missing: 1,
      ambiguous: 1,
      latestSourceRevisionId: 520,
      latestProjectedAtMs: 1200,
    });
    expect(coverage.vods).toEqual({
      present: 1,
      missing: 1,
      ambiguous: 1,
      latestSourceRevisionId: 530,
      latestProjectedAtMs: 1300,
    });
  });

  it('every cell sums to the witnessed universe — no row is dropped or double-counted', () => {
    const rows = [
      witness({ projectedStageId: 1, projectedStageName: 'Battlefield' }),
      witness({ projectedVodUrl: 'https://a' }),
      witness({ pendingVodRemoval: true }),
      witness({}),
    ];
    const coverage = deriveEnrichmentFieldCoverage(rows, 1);
    for (const cell of [coverage.stages, coverage.characters, coverage.stocks, coverage.vods]) {
      expect(cell.present + cell.missing + cell.ambiguous).toBe(rows.length);
    }
  });
});

describe('readEnrichmentFieldCoverage / composeEnrichmentCoverageResponse', () => {
  it('reads the witness tree, derives the rollup, and the composer attaches it to the stored snapshot', async () => {
    const database = new FakeDatabase();
    database.seed(`researchEnrichmentProjection/${TENANT_ID}/k1`, {
      matchKey: 'k1',
      targetSetId: 'set-1',
      projectedStageId: 3,
      projectedStageName: 'Final Destination',
      projectedVodUrl: 'https://www.youtube.com/watch?v=a',
    });
    await stageEnrichmentProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      countsDelta: { stageEnriched: 1 },
      now: 500,
    });

    const fieldCoverage = await readEnrichmentFieldCoverage(asDatabase(database), TENANT_ID, 900);
    expect(fieldCoverage?.witnessedRows).toBe(1);
    expect(fieldCoverage?.stages.present).toBe(1);
    expect(fieldCoverage?.vods.present).toBe(1);
    expect(fieldCoverage?.characters.missing).toBe(1);
    expect(fieldCoverage?.stocks.missing).toBe(1);

    const response = await composeEnrichmentCoverageResponse(asDatabase(database), TENANT_ID, 900);
    expect(response?.runId).toBe(RUN_ID);
    expect(response?.fieldCoverage?.asOfMs).toBe(900);
    expect(response?.fieldCoverage?.stages.present).toBe(1);
  });

  it('a tenant with no witness tree yields a snapshot without fieldCoverage; a tenant with no snapshot yields null even with witnesses', async () => {
    const database = new FakeDatabase();
    await stageEnrichmentProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      countsDelta: {},
      now: 500,
    });
    const noWitnesses = await composeEnrichmentCoverageResponse(
      asDatabase(database),
      TENANT_ID,
      900,
    );
    expect(noWitnesses).not.toBeNull();
    expect(noWitnesses?.fieldCoverage).toBeUndefined();

    const database2 = new FakeDatabase();
    database2.seed(`researchEnrichmentProjection/${TENANT_ID}/k1`, {
      matchKey: 'k1',
      targetSetId: 'set-1',
      projectedVodUrl: 'https://a',
    });
    expect(
      await composeEnrichmentCoverageResponse(asDatabase(database2), TENANT_ID, 900),
    ).toBeNull();
  });
});
