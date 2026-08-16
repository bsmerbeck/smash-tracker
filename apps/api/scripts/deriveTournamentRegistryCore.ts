import { join } from 'node:path';
import type { Database } from 'firebase-admin/database';
import {
  computeForeignRowDigest,
  describeForeignRowDigestDelta,
  type ForeignRowDigest,
} from '../src/research/registry/foreignDigest.js';
import { DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS } from '../src/research/registry/deadline.js';
import {
  applyTournamentRegistryPlan,
  planTournamentRegistry,
  type RegistryProgressEvent,
  type TournamentRegistryApplyResult,
  type TournamentRegistryPlan,
} from '../src/research/registry/reconcile.js';
import {
  createRegistryReceipt,
  REGISTRY_RECEIPT_FORMAT_VERSION,
  type RegistryCountSnapshot,
  type RegistryReceiptBody,
  type RegistryReceiptCommand,
  type RegistryReceiptStatus,
  type RegistryWriteLedger,
} from '../src/research/registry/receipt.js';
import {
  asRegistryWorkspaceKey,
  registryWorkspaceKeys,
  registryWorkspaceLabels,
  type RegistryUidMap,
  type RegistryWorkspaceKey,
} from '../src/research/registry/workspaces.js';
import {
  assessRegistryPreWriteGate,
  buildRegistryAccountManifest,
  buildRegistryComparisonRow,
  canonicalScope,
  classifyRegistryDrift,
  computeRegistryRowSetHash,
  createRegistryManifest,
  manifestScopedAccounts,
  REGISTRY_FROZEN_SOURCE_SET_COUNTS,
  REGISTRY_MANIFEST_FORMAT_VERSION,
  registryReviewedExceptionFileSchema,
  sourceCensusOf,
  validateRegistryManifest,
  type RegistryAccountManifest,
  type RegistryManifest,
  type RegistryReviewedException,
} from './registryManifestArtifact.js';

/**
 * Phase 30.3 registry-operator hardening (owner/Codex Gate-6 directive): the
 * tournament-registry operator CORE.
 *
 * The feature was green and the OPERATOR was not — it had none of the
 * hardening `enrichDemoAccounts*` earned across six production defects. This
 * module is the answer, built to the same shape: every subcommand
 * implemented against INJECTED dependencies (database, clock, log,
 * filesystem), so the whole operator is testable against `FakeDatabase` with
 * zero network and zero Firebase. The thin entry
 * (`deriveTournamentRegistry.ts`) wires the real world in and wraps
 * everything in `runWithLifecycle` (`enrichLifecycle.ts`), which owns the
 * termination guarantee.
 *
 * What the hardening consists of:
 * - ACCOUNT SCOPING (`--account <hbox|mkleo|sparg0|izaw>`). MANDATORY for
 *   `apply` (owner/Codex hard gate #4, B9): no production apply may mutate
 *   more than one account in a single invocation, so the unscoped form is
 *   refused outright with the correct per-account command in the message.
 *   `dry-run` and `compare` write nothing to the destination and keep the
 *   all-accounts form.
 * - THE SOURCE CENSUS FREEZE (hard gate #4, B8): preflight and compare carry
 *   the COMPLETE census — `sourceSetCount`, `corruptSourceRecords`, the three
 *   `skipped*` figures, collisions and orphan removals — and a change in any
 *   of them refuses/fails even when the derived-row hash is untouched. Corrupt
 *   records, collisions and a deviation from the owner-frozen `sourceSetCount`
 *   are PRE-WRITE refusals, liftable only by a reviewed exception embedded in
 *   the manifest (`dry-run --exceptions-in`), never by a flag on `apply`.
 * - A HEARTBEAT at least every `--heartbeat-ms` (default 30s) naming the
 *   account, stage, work unit and counters.
 * - A no-progress WATCHDOG (`--max-stall-ms`, default 5 min) that aborts.
 * - Per-operation RTDB DEADLINES (`--request-timeout-ms`, default 30s).
 * - A durable per-account RECEIPT on every terminal path — success, refusal
 *   and failure alike — recording database host, destination uid, manifest
 *   hash, before/after counts, the FOREIGN-ROW DIGEST pre- and post-apply,
 *   and the exact invariants that failed.
 * - NONZERO EXIT on every failed invariant.
 * - INTERRUPTED-RECOVERY SAFETY: a partially applied manifest is detected
 *   (its create/update classification no longer matches the destination)
 *   and REFUSED with instructions to regenerate, never "just re-run it".
 */

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_STALL_MS = 5 * 60 * 1000;

