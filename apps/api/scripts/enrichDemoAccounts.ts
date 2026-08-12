/**
 * Owner-only operator for the four ordinary demo accounts. The frozen
 * Phase 30.1 research tenants are intentionally out of scope: this script
 * never targets, archives, or changes their lifecycle.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { getLiquipediaConfig, loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { createLiquipediaClient } from '../src/liquipedia/client.js';
import {
  LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
  LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS,
  createLiquipediaLimiter,
  type LiquipediaLimiter,
} from '../src/liquipedia/limiter.js';
import { readEnrichmentCoverage } from '../src/research/enrichment/rollup.js';
import { runEnrichmentBatch } from '../src/research/enrichment/run.js';
import {
  buildEnrichmentComparison,
  createEnrichmentManifest,
  demoWorkspaceKeys,
  validateEnrichmentManifest,
  type DemoUidMap,
  type DemoWorkspaceKey,
  type EnrichmentAccountManifest,
  type EnrichmentCoverageMetrics,
  type EnrichmentManifest,
} from './enrichManifestArtifact.js';

const labels: Record<DemoWorkspaceKey, string> = {
  hbox: 'Hungrybox',
  mkleo: 'MkLeo',
  sparg0: 'Sparg0',
  izaw: 'IzAw',
};
const DEFAULT_SINCE_YEAR = 2024;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  if (!command || !['dry-run', 'apply', 'compare'].includes(command)) {
    throw new Error('Expected subcommand: dry-run, apply, or compare');
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value == null || value.startsWith('--')) {
      throw new Error(`Invalid flag near ${name ?? '<end>'}`);
    }
    flags.set(name, value);
  }
  return { command, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
  }
  return value;
}

function readUids(flags: Map<string, string>): DemoUidMap {
  const uids = {
    hbox: required(flags, '--hbox-uid'),
    mkleo: required(flags, '--mkleo-uid'),
    sparg0: required(flags, '--sparg0-uid'),
    izaw: required(flags, '--izaw-uid'),
  };
  if (new Set(Object.values(uids)).size !== demoWorkspaceKeys.length) {
    throw new Error('Every demo account UID must be unique');
  }
  return uids;
}

function positiveInteger(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function createReadOnlyLimiter(): LiquipediaLimiter {
  let lastGeneral = 0;
  let lastParse = 0;
  const waitFor = async (last: number, interval: number): Promise<number> => {
    const remaining = Math.max(0, last + interval - Date.now());
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    return Date.now();
  };
  return {
    async acquire(requestClass, remainingWaitBudgetMs) {
      const startedAt = Date.now();
      if (requestClass === 'parse-class') {
        const wait = Math.max(0, lastParse + LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS - Date.now());
        if (wait > remainingWaitBudgetMs) {
          return { granted: false, waitedMs: 0, reason: 'wait-budget-exceeded' };
        }
        lastParse = await waitFor(lastParse, LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS);
      }
      const generalWait = Math.max(
        0,
        lastGeneral + LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS - Date.now(),
      );
      if (Date.now() - startedAt + generalWait > remainingWaitBudgetMs) {
        return { granted: false, waitedMs: Date.now() - startedAt, reason: 'wait-budget-exceeded' };
      }
      lastGeneral = await waitFor(lastGeneral, LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
      return { granted: true, waitedMs: Date.now() - startedAt };
    },
  };
}

function buildClient(
  config: NonNullable<ReturnType<typeof getLiquipediaConfig>>,
  limiter: LiquipediaLimiter,
): ReturnType<typeof createLiquipediaClient> {
  // This owner CLI is the only production composition root permitted to
  // hand the client the runtime's real network implementation.
  return createLiquipediaClient({ config, limiter, fetchImpl: globalThis.fetch });
}

async function readCoverageMetrics(
  database: ReturnType<typeof initFirebase>['database'],
  uid: string,
): Promise<EnrichmentCoverageMetrics> {
  const snapshot = await readEnrichmentCoverage(database, uid);
  const counts = snapshot?.counts;
  return {
    asOfMs: snapshot?.asOfMs ?? null,
    matched: counts?.matched ?? 0,
    ambiguous: counts?.ambiguous ?? 0,
    unmatched: counts?.unmatched ?? 0,
    conflicting: counts?.conflicting ?? 0,
    stageEnriched: counts?.stageEnriched ?? 0,
    vodFilledEmpty: counts?.vodFilledEmpty ?? 0,
    vodSkippedUserOwned: counts?.vodSkippedUserOwned ?? 0,
    sourceRevisionCount: Object.keys(snapshot?.perSourcePage ?? {}).length,
  };
}

function requestCount(counts: Awaited<ReturnType<typeof runEnrichmentBatch>>['counts']): number {
  return (
    counts.vodPageProbeRequests +
    counts.parseClassRequestsIssued +
    counts.tournamentPagesDiscovered +
    counts.probeRequestCount +
    counts.contentRequestsIssued
  );
}

async function runOne(
  database: ReturnType<typeof initFirebase>['database'],
  client: ReturnType<typeof createLiquipediaClient>,
  workspace: DemoWorkspaceKey,
  uid: string,
  sinceYear: number,
  dryRun: boolean,
): Promise<Awaited<ReturnType<typeof runEnrichmentBatch>>> {
  return runEnrichmentBatch({
    database,
    client,
    tenantId: uid,
    playerLabels: [labels[workspace]],
    targetGame: 'ultimate',
    sliceFilter: { earliestYear: sinceYear },
    nowMs: Date.now(),
    hashHex: (value) => createHash('sha256').update(value).digest('hex'),
    dryRun,
  });
}

async function dryRun(
  database: ReturnType<typeof initFirebase>['database'],
  config: NonNullable<ReturnType<typeof getLiquipediaConfig>>,
  uids: DemoUidMap,
  sinceYear: number,
  manifestPath: string,
  databaseHost: string,
): Promise<void> {
  const client = buildClient(config, createReadOnlyLimiter());
  const accounts = {} as Record<DemoWorkspaceKey, EnrichmentAccountManifest>;
  for (const workspace of demoWorkspaceKeys) {
    const beforeCoverage = await readCoverageMetrics(database, uids[workspace]);
    const result = await runOne(database, client, workspace, uids[workspace], sinceYear, true);
    const details = result.dryRunDetails;
    if (!details) {
      throw new Error(`Dry-run evidence was not returned for ${workspace}`);
    }
    accounts[workspace] = {
      label: labels[workspace],
      uid: uids[workspace],
      pagesFetched: result.counts.pagesFetched,
      pagesFromCache: result.counts.generatedCacheHits + result.counts.wikitextCacheHits,
      networkRequestsOperationalOnly: requestCount(result.counts),
      observationsExtracted: result.counts.observationsExtracted,
      vodPageRows: result.counts.vodRowsExtracted,
      matched: result.counts.resolvedMatched,
      ambiguous: result.counts.resolvedAmbiguous,
      unmatched: result.counts.resolvedUnmatched,
      conflicting: result.counts.resolvedConflicting,
      gamesWithCanonicalStage: details.gamesWithCanonicalStage,
      gamesWithStageForm: details.gamesWithStageForm,
      gamesWithoutCanonicalStage: details.gamesWithoutCanonicalStage,
      stageWouldEnrich: details.stageWouldEnrich,
      vodWouldFillEmpty: details.vodWouldFillEmpty,
      vodWouldSkipUserOwned: details.vodWouldSkipUserOwned,
      sourceRevisions: details.sourceRevisions,
      extractorVersions: details.extractorVersions,
      reviewCandidates: details.reviewCandidates,
      missingSourcePages: details.missingSourcePages,
      beforeCoverage,
    };
  }
  const manifest = createEnrichmentManifest({
    formatVersion: 1,
    generatedAtMs: Date.now(),
    databaseHost,
    sinceYear,
    targetUids: uids,
    writesPerformed: 0,
    networkRequestCountIsSuccessMetric: false,
    accounts,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.table(
    demoWorkspaceKeys.map((workspace) => ({
      workspace,
      matched: accounts[workspace].matched,
      ambiguous: accounts[workspace].ambiguous,
      unmatched: accounts[workspace].unmatched,
      conflicting: accounts[workspace].conflicting,
      stageFills: accounts[workspace].stageWouldEnrich,
      vodFills: accounts[workspace].vodWouldFillEmpty,
      vodSkips: accounts[workspace].vodWouldSkipUserOwned,
      requestsOperationalOnly: accounts[workspace].networkRequestsOperationalOnly,
    })),
  );
  console.log(`Zero writes performed. Manifest: ${manifestPath}`);
}

async function readVerifiedManifest(
  path: string,
  uids: DemoUidMap,
  maxAgeMs: number,
): Promise<EnrichmentManifest> {
  return validateEnrichmentManifest(
    JSON.parse(await readFile(path, 'utf8')),
    uids,
    Date.now(),
    maxAgeMs,
  );
}

async function apply(
  database: ReturnType<typeof initFirebase>['database'],
  config: NonNullable<ReturnType<typeof getLiquipediaConfig>>,
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
): Promise<void> {
  const client = buildClient(config, createLiquipediaLimiter(database));
  for (const workspace of demoWorkspaceKeys) {
    const result = await runOne(
      database,
      client,
      workspace,
      uids[workspace],
      manifest.sinceYear,
      false,
    );
    console.log(
      `${workspace}: run=${result.runId ?? 'none'} matched=${result.counts.resolvedMatched}`,
    );
  }
}

async function compare(
  database: ReturnType<typeof initFirebase>['database'],
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
): Promise<void> {
  const after = {} as Record<DemoWorkspaceKey, EnrichmentCoverageMetrics>;
  for (const workspace of demoWorkspaceKeys) {
    after[workspace] = await readCoverageMetrics(database, uids[workspace]);
  }
  console.table(buildEnrichmentComparison(manifest, after));
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const { command, flags } = parseArgs(process.argv.slice(2));
  const uids = readUids(flags);
  const env = loadEnv();
  const liquipediaConfig = getLiquipediaConfig(env);
  if (!liquipediaConfig) {
    throw new Error('LIQUIPEDIA_CONTACT is required');
  }
  const { database } = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  console.log(`Database host: ${databaseHost}`);
  console.log(`Target UIDs: ${demoWorkspaceKeys.map((key) => uids[key]).join(', ')}`);
  const maxAgeMs = positiveInteger(flags, '--max-age-ms', DEFAULT_MAX_AGE_MS);
  if (command === 'dry-run') {
    await dryRun(
      database,
      liquipediaConfig,
      uids,
      positiveInteger(flags, '--since-year', DEFAULT_SINCE_YEAR),
      required(flags, '--manifest-out'),
      databaseHost,
    );
    return;
  }
  const manifest = await readVerifiedManifest(required(flags, '--manifest-in'), uids, maxAgeMs);
  if (manifest.databaseHost !== databaseHost) {
    throw new Error('Manifest database host does not match the active database');
  }
  if (command === 'apply') {
    await apply(database, liquipediaConfig, uids, manifest);
  } else {
    await compare(database, uids, manifest);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
