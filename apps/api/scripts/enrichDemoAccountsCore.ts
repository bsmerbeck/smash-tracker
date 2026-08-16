import type { Database } from 'firebase-admin/database';
import type { LiquipediaClient } from '../src/liquipedia/client.js';
import { readEnrichmentCoverage } from '../src/research/enrichment/rollup.js';
import { readEnrichmentRun } from '../src/research/enrichment/runState.js';
import { sweepOutdatedFamilyObservations } from '../src/research/enrichment/store.js';
import {
  runEnrichmentBatch,
  type EnrichmentRunProgressEvent,
} from '../src/research/enrichment/run.js';
import {
  ENRICHMENT_MANIFEST_FORMAT_VERSION,
  buildEnrichmentComparison,
  computeAccountWriteSetHash,
  createEnrichmentManifest,
  demoWorkspaceKeys,
  validateEnrichmentManifest,
  type DemoUidMap,
  type DemoWorkspaceKey,
  type EnrichmentAccountManifest,
  type EnrichmentCoverageMetrics,
  type EnrichmentManifest,
} from './enrichManifestArtifact.js';

/**
 * 30.2 reliability gate (owner corrective directive, Gate 1): the enrichment
 * operator CORE — every subcommand implemented against INJECTED
 * dependencies (database, client factories, clock, log, filesystem), so the
 * whole operator is testable against `FakeDatabase` with zero network and
 * zero Firebase. The thin entry (`enrichDemoAccounts.ts`) wires the real
 * world in and wraps everything in `runWithLifecycle`
 * (`enrichLifecycle.ts`), which owns the termination guarantee.
 *
 * Subcommands (account-scoped via `--account <key>`):
 * - `status`     — per-account run/coverage state; no Liquipedia network.
 * - `dry-run`    — full read-only extraction, writes the reviewed manifest.
 * - `preflight`  — re-extracts read-only and compares against a reviewed
 *                  manifest's per-account write-set hashes; PASS/FAIL each.
 * - `apply`      — preflight, then the real per-account runs, with strict
 *                  PER-ACCOUNT FAILURE ISOLATION: one account's failure
 *                  never restarts, invalidates, or blocks the others. An
 *                  account whose stored run is already COMPLETED is a
 *                  stated no-op unless `--reapply` is passed (30.2
 *                  sanctioned re-apply): the completed-account default
 *                  stays strong, and the explicit flag is the only door to
 *                  re-running one — preflight discipline unchanged, and the
 *                  store's idempotent upserts make the top-up safe.
 * - `resume`     — re-runs only accounts whose stored run is not completed;
 *                  a completed account (e.g. Hungrybox) is reported and
 *                  skipped — a structural no-op.
 * - `sweep`      — version-wide stale-record sweep: removes bracket-family
 *                  records whose parserVersion is outdated (pages the
 *                  current expansion no longer visits, unreachable by the
 *                  page-scoped supersede pass). Zero Liquipedia network;
 *                  refuses any account holding a LIVE run lease.
 * - `compare`    — before/after coverage table against the manifest.
 *
 * Observability: a heartbeat line at least every `heartbeatIntervalMs`
 * (default 30s) reporting account, stage, page/unit, and counters, driven
 * by `runEnrichmentBatch`'s work-unit progress events; a stall watchdog
 * aborts the operator after `--max-stall-ms` (default 5 minutes) without a
 * single progress event.
 */

const labels: Record<DemoWorkspaceKey, string> = {
  hbox: 'Hungrybox',
  mkleo: 'MkLeo',
  sparg0: 'Sparg0',
  izaw: 'IzAw',
};

const DEFAULT_SINCE_YEAR = 2024;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_STALL_MS = 5 * 60 * 1000;

export const ENRICHMENT_OPERATOR_COMMANDS = [
  'status',
  'dry-run',
  'preflight',
  'apply',
  'resume',
  'sweep',
  'compare',
] as const;
export type EnrichmentOperatorCommand = (typeof ENRICHMENT_OPERATOR_COMMANDS)[number];