export const REGISTRY_OPERATOR_COMMANDS = ['dry-run', 'apply', 'compare'] as const;
export type RegistryOperatorCommand = (typeof REGISTRY_OPERATOR_COMMANDS)[number];

export interface RegistryOperatorDeps {
  database: Database;
  /** Database IDENTITY, pinned into the manifest and every receipt. */
  databaseHost: string;
  now: () => number;
  log: (line: string) => void;
  table: (rows: object[]) => void;
  readFileText: (path: string) => Promise<string>;
  writeFileText: (path: string, content: string) => Promise<void>;
  /** Overridable for tests; the CLI's `--heartbeat-ms` wins when supplied. */
  heartbeatIntervalMs?: number;
  /** The lifecycle's shutdown signal (SIGINT/SIGTERM). The operator chains its own stall abort onto it. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedRegistryArgs {
  command: RegistryOperatorCommand;
  flags: Map<string, string>;
}

export function parseRegistryArgs(argv: string[]): ParsedRegistryArgs {
  const [command, ...rest] = argv;
  if (!command || !(REGISTRY_OPERATOR_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Expected subcommand: ${REGISTRY_OPERATOR_COMMANDS.join(', ')}`);
  }
  const flags = new Map<string, string>();
  let index = 0;
  while (index < rest.length) {
    const name = rest[index];
    if (!name?.startsWith('--')) {
      throw new Error(`Invalid flag near ${name ?? '<end>'}`);
    }
    const value = rest[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Invalid flag near ${name}`);
    }
    flags.set(name, value);
    index += 2;
  }
  return { command: command as RegistryOperatorCommand, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
  }
  return value;
}

function readUids(flags: Map<string, string>): RegistryUidMap {
  const uids = {
    hbox: required(flags, '--hbox-uid'),
    mkleo: required(flags, '--mkleo-uid'),
    sparg0: required(flags, '--sparg0-uid'),
    izaw: required(flags, '--izaw-uid'),
  };
  if (new Set(Object.values(uids)).size !== registryWorkspaceKeys.length) {
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

/**
 * The account this invocation targets.
 *
 * `--account` is MANDATORY for `apply` (owner/Codex hard gate #4, B9). The
 * blast radius of a registry apply is one account's `tournamentEntries`
 * subtree, and the whole receipt/verify loop is built around inspecting that
 * one account's outcome before the next is touched; an unscoped apply
 * silently reinstates the "mutate everything in one go" posture that loop
 * exists to prevent. `dry-run` and `compare` write nothing to the
 * destination, so they keep the all-accounts form.
 */
function requestedWorkspace(
  flags: Map<string, string>,
  command: RegistryOperatorCommand,
): RegistryWorkspaceKey | null {
  const account = flags.get('--account');
  if (account == null) {
    if (command === 'apply') {
      throw new Error(
        'apply requires --account <hbox|mkleo|sparg0|izaw>: no production apply may mutate more than ' +
          'one account in a single invocation. Run it once per account, e.g.\n' +
          '  tsx scripts/deriveTournamentRegistry.ts apply --account hbox ' +
          '--hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> ' +
          '--manifest-in ./registry-manifest.hbox.json --receipt-dir ./receipts',
      );
    }
    return null;
  }
  const key = asRegistryWorkspaceKey(account);
  if (!key) {
    throw new Error(`--account must be one of ${registryWorkspaceKeys.join(', ')}`);
  }
  return key;
}

/**
 * The reviewed exceptions file, read ONLY by `dry-run`. Its contents are
 * embedded into (and sealed with) the manifest it produces — see
 * `registryReviewedExceptionSchema`. `apply` never reads this flag; the
 * authorization has to be in the artifact the owner reviewed.
 */
async function readReviewedExceptions(
  deps: RegistryOperatorDeps,
  path: string | undefined,
): Promise<Partial<Record<RegistryWorkspaceKey, RegistryReviewedException>>> {
  if (path == null) {
    return {};
  }
  return registryReviewedExceptionFileSchema.parse(JSON.parse(await deps.readFileText(path)));
}

// ---------------------------------------------------------------------------
// Progress monitor — heartbeat + stall watchdog
// ---------------------------------------------------------------------------

interface ProgressMonitor {
  onProgress: (workspace: RegistryWorkspaceKey, event: RegistryProgressEvent) => void;
  /** Records a non-projector stage (manifest read, receipt write) so the watchdog does not fire during honest work. */
  mark: (workspace: RegistryWorkspaceKey | null, stage: string, unit: string) => void;
  stalledReason: () => string | null;
  dispose: () => void;
  /** Aborts when the watchdog trips OR the lifecycle signal fires. */
  signal: AbortSignal;
  /** Rejects when the watchdog trips — raced against long work so a stall fails the command even when nothing abortable is in flight. */
  stallPromise: Promise<never>;
}

function createProgressMonitor(
  deps: RegistryOperatorDeps,
  heartbeatIntervalMs: number,
  maxStallMs: number,
): ProgressMonitor {
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
  // A stall can trip while nothing is racing against it (e.g. during manifest
  // validation) — pre-attach a swallow handler so that rejection is never
  // "unhandled"; the abort signal carries the failure to whatever is in flight.
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
    Math.max(100, Math.min(heartbeatIntervalMs, Math.floor(maxStallMs / 4))),
  );
  watchdog.unref?.();

