import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import type { LiquipediaClient } from '../src/liquipedia/client.js';
import type {
  EnrichmentBatchResult,
  EnrichmentDryRunDetails,
  RunEnrichmentBatchInput,
} from '../src/research/enrichment/run.js';
import { runEnrichmentOperator, type EnrichmentOperatorDeps } from './enrichDemoAccountsCore.js';

/**
 * 30.2 reliability gate: operator-core tests against FakeDatabase and a
 * stubbed batch executor — subcommand routing, per-account failure
 * isolation, completed-account resume no-op, the stall watchdog, and the
 * heartbeat. Zero network, zero Firebase, zero real enrichment pipeline
 * (that pipeline has its own suite in `src/research/enrichment/run.test.ts`).
 */

const uids = {
  hbox: 'B4AoA73kJ2dlk9B61POUsTUjM6w2',
  mkleo: 'eVJih9SgfJVk5oMPAQydPGbEBpU2',
  sparg0: 'cosPe2wagVZsTWprGKnpjrcUEsb2',
  izaw: 'VnWOqNRRP5ZqFF0457DPqiBsT4D3',
} as const;

const NOW_MS = 1_800_000_000_000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stubDryRunDetails(observationHash: string): EnrichmentDryRunDetails {
  return {
    gamesWithCanonicalStage: 1,
    gamesWithStageForm: 1,
    gamesWithoutCanonicalStage: 0,
    vodWouldFillEmpty: 1,
    vodWouldSkipUserOwned: 0,
    stageWouldEnrich: 1,
    sourceRevisions: [
      {
        sourcePageTitle: 'Stub/VODs',
        sourcePageUrl: 'https://liquipedia.net/smash/Stub/VODs',
        sourceRevisionId: 1,
        fetchedAtMs: NOW_MS,
        parserVersion: 'stub@1',
      },
    ],
    extractorVersions: ['stub@1'],
    observationPersistenceHash: observationHash,
    observationsValidated: 1,
    matchedCandidates: [
      {
        observationId: 'obs-1',
        sourcePageTitle: 'Stub/VODs',
        targetSetId: 'set-1',
        evidence: ['stub-evidence'],
      },
    ],
    reviewCandidates: [],
    missingSourcePages: [],
  };
}

function stubResult(dryRun: boolean, observationHash = 'd'.repeat(64)): EnrichmentBatchResult {
  return {
    runId: dryRun ? null : 'stub-run-1',
    dryRun,
    resumedAtProjection: false,
    counts: {
      playersRequested: 1,
      vodPagesPresent: 1,
      vodPagesMissing: 0,
      vodPageProbeRequests: 2,
      parseClassRequestsIssued: 1,
      generatedCacheHits: 0,
      pagesFetched: 2,
      vodRowsExtracted: 1,
      tournamentPagesDiscovered: 1,
      factPagesEnumerated: 2,
      probeRequestCount: 1,
      contentRequestsIssued: 1,
      wikitextCacheHits: 0,
      familyLegacy: 1,
      familyMatch2: 0,
      familyUnknown: 0,
      observationsExtracted: 1,
      candidateIndexBuildCount: 1,
      resolvedMatched: 1,
      resolvedAmbiguous: 0,
      resolvedUnmatched: 0,
      resolvedConflicting: 0,
      receiptsWritten: dryRun ? 0 : 1,
      attachmentsCreated: dryRun ? 0 : 1,
      attachmentsAbstained: 0,
      projectionsApplied: dryRun ? 0 : 1,
      projectionsReconciled: 0,
      backoffEvents: 0,
    },
    ...(dryRun ? { dryRunDetails: stubDryRunDetails(observationHash) } : {}),
  };
}

interface HarnessOptions {
  /** Called for every REAL (dryRun=false) batch invocation; throw to fail that account. */
  onRealRun?: (tenantId: string) => void;
  /** When set, every batch invocation hangs forever and emits no progress. */
  hangForever?: boolean;
  /** Per-invocation artificial latency with progress events, for heartbeat capture. */
  slowMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
  /** The observationPersistenceHash the stub reports — vary between harnesses to simulate source drift the preflight must catch. */
  observationHash?: string;
}