export interface EnrichmentOperatorDeps {
  database: Database;
  databaseHost: string;
  /**
   * Builds a Liquipedia client. `'read-only'` uses the in-process pacing
   * limiter (dry-run/preflight); `'apply'` uses the durable shared limiter.
   * The signal aborts in-flight network work on stall/interruption.
   */
  buildClient: (kind: 'read-only' | 'apply', signal: AbortSignal) => LiquipediaClient;
  /** The batch executor — injected so operator tests can exercise per-account isolation without a fixture pipeline. */
  runBatch: typeof runEnrichmentBatch;
  now: () => number;
  log: (line: string) => void;
  table: (rows: object[]) => void;
  readFileText: (path: string) => Promise<string>;
  writeFileText: (path: string, content: string) => Promise<void>;
  hashHex: (value: string) => string;
  heartbeatIntervalMs?: number;
  /** The lifecycle's shutdown signal (SIGINT/SIGTERM). The operator chains its own stall abort onto it. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedOperatorArgs {
  command: EnrichmentOperatorCommand;
  flags: Map<string, string>;
}

/** Flags that take no value — present means `'true'`. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['--reapply']);

export function parseOperatorArgs(argv: string[]): ParsedOperatorArgs {
  const [command, ...rest] = argv;
  if (!command || !(ENRICHMENT_OPERATOR_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Expected subcommand: ${ENRICHMENT_OPERATOR_COMMANDS.join(', ')}`);
  }
  const flags = new Map<string, string>();
  let index = 0;
  while (index < rest.length) {
    const name = rest[index];
    if (!name?.startsWith('--')) {
      throw new Error(`Invalid flag near ${name ?? '<end>'}`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, 'true');
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Invalid flag near ${name}`);
    }
    flags.set(name, value);
    index += 2;
  }
  return { command: command as EnrichmentOperatorCommand, flags };
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

/** The accounts a subcommand operates on — all four, or the one named by `--account`. */
function scopedWorkspaces(flags: Map<string, string>): DemoWorkspaceKey[] {
  const account = flags.get('--account');
  if (account == null) {
    return [...demoWorkspaceKeys];
  }
  if (!(demoWorkspaceKeys as readonly string[]).includes(account)) {
    throw new Error(`--account must be one of ${demoWorkspaceKeys.join(', ')}`);
  }
  return [account as DemoWorkspaceKey];
}

// ---------------------------------------------------------------------------
// Progress monitor — heartbeat + stall watchdog
// ---------------------------------------------------------------------------

interface ProgressMonitor {
  onProgress: (account: DemoWorkspaceKey, event: EnrichmentRunProgressEvent) => void;
  /** Set when the watchdog tripped; carries the stall description. */
  stalledReason: () => string | null;
  dispose: () => void;
  /** Signal that aborts when the watchdog trips OR the lifecycle signal fires. */
  signal: AbortSignal;
  /** Rejects when the watchdog trips — raced against long work so a stall fails the command even when nothing is abortable in flight. */
  stallPromise: Promise<never>;
}

function createProgressMonitor(deps: EnrichmentOperatorDeps, maxStallMs: number): ProgressMonitor {
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const controller = new AbortController();
  if (deps.signal) {
    if (deps.signal.aborted) {
      controller.abort(deps.signal.reason);
    } else {
      deps.signal.addEventListener('abort', () => controller.abort(deps.signal?.reason), {
        once: true,
      });
    }
  }

  let last = {
    account: '-' as string,
    stage: '-' as string,
    unit: '-' as string,
    summary: '',
    atMs: deps.now(),
  };
  let stalled: string | null = null;
  let rejectStall: ((error: Error) => void) | null = null;
  const stallPromise = new Promise<never>((_resolve, reject) => {
    rejectStall = reject;
  });
  // A stall can trip while nothing is racing against it (e.g. during
  // manifest validation) — pre-attach a swallow handler so that rejection is
  // never "unhandled"; the abort signal carries the failure to whatever work
  // is in flight.
  void stallPromise.catch(() => undefined);

  const heartbeat = setInterval(() => {
    deps.log(
      `[heartbeat] account=${last.account} stage=${last.stage} unit=${last.unit} ` +
        `${last.summary} lastProgressMsAgo=${deps.now() - last.atMs}`,
    );
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const watchdog = setInterval(
    () => {
      const idleMs = deps.now() - last.atMs;
      if (idleMs > maxStallMs && stalled === null) {
        stalled = `no progress for ${idleMs}ms (limit ${maxStallMs}ms); aborting`;
        deps.log(`[watchdog] ${stalled}`);
        controller.abort(new Error(stalled));
        rejectStall?.(new Error(stalled));
      }
    },
    Math.max(250, Math.min(heartbeatIntervalMs, Math.floor(maxStallMs / 4))),
  );
  watchdog.unref?.();

  return {
    onProgress: (account, event) => {
      last = {
        account,
        stage: event.stage,
        unit: event.unit ?? '-',
        summary:
          `pages=${event.counts.pagesFetched} observations=${event.counts.observationsExtracted} ` +
          `matched=${event.counts.resolvedMatched} attached=${event.counts.attachmentsCreated} ` +
          `projected=${event.counts.projectionsApplied}`,
        atMs: deps.now(),
      };
    },
    stalledReason: () => stalled,
    dispose: () => {
      clearInterval(heartbeat);
      clearInterval(watchdog);
    },
    signal: controller.signal,
    stallPromise,
  };
}

// ---------------------------------------------------------------------------
// Shared per-account helpers
// ---------------------------------------------------------------------------

async function readCoverageMetrics(
  database: Database,
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

function buildAccountManifest(
  workspace: DemoWorkspaceKey,
  uid: string,
  result: Awaited<ReturnType<typeof runEnrichmentBatch>>,
  beforeCoverage: EnrichmentCoverageMetrics,
): EnrichmentAccountManifest {
  const details = result.dryRunDetails;
  if (!details) {
    throw new Error(`Dry-run evidence was not returned for ${workspace}`);
  }
  const accountWithoutHash: Omit<EnrichmentAccountManifest, 'writeSetHash'> = {
    label: labels[workspace],
    uid,
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
    observationPersistenceHash: details.observationPersistenceHash,
    observationsValidated: details.observationsValidated,
    matchedCandidates: details.matchedCandidates,
    reviewCandidates: details.reviewCandidates,
    missingSourcePages: details.missingSourcePages,
    beforeCoverage,
  };
  return {
    ...accountWithoutHash,
    writeSetHash: computeAccountWriteSetHash(accountWithoutHash),
  };
}

interface RunOneInput {
  deps: EnrichmentOperatorDeps;
  client: LiquipediaClient;
  monitor: ProgressMonitor;
  workspace: DemoWorkspaceKey;
  uid: string;
  sinceYear: number;
  dryRun: boolean;
}

async function runOne(input: RunOneInput): Promise<Awaited<ReturnType<typeof runEnrichmentBatch>>> {
  const { deps, client, monitor, workspace, uid, sinceYear, dryRun } = input;
  // Raced against the stall watchdog so a stall fails the command even when
  // no abortable network request is in flight; the batch itself also honours
  // the abort transitively through the client's injected fetch.
  return Promise.race([
    deps.runBatch({
      database: deps.database,
      client,
      tenantId: uid,
      playerLabels: [labels[workspace]],
      targetGame: 'ultimate',
      sliceFilter: { earliestYear: sinceYear },
      nowMs: deps.now(),
      now: deps.now,
      hashHex: deps.hashHex,
      dryRun,
      onProgress: (event) => monitor.onProgress(workspace, event),
    }),
    monitor.stallPromise,
  ]);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function statusCommand(
  deps: EnrichmentOperatorDeps,
  uids: DemoUidMap,
  workspaces: DemoWorkspaceKey[],
): Promise<number> {
  const rows: object[] = [];
  for (const workspace of workspaces) {
    const uid = uids[workspace];
    const run = await readEnrichmentRun(deps.database, uid);
    const coverage = await readCoverageMetrics(deps.database, uid);
    rows.push({
      workspace,
      label: labels[workspace],
      runStatus: run?.status ?? 'none',
      cursorStage: run?.cursor?.stage ?? '-',
      coveragePublished: run?.coveragePublishedAtMs != null,
      matched: coverage.matched,
      stageEnriched: coverage.stageEnriched,
      vodFilledEmpty: coverage.vodFilledEmpty,
      sourcePages: coverage.sourceRevisionCount,
    });
  }
  deps.table(rows);
  return 0;
}

/**
 * The version-wide stale-record sweep (30.2 follow-up). Zero Liquipedia
 * network — a pure read/remove pass over the tenant's own observation tree
 * via `sweepOutdatedFamilyObservations` (only bracket-family records at an
 * OUTDATED parser version; current-version, vodlist and wikitext-probe
 * records are structurally untouchable there). An account holding a LIVE
 * run lease is refused: a concurrent run's page-scoped supersede and this
 * sweep must never race over the same records.
 */
async function sweepCommand(
  deps: EnrichmentOperatorDeps,
  uids: DemoUidMap,
  workspaces: DemoWorkspaceKey[],
): Promise<number> {
  const rows: object[] = [];
  let refused = 0;
  for (const workspace of workspaces) {
    const uid = uids[workspace];
    const run = await readEnrichmentRun(deps.database, uid);
    const liveLease =
      run?.status === 'running' && run.lease != null && run.lease.expiresAtMs > deps.now();
    if (liveLease) {
      refused += 1;
      rows.push({
        workspace,
        sweep: 'REFUSED',
        detail: `a live run lease exists (run=${run.runId}, expires in ${run.lease!.expiresAtMs - deps.now()}ms); retry after it completes or expires`,
      });
      continue;
    }
    const result = await sweepOutdatedFamilyObservations(deps.database, uid);
    if (result.removedAttachmentCount > 0 || result.removedReceiptCount > 0) {
      // Stale records are expected to be inert (unmatched, unattached) — a
      // cascaded attachment/receipt means an OLD-generation record was still
      // wired into projection authorization and deserves a loud report.
      deps.log(
        `[sweep] ${workspace}: cascaded ${result.removedAttachmentCount} attachment(s) and ` +
          `${result.removedReceiptCount} receipt(s) off outdated records — these were NOT inert; review before trusting prior coverage`,
      );
    }
    rows.push({
      workspace,
      sweep: 'OK',
      removed: result.removedObservationIds.length,
      cascadedAttachments: result.removedAttachmentCount,
      cascadedReceipts: result.removedReceiptCount,
    });
  }
  deps.table(rows);
  return refused > 0 ? 1 : 0;
}

async function dryRunCommand(
  deps: EnrichmentOperatorDeps,
  monitor: ProgressMonitor,
  uids: DemoUidMap,
  sinceYear: number,
  manifestPath: string,
): Promise<number> {
  const client = deps.buildClient('read-only', monitor.signal);
  const accounts = {} as Record<DemoWorkspaceKey, EnrichmentAccountManifest>;
  for (const workspace of demoWorkspaceKeys) {
    const beforeCoverage = await readCoverageMetrics(deps.database, uids[workspace]);
    const result = await runOne({
      deps,
      client,
      monitor,
      workspace,
      uid: uids[workspace],
      sinceYear,
      dryRun: true,
    });
    accounts[workspace] = buildAccountManifest(workspace, uids[workspace], result, beforeCoverage);
  }
  const manifest = createEnrichmentManifest({
    formatVersion: ENRICHMENT_MANIFEST_FORMAT_VERSION,
    generatedAtMs: deps.now(),
    databaseHost: deps.databaseHost,
    sinceYear,
    targetUids: uids,
    writesPerformed: 0,
    networkRequestCountIsSuccessMetric: false,
    accounts,
  });
  await deps.writeFileText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  deps.table(
    demoWorkspaceKeys.map((workspace) => ({
      workspace,
      matched: accounts[workspace].matched,
      ambiguous: accounts[workspace].ambiguous,
      unmatched: accounts[workspace].unmatched,
      conflicting: accounts[workspace].conflicting,
      stageFills: accounts[workspace].stageWouldEnrich,
      vodFills: accounts[workspace].vodWouldFillEmpty,
      vodSkips: accounts[workspace].vodWouldSkipUserOwned,
      observationsValidated: accounts[workspace].observationsValidated,
      requestsOperationalOnly: accounts[workspace].networkRequestsOperationalOnly,
    })),
  );
  deps.log(`Zero writes performed. Manifest: ${manifestPath}`);
  return 0;
}

async function readVerifiedManifest(
  deps: EnrichmentOperatorDeps,
  path: string,
  uids: DemoUidMap,
  maxAgeMs: number,
): Promise<EnrichmentManifest> {
  return validateEnrichmentManifest(
    JSON.parse(await deps.readFileText(path)),
    uids,
    deps.now(),
    maxAgeMs,
  );
}

interface PreflightOutcome {
  workspace: DemoWorkspaceKey;
  ok: boolean;
  detail: string;
}

/** Read-only re-extraction per account, hash-compared against the reviewed manifest. Every account is checked independently — one mismatch never hides another's result. */
async function preflightAccounts(
  deps: EnrichmentOperatorDeps,
  monitor: ProgressMonitor,
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
  workspaces: DemoWorkspaceKey[],
): Promise<PreflightOutcome[]> {
  const client = deps.buildClient('read-only', monitor.signal);
  const outcomes: PreflightOutcome[] = [];
  for (const workspace of workspaces) {
    try {
      const beforeCoverage = await readCoverageMetrics(deps.database, uids[workspace]);
      const result = await runOne({
        deps,
        client,
        monitor,
        workspace,
        uid: uids[workspace],
        sinceYear: manifest.sinceYear,
        dryRun: true,
      });
      const current = buildAccountManifest(workspace, uids[workspace], result, beforeCoverage);
      if (current.writeSetHash === manifest.accounts[workspace].writeSetHash) {
        outcomes.push({ workspace, ok: true, detail: 'write-set hash matches reviewed manifest' });
      } else {
        outcomes.push({
          workspace,
          ok: false,
          detail:
            'current read-only write set differs from the reviewed manifest; regenerate with dry-run',
        });
      }
    } catch (error) {
      outcomes.push({
        workspace,
        ok: false,
        detail: `preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return outcomes;
}

function reportPreflight(deps: EnrichmentOperatorDeps, outcomes: PreflightOutcome[]): number {
  deps.table(
    outcomes.map(({ workspace, ok, detail }) => ({
      workspace,
      preflight: ok ? 'PASS' : 'FAIL',
      detail,
    })),
  );
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}

interface ApplyOutcome {
  workspace: DemoWorkspaceKey;
  ok: boolean;
  detail: string;
}

/**
 * The real per-account runs, with STRICT FAILURE ISOLATION: each account is
 * wrapped in its own try/catch, so one account's failure never restarts,
 * invalidates, or blocks another's — a completed account stays completed.
 */
async function applyAccounts(
  deps: EnrichmentOperatorDeps,
  monitor: ProgressMonitor,
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
  workspaces: DemoWorkspaceKey[],
): Promise<ApplyOutcome[]> {
  const client = deps.buildClient('apply', monitor.signal);
  const outcomes: ApplyOutcome[] = [];
  for (const workspace of workspaces) {
    try {
      const result = await runOne({
        deps,
        client,
        monitor,
        workspace,
        uid: uids[workspace],
        sinceYear: manifest.sinceYear,
        dryRun: false,
      });
      outcomes.push({
        workspace,
        ok: true,
        detail:
          `run=${result.runId ?? 'none'} matched=${result.counts.resolvedMatched} ` +
          `attached=${result.counts.attachmentsCreated} projected=${result.counts.projectionsApplied} ` +
          `reconciled=${result.counts.projectionsReconciled}`,
      });
    } catch (error) {
      outcomes.push({
        workspace,
        ok: false,
        detail: `apply failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return outcomes;
}

function reportApply(deps: EnrichmentOperatorDeps, outcomes: ApplyOutcome[]): number {
  deps.table(
    outcomes.map(({ workspace, ok, detail }) => ({
      workspace,
      apply: ok ? 'OK' : 'FAILED',
      detail,
    })),
  );
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}

async function applyCommand(
  deps: EnrichmentOperatorDeps,
  monitor: ProgressMonitor,
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
  workspaces: DemoWorkspaceKey[],
  reapply: boolean,
): Promise<number> {
  // 30.2 sanctioned re-apply: a COMPLETED account is a stated no-op by
  // default — only the explicit `--reapply` flag opens the door to
  // re-running it (e.g. the mkleo/sparg0 top-up after the tenant-scoped
  // cache fix). The default protects a healthy completed account (the
  // Hungrybox contract) from an accidental re-run; the flagged path keeps
  // the full preflight discipline and relies on the store's idempotent
  // upserts, so a re-apply can only top up, never fork or duplicate.
  const toApply: DemoWorkspaceKey[] = [];
  const skipped: ApplyOutcome[] = [];
  for (const workspace of workspaces) {
    const run = await readEnrichmentRun(deps.database, uids[workspace]);
    if (run?.status === 'completed' && !reapply) {
      skipped.push({
        workspace,
        ok: true,
        detail: `already complete (run=${run.runId}); apply is a no-op — pass --reapply to re-run this account`,
      });
      continue;
    }
    toApply.push(workspace);
  }

  if (toApply.length === 0) {
    reportApply(deps, skipped);
    deps.log('Every scoped account is already complete; pass --reapply to re-run.');
    return 0;
  }

  const preflight = await preflightAccounts(deps, monitor, uids, manifest, toApply);
  const preflightCode = reportPreflight(deps, preflight);
  if (preflightCode !== 0) {
    deps.log('Apply refused: at least one account failed preflight. No write was performed.');
    return preflightCode;
  }
  deps.log('Read-only preflight matches every reviewed account write-set hash.');
  return reportApply(deps, [
    ...skipped,
    ...(await applyAccounts(deps, monitor, uids, manifest, toApply)),
  ]);
}

async function resumeCommand(
  deps: EnrichmentOperatorDeps,
  monitor: ProgressMonitor,
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
  workspaces: DemoWorkspaceKey[],
): Promise<number> {
  const toResume: DemoWorkspaceKey[] = [];
  const skipped: ApplyOutcome[] = [];
  const resumingAtProjection: DemoWorkspaceKey[] = [];
  for (const workspace of workspaces) {
    const run = await readEnrichmentRun(deps.database, uids[workspace]);
    if (run?.status === 'completed') {
      // The Hungrybox contract: a completed account's resume is a stated
      // no-op — it is never re-run and never invalidated.
      skipped.push({
        workspace,
        ok: true,
        detail: `already complete (run=${run.runId}); resume is a no-op`,
      });
      continue;
    }
    toResume.push(workspace);
    if (run?.status === 'running' && run.cursor?.stage === 'projection') {
      resumingAtProjection.push(workspace);
    }
  }

  if (toResume.length === 0) {
    reportApply(deps, skipped);
    deps.log('Every scoped account is already complete; nothing to resume.');
    return 0;
  }

  // Accounts resuming at the projection checkpoint issue no fetch at all —
  // preflighting them would spend network budget the resume itself does not
  // need. Everything else re-runs the gather phase and is preflighted first.
  const toPreflight = toResume.filter((workspace) => !resumingAtProjection.includes(workspace));
  if (toPreflight.length > 0) {
    const preflight = await preflightAccounts(deps, monitor, uids, manifest, toPreflight);
    const preflightCode = reportPreflight(deps, preflight);
    if (preflightCode !== 0) {
      deps.log('Resume refused: at least one resumable account failed preflight.');
      return preflightCode;
    }
  }

  const outcomes = await applyAccounts(deps, monitor, uids, manifest, toResume);
  return reportApply(deps, [...skipped, ...outcomes]);
}

async function compareCommand(
  deps: EnrichmentOperatorDeps,
  uids: DemoUidMap,
  manifest: EnrichmentManifest,
): Promise<number> {
  const after = {} as Record<DemoWorkspaceKey, EnrichmentCoverageMetrics>;
  for (const workspace of demoWorkspaceKeys) {
    after[workspace] = await readCoverageMetrics(deps.database, uids[workspace]);
  }
  deps.table(buildEnrichmentComparison(manifest, after) as unknown as object[]);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runEnrichmentOperator(
  argv: string[],
  deps: EnrichmentOperatorDeps,
): Promise<number> {
  const { command, flags } = parseOperatorArgs(argv);
  const uids = readUids(flags);
  const workspaces = scopedWorkspaces(flags);
  const maxAgeMs = positiveInteger(flags, '--max-age-ms', DEFAULT_MAX_AGE_MS);
  const maxStallMs = positiveInteger(flags, '--max-stall-ms', DEFAULT_MAX_STALL_MS);

  deps.log(`Database host: ${deps.databaseHost}`);
  deps.log(`Target UIDs: ${workspaces.map((key) => uids[key]).join(', ')}`);

  if (command === 'status') {
    return statusCommand(deps, uids, workspaces);
  }
  if (command === 'sweep') {
    // Zero network, no heartbeat/watchdog needed — a bounded read/remove
    // pass; prompt termination is the lifecycle wrapper's contract.
    return sweepCommand(deps, uids, workspaces);
  }

  const monitor = createProgressMonitor(deps, maxStallMs);
  try {
    if (command === 'dry-run') {
      return await dryRunCommand(
        deps,
        monitor,
        uids,
        positiveInteger(flags, '--since-year', DEFAULT_SINCE_YEAR),
        required(flags, '--manifest-out'),
      );
    }

    const manifest = await readVerifiedManifest(
      deps,
      required(flags, '--manifest-in'),
      uids,
      maxAgeMs,
    );
    if (manifest.databaseHost !== deps.databaseHost) {
      throw new Error('Manifest database host does not match the active database');
    }

    if (command === 'preflight') {
      return reportPreflight(
        deps,
        await preflightAccounts(deps, monitor, uids, manifest, workspaces),
      );
    }
    if (command === 'apply') {
      return await applyCommand(
        deps,
        monitor,
        uids,
        manifest,
        workspaces,
        flags.get('--reapply') === 'true',
      );
    }
    if (command === 'resume') {
      return await resumeCommand(deps, monitor, uids, manifest, workspaces);
    }
    return await compareCommand(deps, uids, manifest);
  } finally {
    monitor.dispose();
  }
}