  return {
    onProgress: (workspace, event) => {
      last = {
        account: workspace,
        stage: event.stage,
        unit: event.unit ?? '-',
        summary:
          `sourceRecords=${event.counts.sourceRecords} derived=${event.counts.derivedRows} ` +
          `plannedWrites=${event.counts.plannedWrites} plannedRemovals=${event.counts.plannedRemovals} ` +
          `written=${event.counts.written} removed=${event.counts.removed} ` +
          `abortedForeign=${event.counts.abortedForeign}`,
        atMs: deps.now(),
      };
    },
    mark: (workspace, stage, unit) => {
      last = { account: workspace ?? '-', stage, unit, summary: '', atMs: deps.now() };
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
// Receipts
// ---------------------------------------------------------------------------

function emptySnapshot(): RegistryCountSnapshot {
  return {
    entryChildren: 0,
    registryOwnedRows: 0,
    foreignRows: 0,
    sourceSets: 0,
    corruptSourceRecords: 0,
    derivedRows: 0,
    creates: 0,
    updates: 0,
    unchanged: 0,
    collisions: 0,
    orphanRemovals: 0,
  };
}

function snapshotFromPlan(plan: TournamentRegistryPlan): RegistryCountSnapshot {
  return {
    entryChildren: plan.entryChildCount,
    registryOwnedRows: plan.ownedRowCount,
    foreignRows: plan.preservedForeignCount,
    sourceSets: plan.sourceSetCount,
    corruptSourceRecords: plan.corruptSourceRecords,
    derivedRows: plan.derivedRows.length,
    creates: plan.creates.length,
    updates: plan.updates.length,
    unchanged: plan.unchanged.length,
    collisions: plan.collisions.length,
    orphanRemovals: plan.orphanRemovals.length,
  };
}

function ledgerOf(result: TournamentRegistryApplyResult): RegistryWriteLedger {
  return {
    written: result.written,
    removed: result.removed,
    abortedForeign: result.abortedForeign,
    writesPerformed: result.writesPerformed,
  };
}

interface ReceiptDraft {
  command: RegistryReceiptCommand;
  workspace: RegistryWorkspaceKey;
  uid: string;
  startedAtMs: number;
  manifestContentHash: string | null;
  manifestGeneratedAtMs: number | null;
  reviewedRowSetHash: string | null;
  observedRowSetHash: string;
  before: RegistryCountSnapshot;
  after: RegistryCountSnapshot;
  foreignDigestBefore: ForeignRowDigest;
  foreignDigestAfter: ForeignRowDigest;
  failedInvariants: string[];
  /** `refused` when the failure happened BEFORE any write; `failed` otherwise. Ignored when there are no failures. */
  failureStatus: Extract<RegistryReceiptStatus, 'refused' | 'failed'>;
  writes: RegistryWriteLedger | null;
}

/**
 * Writes the durable receipt and REPORTS ITS PATH. Called on every terminal
 * path for every scoped account; a run that produced no receipt is, by
 * construction, a bug rather than a silent success.
 */
async function writeReceipt(
  deps: RegistryOperatorDeps,
  receiptDir: string,
  draft: ReceiptDraft,
): Promise<string> {
  const body: RegistryReceiptBody = {
    formatVersion: REGISTRY_RECEIPT_FORMAT_VERSION,
    command: draft.command,
    workspace: draft.workspace,
    label: registryWorkspaceLabels[draft.workspace],
    databaseHost: deps.databaseHost,
    uid: draft.uid,
    manifestContentHash: draft.manifestContentHash,
    manifestGeneratedAtMs: draft.manifestGeneratedAtMs,
    reviewedRowSetHash: draft.reviewedRowSetHash,
    observedRowSetHash: draft.observedRowSetHash,
    startedAtMs: draft.startedAtMs,
    finishedAtMs: deps.now(),
    status: draft.failedInvariants.length === 0 ? 'ok' : draft.failureStatus,
    failedInvariants: draft.failedInvariants,
    before: draft.before,
    after: draft.after,
    foreignDigestBefore: draft.foreignDigestBefore,
    foreignDigestAfter: draft.foreignDigestAfter,
    foreignDigestStable: draft.foreignDigestBefore.digest === draft.foreignDigestAfter.digest,
    writes: draft.writes,
  };
  const receipt = createRegistryReceipt(body);
  const path = join(
    receiptDir,
    `registry-receipt-${draft.command}-${draft.workspace}-${draft.startedAtMs}.json`,
  );
  await deps.writeFileText(path, `${JSON.stringify(receipt, null, 2)}\n`);
  deps.log(`[receipt] ${draft.workspace}: status=${receipt.status} path=${path}`);
  return path;
}

// ---------------------------------------------------------------------------
// Shared plan helper
// ---------------------------------------------------------------------------

interface RunContext {
  deps: RegistryOperatorDeps;
  monitor: ProgressMonitor;
  requestTimeoutMs: number;
  uids: RegistryUidMap;
  receiptDir: string;
}

/** A read-only plan, bounded by the request deadline and raced against the stall watchdog. */
async function planFor(
  context: RunContext,
  workspace: RegistryWorkspaceKey,
): Promise<TournamentRegistryPlan> {
  return Promise.race([
    planTournamentRegistry(context.deps.database, context.uids[workspace], context.deps.now(), {
      requestTimeoutMs: context.requestTimeoutMs,
      signal: context.monitor.signal,
      onProgress: (event) => context.monitor.onProgress(workspace, event),
    }),
    context.monitor.stallPromise,
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

async function dryRunCommand(
  context: RunContext,
  workspaces: RegistryWorkspaceKey[],
  manifestPath: string,
  exceptions: Partial<Record<RegistryWorkspaceKey, RegistryReviewedException>>,
): Promise<number> {
  const { deps } = context;
  const generatedAtMs = deps.now();
  const accounts: Partial<Record<RegistryWorkspaceKey, RegistryAccountManifest>> = {};
  const summary: object[] = [];
  let failures = 0;

  for (const workspace of workspaces) {
    const uid = context.uids[workspace];
    const startedAtMs = deps.now();
    try {
      const plan = await planFor(context, workspace);
      const account = buildRegistryAccountManifest(
        registryWorkspaceLabels[workspace],
        plan,
        exceptions[workspace],
      );
      accounts[workspace] = account;
      // Report the pre-write gate NOW, while the owner is reviewing, rather
      // than letting them discover the refusal at apply time. dry-run writes
      // nothing, so this is a warning and not a failure.
      const gate = assessRegistryPreWriteGate(workspace, account, sourceCensusOf(plan));
      if (!gate.ok) {
        deps.log(`[pre-write-gate] ${gate.kind}: ${gate.message}`);
      }
      const snapshot = snapshotFromPlan(plan);
      await writeReceipt(context.deps, context.receiptDir, {
        command: 'dry-run',
        workspace,
        uid,
        startedAtMs,
        manifestContentHash: null,
        manifestGeneratedAtMs: null,
        reviewedRowSetHash: null,
        observedRowSetHash: account.rowSetHash,
        // A dry-run performs no write; before and after are the same census
        // by construction, which is exactly the evidence `writesPerformed: 0`
        // claims structurally.
        before: snapshot,
        after: snapshot,
        foreignDigestBefore: plan.foreignDigest,
        foreignDigestAfter: plan.foreignDigest,
        failedInvariants: [],
        failureStatus: 'failed',
        writes: null,
      });
      summary.push({
        workspace,
        sourceSets: plan.sourceSetCount,
        frozenSourceSets: REGISTRY_FROZEN_SOURCE_SET_COUNTS[workspace],
        derivedRows: plan.derivedRows.length,
        creates: plan.creates.length,
        updates: plan.updates.length,
        unchanged: plan.unchanged.length,
        orphanRemovals: plan.orphanRemovals.length,
        collisions: plan.collisions.length,
        foreignPreserved: plan.preservedForeignCount,
        foreignDigest: plan.foreignDigest.digest.slice(0, 12),
        corruptSourceRecords: plan.corruptSourceRecords,
        skippedNoEventId: plan.skippedNoEventId,
        skippedUnsafeEventId: plan.skippedUnsafeEventId,
        skippedExcludedClassification: plan.skippedExcludedClassification,
        preWriteGate: gate.kind,
      });
    } catch (error) {
      failures += 1;
      const detail = `dry-run failed for ${workspace}: ${errorMessage(error)}`;
      deps.log(detail);
      await writeReceipt(context.deps, context.receiptDir, {
        command: 'dry-run',
        workspace,
        uid,
        startedAtMs,
        manifestContentHash: null,
        manifestGeneratedAtMs: null,
        reviewedRowSetHash: null,
        observedRowSetHash: computeRegistryRowSetHash(uid, []),
        before: emptySnapshot(),
        after: emptySnapshot(),
        foreignDigestBefore: computeForeignRowDigest(uid, {}),
        foreignDigestAfter: computeForeignRowDigest(uid, {}),
        failedInvariants: [detail],
        failureStatus: 'failed',
        writes: null,
      });
      summary.push({ workspace, dryRun: 'FAILED', detail });
    }
  }

  deps.table(summary);
  if (failures > 0) {
    deps.log(`dry-run: ${failures} account(s) failed; NO manifest was written.`);
    return 1;
  }

  const manifest = createRegistryManifest({
    formatVersion: REGISTRY_MANIFEST_FORMAT_VERSION,
    generatedAtMs,
    databaseHost: deps.databaseHost,
    targetUids: context.uids,
    scope: canonicalScope(workspaces),
    writesPerformed: 0,
    accounts,
  });
  await deps.writeFileText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  deps.log(`Zero writes performed. Scope: ${manifest.scope.join(', ')}. Manifest: ${manifestPath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

interface PreflightEntry {
  workspace: RegistryWorkspaceKey;
  reviewed: RegistryAccountManifest;
  plan: TournamentRegistryPlan | null;
  fresh: RegistryAccountManifest | null;
  kind: string;
  ok: boolean;
  message: string;
  startedAtMs: number;
}

/**
 * Read-only preflight over EVERY scoped account before any write happens, so
 * a drift on the last account can never leave the earlier ones half-applied.
 * Since B9 an apply is always exactly one account, which is the posture the
 * owner directive asks for.
 *
 * TWO independent gates, both of which must pass:
 *  1. `classifyRegistryDrift` — does the fresh plan still match the manifest
 *     the owner reviewed (foreign rows, derived rows, THE FULL CENSUS, and
 *     the action buckets)?
 *  2. `assessRegistryPreWriteGate` — is the fresh census something this
 *     operator is allowed to apply AT ALL (frozen `sourceSetCount`, corrupt
 *     source records, collisions), or does it need a reviewed exception?
 *
 * They are separate because they answer different questions. A run can match
 * its manifest perfectly and still be unapplyable — that is exactly the case
 * where the dry-run and the apply both see the same 412 corrupt records.
 */
async function preflight(
  context: RunContext,
  scoped: { workspace: RegistryWorkspaceKey; account: RegistryAccountManifest }[],
): Promise<PreflightEntry[]> {
  const entries: PreflightEntry[] = [];
  for (const { workspace, account } of scoped) {
    const startedAtMs = context.deps.now();
    try {
      const plan = await planFor(context, workspace);
      // Built WITHOUT the reviewed exception on purpose: `fresh` is the
      // unvarnished observation the drift check compares against, and the
      // exception is an authorization, not an observation. The gate below is
      // where the reviewed exception gets its say.
      const fresh = buildRegistryAccountManifest(registryWorkspaceLabels[workspace], plan);
      const drift = classifyRegistryDrift(workspace, account, fresh);
      const gate = assessRegistryPreWriteGate(workspace, account, sourceCensusOf(plan));
      const verdict = drift.safeToApply
        ? { kind: gate.kind, safeToApply: gate.ok, message: gate.message }
        : drift;
      entries.push({
        workspace,
        reviewed: account,
        plan,
        fresh,
        kind: verdict.kind,
        ok: verdict.safeToApply,
        message: verdict.message,
        startedAtMs,
      });
    } catch (error) {
      entries.push({
        workspace,
        reviewed: account,
        plan: null,
        fresh: null,
        kind: 'preflight-error',
        ok: false,
        message: `preflight failed for ${workspace}: ${errorMessage(error)}`,
        startedAtMs,
      });
    }
  }
  return entries;
}

async function applyCommand(
  context: RunContext,
  manifest: RegistryManifest,
  scoped: { workspace: RegistryWorkspaceKey; account: RegistryAccountManifest }[],
): Promise<number> {
  const { deps } = context;
  const entries = await preflight(context, scoped);
  deps.table(
    entries.map(({ workspace, ok, kind, message }) => ({
      workspace,
      preflight: ok ? 'PASS' : 'REFUSE',
      kind,
      detail: message,
    })),
  );

  if (!entries.every((entry) => entry.ok)) {
    for (const entry of entries.filter((candidate) => !candidate.ok)) {
      deps.log(entry.message);
      const snapshot = entry.plan ? snapshotFromPlan(entry.plan) : emptySnapshot();
      const digest = entry.plan
        ? entry.plan.foreignDigest
        : computeForeignRowDigest(entry.reviewed.uid, {});
      await writeReceipt(context.deps, context.receiptDir, {
        command: 'apply',
        workspace: entry.workspace,
        uid: entry.reviewed.uid,
        startedAtMs: entry.startedAtMs,
        manifestContentHash: manifest.contentHash,
        manifestGeneratedAtMs: manifest.generatedAtMs,
        reviewedRowSetHash: entry.reviewed.rowSetHash,
        observedRowSetHash:
          entry.fresh?.rowSetHash ?? computeRegistryRowSetHash(entry.reviewed.uid, []),
        before: snapshot,
        after: snapshot,
        foreignDigestBefore: digest,
        foreignDigestAfter: digest,
        failedInvariants: [`${entry.kind}: ${entry.message}`],
        failureStatus: 'refused',
        writes: null,
      });
    }
    deps.log('Apply refused. NOTHING was written. See the refusal message(s) above.');
    return 1;
  }
  deps.log(
    `Read-only preflight matches the reviewed manifest for: ${entries.map((entry) => entry.workspace).join(', ')}.`,
  );

  // One account at a time: apply, then immediately re-plan and verify it
  // before the next account is touched. A failure stops the run — a foreign
  // abort or a changed foreign digest means something else is writing, and
  // pressing on would multiply the damage.
  const results: object[] = [];
  for (const entry of entries) {
    const plan = entry.plan!;
    const fresh = entry.fresh!;
    const startedAtMs = deps.now();
    const before = snapshotFromPlan(plan);
    const foreignBefore = plan.foreignDigest;
    const failedInvariants: string[] = [];
    let ledger: RegistryWriteLedger | null = null;
    let after = before;
    let foreignAfter = foreignBefore;
    let observedRowSetHash = fresh.rowSetHash;

    try {
      const result = await Promise.race([
        applyTournamentRegistryPlan(deps.database, plan, {
          requestTimeoutMs: context.requestTimeoutMs,
          signal: context.monitor.signal,
          onProgress: (event) => context.monitor.onProgress(entry.workspace, event),
        }),
        context.monitor.stallPromise,
      ]);
      ledger = ledgerOf(result);
      if (result.abortedForeign.length > 0) {
        failedInvariants.push(
          `foreign-abort: ${result.abortedForeign.length} planned write/delete(s) aborted because a ` +
            `foreign value was present at commit time (${result.abortedForeign.join(', ')}). Nothing was clobbered, ` +
            'but the exact apply did not complete.',
        );
      }

      // POST-APPLY VERIFICATION, from a fresh read of the destination.
      const verification = await planFor(context, entry.workspace);
      after = snapshotFromPlan(verification);
      foreignAfter = verification.foreignDigest;
      observedRowSetHash = computeRegistryRowSetHash(verification.uid, verification.derivedRows);

      if (foreignAfter.digest !== foreignBefore.digest) {
        failedInvariants.push(
          `foreign-row-digest changed across the apply: ${describeForeignRowDigestDelta(foreignBefore, foreignAfter)}. ` +
            'A non-registry entry was modified — this must never happen.',
        );
      }
      if (observedRowSetHash !== entry.reviewed.rowSetHash) {
        failedInvariants.push(
          'post-apply row set no longer hashes to the reviewed manifest row set.',
        );
      }
      if (
        verification.creates.length > 0 ||
        verification.updates.length > 0 ||
        verification.orphanRemovals.length > 0
      ) {
        failedInvariants.push(
          `post-apply plan is not settled: creates=${verification.creates.length} ` +
            `updates=${verification.updates.length} removals=${verification.orphanRemovals.length}.`,
        );
      }
      if (verification.collisions.length !== entry.reviewed.collisions.length) {
        failedInvariants.push(
          `post-apply collision count changed (reviewed=${entry.reviewed.collisions.length} ` +
            `observed=${verification.collisions.length}).`,
        );
      }
    } catch (error) {
      failedInvariants.push(`apply failed for ${entry.workspace}: ${errorMessage(error)}`);
    }

    await writeReceipt(context.deps, context.receiptDir, {
      command: 'apply',
      workspace: entry.workspace,
      uid: entry.reviewed.uid,
      startedAtMs,
      manifestContentHash: manifest.contentHash,
      manifestGeneratedAtMs: manifest.generatedAtMs,
      reviewedRowSetHash: entry.reviewed.rowSetHash,
      observedRowSetHash,
      before,
      after,
      foreignDigestBefore: foreignBefore,
      foreignDigestAfter: foreignAfter,
      failedInvariants,
      failureStatus: 'failed',
      writes: ledger,
    });

    results.push({
      workspace: entry.workspace,
      apply: failedInvariants.length === 0 ? 'OK' : 'FAILED',
      written: ledger?.written.length ?? 0,
      removed: ledger?.removed.length ?? 0,
      abortedForeign: ledger?.abortedForeign.length ?? 0,
      foreignDigestStable: foreignAfter.digest === foreignBefore.digest,
      detail: failedInvariants.join(' | ') || 'applied and verified',
    });

    if (failedInvariants.length > 0) {
      deps.table(results);
      for (const invariant of failedInvariants) {
        deps.log(`[invariant] ${entry.workspace}: ${invariant}`);
      }
      deps.log(
        `Apply STOPPED after ${entry.workspace}. Remaining accounts were not touched. ` +
          'Regenerate a fresh manifest with dry-run before any further apply.',
      );
      return 1;
    }
  }

  deps.table(results);
  deps.log('Apply complete: every scoped account applied and verified.');
  return 0;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

async function compareCommand(
  context: RunContext,
  manifest: RegistryManifest,
  scoped: { workspace: RegistryWorkspaceKey; account: RegistryAccountManifest }[],
): Promise<number> {
  const { deps } = context;
  const rows: object[] = [];
  let mismatches = 0;

  for (const { workspace, account } of scoped) {
    const startedAtMs = deps.now();
    try {
      const plan = await planFor(context, workspace);
      const row = buildRegistryComparisonRow(workspace, account, plan);
      rows.push(row);
      const failedInvariants = row.exactMatch
        ? []
        : [
            `compare mismatch for ${workspace}: rowSetMatches=${row.rowSetMatches} ` +
              `foreignDigestMatches=${row.foreignDigestMatches} censusMatches=${row.censusMatches} ` +
              `frozenCensusOk=${row.frozenCensusOk} pendingCreates=${row.pendingCreates} ` +
              `pendingUpdates=${row.pendingUpdates} pendingRemovals=${row.pendingRemovals} ` +
              `collisions=${row.collisions}` +
              (row.censusDelta.length > 0 ? ` censusDelta=[${row.censusDelta.join('; ')}]` : ''),
          ];
      if (failedInvariants.length > 0) {
        mismatches += 1;
      }
      const snapshot = snapshotFromPlan(plan);
      await writeReceipt(context.deps, context.receiptDir, {
        command: 'compare',
        workspace,
        uid: account.uid,
        startedAtMs,
        manifestContentHash: manifest.contentHash,
        manifestGeneratedAtMs: manifest.generatedAtMs,
        reviewedRowSetHash: account.rowSetHash,
        observedRowSetHash: computeRegistryRowSetHash(plan.uid, plan.derivedRows),
        before: snapshot,
        after: snapshot,
        foreignDigestBefore: plan.foreignDigest,
        foreignDigestAfter: plan.foreignDigest,
        failedInvariants,
        failureStatus: 'failed',
        writes: null,
      });
    } catch (error) {
      mismatches += 1;
      const detail = `compare failed for ${workspace}: ${errorMessage(error)}`;
      deps.log(detail);
      rows.push({ workspace, compare: 'FAILED', detail });
      await writeReceipt(context.deps, context.receiptDir, {
        command: 'compare',
        workspace,
        uid: account.uid,
        startedAtMs,
        manifestContentHash: manifest.contentHash,
        manifestGeneratedAtMs: manifest.generatedAtMs,
        reviewedRowSetHash: account.rowSetHash,
        observedRowSetHash: computeRegistryRowSetHash(account.uid, []),
        before: emptySnapshot(),
        after: emptySnapshot(),
        foreignDigestBefore: computeForeignRowDigest(account.uid, {}),
        foreignDigestAfter: computeForeignRowDigest(account.uid, {}),
        failedInvariants: [detail],
        failureStatus: 'failed',
        writes: null,
      });
    }
  }

  deps.table(rows);
  if (mismatches > 0) {
    deps.log(
      `compare: ${mismatches} scoped account(s) do not exactly match the reviewed manifest.`,
    );
    return 1;
  }
  deps.log('compare: every scoped account exactly matches the reviewed manifest.');
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runRegistryOperator(
  argv: string[],
  deps: RegistryOperatorDeps,
): Promise<number> {
  const { command, flags } = parseRegistryArgs(argv);
  const uids = readUids(flags);
  const account = requestedWorkspace(flags, command);
  const maxAgeMs = positiveInteger(flags, '--max-age-ms', DEFAULT_MAX_AGE_MS);
  const maxStallMs = positiveInteger(flags, '--max-stall-ms', DEFAULT_MAX_STALL_MS);
  const requestTimeoutMs = positiveInteger(
    flags,
    '--request-timeout-ms',
    DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
  );
  const heartbeatIntervalMs = positiveInteger(
    flags,
    '--heartbeat-ms',
    deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const receiptDir = flags.get('--receipt-dir') ?? '.';

  deps.log(`Database host: ${deps.databaseHost}`);
  deps.log(`Scope: ${account ?? 'all accounts'}`);
  deps.log(
    `Bounds: requestTimeoutMs=${requestTimeoutMs} maxStallMs=${maxStallMs} heartbeatMs=${heartbeatIntervalMs}`,
  );

  const monitor = createProgressMonitor(deps, heartbeatIntervalMs, maxStallMs);
  const context: RunContext = { deps, monitor, requestTimeoutMs, uids, receiptDir };

  try {
    if (command === 'dry-run') {
      const workspaces = account ? [account] : [...registryWorkspaceKeys];
      deps.log(`Target UIDs: ${workspaces.map((key) => uids[key]).join(', ')}`);
      monitor.mark(account, 'read-exceptions', flags.get('--exceptions-in') ?? '<none>');
      const exceptions = await readReviewedExceptions(deps, flags.get('--exceptions-in'));
      return await dryRunCommand(
        context,
        workspaces,
        required(flags, '--manifest-out'),
        exceptions,
      );
    }

    monitor.mark(account, 'read-manifest', required(flags, '--manifest-in'));
    const manifest = validateRegistryManifest(
      JSON.parse(await deps.readFileText(required(flags, '--manifest-in'))),
      uids,
      deps.now(),
      maxAgeMs,
    );
    if (manifest.databaseHost !== deps.databaseHost) {
      throw new Error(
        `Manifest database host (${manifest.databaseHost}) does not match the active database (${deps.databaseHost})`,
      );
    }
    const all = manifestScopedAccounts(manifest);
    const scoped = account ? all.filter((entry) => entry.workspace === account) : all;
    if (scoped.length === 0) {
      throw new Error(
        `Manifest scope [${manifest.scope.join(',')}] does not cover --account ${account}; ` +
          'run dry-run for that account and review its manifest first',
      );
    }
    deps.log(`Target UIDs: ${scoped.map((entry) => entry.account.uid).join(', ')}`);

    if (command === 'apply') {
      return await applyCommand(context, manifest, scoped);
    }
    return await compareCommand(context, manifest, scoped);
  } finally {
    monitor.dispose();
  }
}