function buildHarness(database: FakeDatabase, options: HarnessOptions = {}) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const tables: object[][] = [];
  const batchCalls: { tenantId: string; dryRun: boolean }[] = [];
  let clientBuilds = 0;

  const runBatch = (async (input: RunEnrichmentBatchInput): Promise<EnrichmentBatchResult> => {
    batchCalls.push({ tenantId: input.tenantId, dryRun: input.dryRun });
    if (options.hangForever) {
      return new Promise<never>(() => undefined);
    }
    if (options.slowMs) {
      const deadline = Date.now() + options.slowMs;
      while (Date.now() < deadline) {
        input.onProgress?.({
          stage: 'extraction',
          unit: 'Stub/Page',
          counts: stubResult(input.dryRun).counts,
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!input.dryRun) {
      options.onRealRun?.(input.tenantId);
    }
    return stubResult(input.dryRun, options.observationHash);
  }) as EnrichmentOperatorDeps['runBatch'];

  const deps: EnrichmentOperatorDeps = {
    database: database as unknown as Database,
    databaseHost: 'example.firebaseio.com',
    buildClient: () => {
      clientBuilds += 1;
      return {} as LiquipediaClient;
    },
    runBatch,
    now: options.now ?? (() => NOW_MS),
    log: (line) => logs.push(line),
    table: (rows) => tables.push(rows),
    readFileText: async (path) => {
      const content = files.get(path);
      if (content == null) {
        throw new Error(`no such file: ${path}`);
      }
      return content;
    },
    writeFileText: async (path, content) => {
      files.set(path, content);
    },
    hashHex: sha256Hex,
    ...(options.heartbeatIntervalMs != null
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
  };

  return { deps, files, logs, tables, batchCalls, clientBuilds: () => clientBuilds };
}

function uidFlags(): string[] {
  return [
    '--hbox-uid',
    uids.hbox,
    '--mkleo-uid',
    uids.mkleo,
    '--sparg0-uid',
    uids.sparg0,
    '--izaw-uid',
    uids.izaw,
  ];
}

async function seedRun(
  database: FakeDatabase,
  uid: string,
  status: 'running' | 'completed' | 'failed',
): Promise<void> {
  await database.ref(`researchEnrichmentRuns/${uid}`).set({
    runId: `seeded-run-${uid.slice(0, 6)}`,
    status,
    startedAtMs: NOW_MS - 1000,
    ...(status === 'completed' ? { completedAtMs: NOW_MS - 500 } : {}),
    ...(status === 'failed' ? { failedAtMs: NOW_MS - 500, reason: 'seeded failure' } : {}),
  });
}

describe('runEnrichmentOperator', () => {
  it('status reports per-account run and coverage state without building any Liquipedia client', async () => {
    const database = new FakeDatabase();
    await seedRun(database, uids.hbox, 'completed');
    const harness = buildHarness(database);

    const code = await runEnrichmentOperator(['status', ...uidFlags()], harness.deps);

    expect(code).toBe(0);
    expect(harness.clientBuilds()).toBe(0);
    expect(harness.batchCalls).toEqual([]);
    const rows = harness.tables[0] as Array<{ workspace: string; runStatus: string }>;
    expect(rows.find((row) => row.workspace === 'hbox')?.runStatus).toBe('completed');
    expect(rows.find((row) => row.workspace === 'mkleo')?.runStatus).toBe('none');
  });

  it('status honours --account scoping', async () => {
    const database = new FakeDatabase();
    const harness = buildHarness(database);
    const code = await runEnrichmentOperator(
      ['status', ...uidFlags(), '--account', 'mkleo'],
      harness.deps,
    );
    expect(code).toBe(0);
    const rows = harness.tables[0] as Array<{ workspace: string }>;
    expect(rows.map((row) => row.workspace)).toEqual(['mkleo']);
  });

  it('dry-run writes a validating manifest; apply preflights it and isolates a single account failure without blocking the others', async () => {
    const database = new FakeDatabase();
    const harness = buildHarness(database, {
      onRealRun: (tenantId) => {
        if (tenantId === uids.mkleo) {
          throw new Error('injected MkLeo apply failure');
        }
      },
    });

    const dryCode = await runEnrichmentOperator(
      ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json'],
      harness.deps,
    );
    expect(dryCode).toBe(0);
    expect(harness.files.has('manifest.json')).toBe(true);
    // The dry run itself never issued a real (writing) batch invocation.
    expect(harness.batchCalls.every((call) => call.dryRun)).toBe(true);

    const applyCode = await runEnrichmentOperator(
      ['apply', ...uidFlags(), '--manifest-in', 'manifest.json'],
      harness.deps,
    );
    expect(applyCode).toBe(1);

    // STRICT PER-ACCOUNT ISOLATION: the MkLeo failure did not stop the
    // remaining accounts' real runs.
    const realRuns = harness.batchCalls.filter((call) => !call.dryRun).map((call) => call.tenantId);
    expect(realRuns).toEqual([uids.hbox, uids.mkleo, uids.sparg0, uids.izaw]);
    const applyTable = harness.tables.at(-1) as Array<{ workspace: string; apply: string }>;
    expect(applyTable.find((row) => row.workspace === 'mkleo')?.apply).toBe('FAILED');
    expect(applyTable.find((row) => row.workspace === 'hbox')?.apply).toBe('OK');
    expect(applyTable.find((row) => row.workspace === 'izaw')?.apply).toBe('OK');
  });

  it('apply refuses to write anything when preflight fails for any account', async () => {
    const database = new FakeDatabase();
    // The reviewed manifest was generated against one persisted-observation
    // digest; by apply time the source (stub) reports a different one —
    // exactly the source-drift/older-parser case the preflight must catch.
    const reviewHarness = buildHarness(database, { observationHash: 'd'.repeat(64) });
    await runEnrichmentOperator(
      ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json'],
      reviewHarness.deps,
    );

    const driftedHarness = buildHarness(database, { observationHash: 'e'.repeat(64) });
    driftedHarness.files.set('manifest.json', reviewHarness.files.get('manifest.json')!);

    const applyCode = await runEnrichmentOperator(
      ['apply', ...uidFlags(), '--manifest-in', 'manifest.json'],
      driftedHarness.deps,
    );
    expect(applyCode).toBe(1);
    expect(driftedHarness.batchCalls.filter((call) => !call.dryRun)).toEqual([]);
    expect(driftedHarness.logs.join('\n')).toContain('Apply refused');
  });

  it('resume skips a completed account as a stated no-op and re-runs only the incomplete ones', async () => {
    const database = new FakeDatabase();
    await seedRun(database, uids.hbox, 'completed');
    await seedRun(database, uids.mkleo, 'failed');
    const harness = buildHarness(database);

    await runEnrichmentOperator(
      ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json'],
      harness.deps,
    );
    const resumeCode = await runEnrichmentOperator(
      ['resume', ...uidFlags(), '--manifest-in', 'manifest.json'],
      harness.deps,
    );
    expect(resumeCode).toBe(0);

    const realRuns = harness.batchCalls.filter((call) => !call.dryRun).map((call) => call.tenantId);
    // Hungrybox (completed) is never re-run and never invalidated.
    expect(realRuns).not.toContain(uids.hbox);
    expect(realRuns).toContain(uids.mkleo);
    expect(realRuns).toContain(uids.sparg0);
    expect(realRuns).toContain(uids.izaw);
    const resumeTable = harness.tables.at(-1) as Array<{ workspace: string; detail: string }>;
    expect(resumeTable.find((row) => row.workspace === 'hbox')?.detail).toContain('no-op');
  });

  it('resume with every account complete does nothing and exits 0', async () => {
    const database = new FakeDatabase();
    for (const uid of Object.values(uids)) {
      await seedRun(database, uid, 'completed');
    }
    const harness = buildHarness(database);
    await runEnrichmentOperator(
      ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json'],
      harness.deps,
    );
    const before = harness.batchCalls.length;
    const code = await runEnrichmentOperator(
      ['resume', ...uidFlags(), '--manifest-in', 'manifest.json'],
      harness.deps,
    );
    expect(code).toBe(0);
    expect(harness.batchCalls.length).toBe(before);
    expect(harness.logs.join('\n')).toContain('nothing to resume');
  });

  it('the stall watchdog aborts a run that makes no progress within --max-stall-ms', async () => {
    const database = new FakeDatabase();
    const harness = buildHarness(database, {
      hangForever: true,
      heartbeatIntervalMs: 50,
      now: () => Date.now(),
    });

    // The stall failure propagates as a rejection — the lifecycle wrapper
    // (enrichLifecycle.ts) is what maps it to exit code 1.
    await expect(
      runEnrichmentOperator(
        ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json', '--max-stall-ms', '100'],
        harness.deps,
      ),
    ).rejects.toThrow('no progress');
    expect(harness.logs.join('\n')).toContain('[watchdog]');
  }, 15_000);

  it('emits heartbeat lines carrying account, stage, unit and counters while work is in flight', async () => {
    const database = new FakeDatabase();
    const harness = buildHarness(database, {
      slowMs: 120,
      heartbeatIntervalMs: 20,
      now: () => Date.now(),
    });

    const code = await runEnrichmentOperator(
      ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json'],
      harness.deps,
    );
    expect(code).toBe(0);
    const heartbeats = harness.logs.filter((line) => line.includes('[heartbeat]'));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats.some((line) => line.includes('account=hbox'))).toBe(true);
    expect(heartbeats[0]).toContain('stage=');
    expect(heartbeats[0]).toContain('unit=');
    expect(heartbeats[0]).toContain('observations=');
  });

  it('rejects a manifest whose database host does not match the active database', async () => {
    const database = new FakeDatabase();
    const harness = buildHarness(database);
    await runEnrichmentOperator(
      ['dry-run', ...uidFlags(), '--manifest-out', 'manifest.json'],
      harness.deps,
    );
    const otherHost = buildHarness(database);
    otherHost.files.set('manifest.json', harness.files.get('manifest.json')!);
    (otherHost.deps as { databaseHost: string }).databaseHost = 'other.firebaseio.com';
    await expect(
      runEnrichmentOperator(['apply', ...uidFlags(), '--manifest-in', 'manifest.json'], {
        ...otherHost.deps,
        databaseHost: 'other.firebaseio.com',
      }),
    ).rejects.toThrow('database host');
  });

  it('rejects an unknown subcommand and an unknown --account', async () => {
    const database = new FakeDatabase();
    const harness = buildHarness(database);
    await expect(runEnrichmentOperator(['bogus', ...uidFlags()], harness.deps)).rejects.toThrow(
      'Expected subcommand',
    );
    await expect(
      runEnrichmentOperator(['status', ...uidFlags(), '--account', 'nope'], harness.deps),
    ).rejects.toThrow('--account');
  });
});
