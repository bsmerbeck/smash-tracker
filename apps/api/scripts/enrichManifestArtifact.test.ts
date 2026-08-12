import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { previewEnrichmentProjection } from '../src/research/enrichment/projection.js';
import {
  buildEnrichmentComparison,
  computeEnrichmentManifestHash,
  createEnrichmentManifest,
  validateEnrichmentManifest,
  type DemoUidMap,
  type EnrichmentAccountManifest,
  type EnrichmentCoverageMetrics,
  type EnrichmentManifestBody,
} from './enrichManifestArtifact.js';

const nowMs = 1_800_000_000_000;
const uids: DemoUidMap = {
  hbox: 'B4AoA73kJ2dlk9B61POUsTUjM6w2',
  mkleo: 'eVJih9SgfJVk5oMPAQydPGbEBpU2',
  sparg0: 'cosPe2wagVZsTWprGKnpjrcUEsb2',
  izaw: 'VnWOqNRRP5ZqFF0457DPqiBsT4D3',
};

function coverage(): EnrichmentCoverageMetrics {
  return {
    asOfMs: null,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    conflicting: 0,
    stageEnriched: 0,
    vodFilledEmpty: 0,
    vodSkippedUserOwned: 0,
    sourceRevisionCount: 0,
  };
}

function account(label: string, uid: string): EnrichmentAccountManifest {
  return {
    label,
    uid,
    pagesFetched: 2,
    pagesFromCache: 0,
    networkRequestsOperationalOnly: 4,
    observationsExtracted: 1,
    vodPageRows: 1,
    matched: 1,
    ambiguous: 0,
    unmatched: 0,
    conflicting: 0,
    gamesWithCanonicalStage: 1,
    gamesWithStageForm: 1,
    gamesWithoutCanonicalStage: 0,
    stageWouldEnrich: 1,
    vodWouldFillEmpty: 1,
    vodWouldSkipUserOwned: 0,
    sourceRevisions: [
      {
        sourcePageTitle: `${label}/VODs`,
        sourcePageUrl: `https://liquipedia.net/smash/${label}/VODs`,
        sourceRevisionId: 1,
        fetchedAtMs: nowMs,
        parserVersion: 'test@1',
      },
    ],
    extractorVersions: ['test@1'],
    reviewCandidates: [],
    missingSourcePages: [],
    beforeCoverage: coverage(),
  };
}

function body(): EnrichmentManifestBody {
  return {
    formatVersion: 1,
    generatedAtMs: nowMs,
    databaseHost: 'example.firebaseio.com',
    sinceYear: 2024,
    targetUids: uids,
    writesPerformed: 0,
    networkRequestCountIsSuccessMetric: false,
    accounts: {
      hbox: account('Hungrybox', uids.hbox),
      mkleo: account('MkLeo', uids.mkleo),
      sparg0: account('Sparg0', uids.sparg0),
      izaw: account('IzAw', uids.izaw),
    },
  };
}

describe('enrichment manifest artifact', () => {
  it('hashes canonical content and validates the reviewed target set', () => {
    const manifest = createEnrichmentManifest(body());
    expect(manifest.contentHash).toBe(computeEnrichmentManifestHash(body()));
    expect(validateEnrichmentManifest(manifest, uids, nowMs + 1, 10_000)).toEqual(manifest);
    expect(manifest.writesPerformed).toBe(0);
    expect(manifest.networkRequestCountIsSuccessMetric).toBe(false);
  });

  it('rejects content tampering', () => {
    const manifest = createEnrichmentManifest(body());
    expect(() =>
      validateEnrichmentManifest({ ...manifest, sinceYear: 2025 }, uids, nowMs + 1, 10_000),
    ).toThrow('content hash mismatch');
  });

  it('rejects a different target map and an account-level mismatch', () => {
    const manifest = createEnrichmentManifest(body());
    expect(() =>
      validateEnrichmentManifest(
        manifest,
        { ...uids, hbox: 'differentDemoAccountUid12345' },
        nowMs + 1,
        10_000,
      ),
    ).toThrow('target UIDs');
    const changedBody = body();
    changedBody.accounts.hbox.uid = uids.mkleo;
    const changed = createEnrichmentManifest(changedBody);
    expect(() => validateEnrichmentManifest(changed, uids, nowMs + 1, 10_000)).toThrow(
      'account UID mismatch',
    );
  });

  it('rejects stale and future manifests', () => {
    const manifest = createEnrichmentManifest(body());
    expect(() => validateEnrichmentManifest(manifest, uids, nowMs + 101, 100)).toThrow('stale');
    expect(() => validateEnrichmentManifest(manifest, uids, nowMs - 1, 100)).toThrow('future');
  });

  it('rejects a non-positive staleness bound and duplicate target UIDs', () => {
    const manifest = createEnrichmentManifest(body());
    expect(() => validateEnrichmentManifest(manifest, uids, nowMs, 0)).toThrow('positive');
    const duplicate = { ...uids, izaw: uids.hbox };
    const duplicateBody = body();
    duplicateBody.targetUids = duplicate;
    duplicateBody.accounts.izaw.uid = duplicate.izaw;
    expect(() =>
      validateEnrichmentManifest(createEnrichmentManifest(duplicateBody), duplicate, nowMs, 100),
    ).toThrow('unique');
  });

  it('builds every before/after metric row', () => {
    const manifest = createEnrichmentManifest(body());
    const after = {
      hbox: { ...coverage(), matched: 2 },
      mkleo: coverage(),
      sparg0: coverage(),
      izaw: coverage(),
    };
    const rows = buildEnrichmentComparison(manifest, after);
    expect(rows).toHaveLength(36);
    expect(rows.find((row) => row.workspace === 'hbox' && row.metric === 'matched')).toMatchObject({
      before: 0,
      after: 2,
    });
  });
});

describe('read-only projection preview', () => {
  it('reports a fill while issuing zero database writes', async () => {
    let writes = 0;
    const values: Record<string, unknown> = {
      'matches/demo/sgg-set-1-g1': { map: { id: 0, name: 'Unknown' } },
    };
    const database = {
      ref(path = '') {
        return {
          async get() {
            const value = values[path];
            return { exists: () => value !== undefined, val: () => value ?? null };
          },
          async update() {
            writes += 1;
          },
          async set() {
            writes += 1;
          },
          async transaction() {
            writes += 1;
            throw new Error('transaction must not run in preview');
          },
        };
      },
    } as unknown as Database;
    const result = await previewEnrichmentProjection(database, 'demo', 'set-1', {
      enrichedVodUrlByKey: { 'sgg-set-1-g1': 'https://youtu.be/example' },
      enrichedVodSourceByKey: {},
      enrichedStageByKey: {},
    });
    expect(result.counts.vodFilledEmpty).toBe(1);
    expect(result.counts.vodSkippedUserOwned).toBe(0);
    expect(writes).toBe(0);
  });
});
