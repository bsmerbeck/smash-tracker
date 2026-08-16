/**
 * Phase 30.3 Gate 6: the committed acceptance-oracle CLI.
 *
 * Replaces the ad-hoc, untracked `gate2PostconditionProbe.ts` that the
 * owner/Codex hard gate rejected. All logic lives in the unit-tested
 * `./gate6AuditCore.ts`; this file is the thin I/O shell — argument parsing,
 * the receipt/baseline files, and the process lifecycle — exactly the
 * shape `deriveTournamentRegistry.ts` and `migrateDemoAccounts.ts` use.
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/gate6Audit.ts \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     [--baseline ./gate6-baseline.json] [--out ./gate6-receipt.json] \
 *     [--registry-receipt ./receipt-hbox.json]... \
 *     [--registry-manifest ./registry-manifest.hbox.json]... \
 *     [--rejected-operation-probe ./probe-hbox.json]... \
 *     [--require-registry-receipt] [--require-rejected-operation-probe] \
 *     [--require-baseline] [--strict-witness-observation-refs] [--quiet] \
 *     [--request-timeout-ms 30000] [--max-stall-ms 300000] [--heartbeat-ms 30000] \
 *     [--max-receipt-age-ms 86400000] [--max-probe-age-ms 86400000]
 *
 * EXIT CODE IS THE VERDICT: `0` only when every assertion holds; `1` on ANY
 * mismatch, on a malformed baseline, and on any unexpected error. The JSON
 * receipt is written (and, unless `--quiet`, printed to stdout) on both
 * paths, so a failing run is still fully diagnosable.
 *
 * BASELINE FLAGS, the pre/post digest mechanism:
 * - `--baseline <path>` with a file that does NOT exist -> RECORD mode: the
 *   observed digests are written to that path. Run this BEFORE the operation
 *   under test.
 * - `--baseline <path>` with an existing file -> COMPARE mode: the observed
 *   digests must equal the recorded ones. Run this AFTER.
 * - `--require-baseline` refuses to run in record mode. A Gate-6 acceptance
 *   run should always pass it, so an accidentally-missing baseline file can
 *   never turn the preservation assertions into a silent no-op.
 *
 * REGISTRY ATTESTATION (assertion 12), the cross-tool seam:
 * - `--registry-receipt <path>` is REPEATABLE — one per account. Each file is
 *   matched to its workspace by its OWN sealed `workspace` member, so the
 *   flags need no per-account variants and a mislabelled file is caught by
 *   the uid cross-check rather than silently accepted. Since hard gate #4 the
 *   attestation requires a COMPARE receipt: an apply observes its own
 *   post-state, whereas compare is an independent later read.
 * - `--registry-manifest <path>` is REPEATABLE and now REQUIRED alongside the
 *   receipts: the audit checks that each receipt names the exact manifest the
 *   owner is reviewing, and that the LIVE generated rows still hash to it.
 * - Supplying no receipt SKIPS the assertion: `status: 'skipped'` with a
 *   `skipReason`, visible in the JSON and in the terminal, and counted in the
 *   receipt's `skippedCount`. Skipped is never rendered as passed.
 * - `--require-registry-receipt` turns absence — and partial coverage of the
 *   four accounts — into findings, mirroring `--require-baseline`.
 *
 * REJECTED-OPERATION PROBES (assertion 10):
 * - `--rejected-operation-probe <path>` is REPEATABLE. Each sealed probe
 *   records one REFUSED operation and the bounded trace snapshots taken
 *   immediately before and after it; the audit requires them to be identical.
 *   See the assertion-10 contract in `gate6AuditCore.ts` for why this replaced
 *   the old lifetime-absence scan, which failed a healthy system.
 * - `--require-rejected-operation-probe` mirrors the receipt flag.
 *
 * BOUNDED EXECUTION. Every RTDB read carries `--request-timeout-ms`, a
 * heartbeat prints progress every `--heartbeat-ms`, and a no-progress
 * watchdog aborts after `--max-stall-ms`. A hung read therefore reaches a
 * terminal result instead of hanging the gate — which is also what arms
 * `runWithLifecycle`'s hard-exit backstop, since that only starts once the run
 * settles.
 *
 * This script performs READS ONLY — it constructs no write of any kind.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import {
  GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
  GATE6_DEFAULT_MAX_PROBE_AGE_MS,
  GATE6_DEFAULT_MAX_RECEIPT_AGE_MS,
  GATE6_DEFAULT_MAX_STALL_MS,
  GATE6_WORKSPACE_KEYS,
  parseGate6Baseline,
  runGate6Audit,
  type Gate6AuditReceipt,
  type Gate6Baseline,
  type Gate6RegistryManifestInput,
  type Gate6RegistryReceiptInput,
  type Gate6RejectedOperationProbeInput,
  type Gate6UidMap,
} from './gate6AuditCore.js';
import { DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS } from '../src/research/registry/deadline.js';

interface ParsedArgs {
  uids: Gate6UidMap;
  baselinePath: string | null;
  outPath: string | null;
  /** Repeatable: one registry-operator receipt file per account. */
  registryReceiptPaths: string[];
  /** Repeatable: the reviewed manifests those receipts must name. */
  registryManifestPaths: string[];
  /** Repeatable: one sealed rejected-operation probe per refused call. */
  rejectedOperationProbePaths: string[];
  requireBaseline: boolean;
  requireRegistryReceipts: boolean;
  requireRejectedOperationProbes: boolean;
  strictWitnessObservationRefs: boolean;
  quiet: boolean;
  requestTimeoutMs: number;
  maxStallMs: number;
  heartbeatIntervalMs: number;
  maxReceiptAgeMs: number;
  maxProbeAgeMs: number;
}

const BOOLEAN_FLAGS = new Set([
  '--require-baseline',
  '--require-registry-receipt',
  '--require-rejected-operation-probe',
  '--strict-witness-observation-refs',
  '--quiet',
]);

/** Flags that may appear more than once; every occurrence is kept. */
const REPEATABLE_FLAGS = new Set([
  '--registry-receipt',
  '--registry-manifest',
  '--rejected-operation-probe',
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === undefined || !name.startsWith('--')) {
      throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      switches.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Flag ${name} expects a value`);
    }
    if (REPEATABLE_FLAGS.has(name)) {
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
    } else {
      flags.set(name, value);
    }
    index += 1;
  }

  const uids = {
    hbox: required(flags, '--hbox-uid'),
    mkleo: required(flags, '--mkleo-uid'),
    sparg0: required(flags, '--sparg0-uid'),
    izaw: required(flags, '--izaw-uid'),
  };
  if (new Set(Object.values(uids)).size !== GATE6_WORKSPACE_KEYS.length) {
    throw new Error('Every demo account UID must be unique');
  }

  return {
    uids,
    baselinePath: flags.get('--baseline') ?? null,
    outPath: flags.get('--out') ?? null,
    registryReceiptPaths: repeated.get('--registry-receipt') ?? [],
    registryManifestPaths: repeated.get('--registry-manifest') ?? [],
    rejectedOperationProbePaths: repeated.get('--rejected-operation-probe') ?? [],
    requireBaseline: switches.has('--require-baseline'),
    requireRegistryReceipts: switches.has('--require-registry-receipt'),
    requireRejectedOperationProbes: switches.has('--require-rejected-operation-probe'),
    strictWitnessObservationRefs: switches.has('--strict-witness-observation-refs'),
    quiet: switches.has('--quiet'),
    requestTimeoutMs: positiveInteger(
      flags,
      '--request-timeout-ms',
      DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
    ),
    maxStallMs: positiveInteger(flags, '--max-stall-ms', GATE6_DEFAULT_MAX_STALL_MS),
    heartbeatIntervalMs: positiveInteger(
      flags,
      '--heartbeat-ms',
      GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    maxReceiptAgeMs: positiveInteger(
      flags,
      '--max-receipt-age-ms',
      GATE6_DEFAULT_MAX_RECEIPT_AGE_MS,
    ),
    maxProbeAgeMs: positiveInteger(flags, '--max-probe-age-ms', GATE6_DEFAULT_MAX_PROBE_AGE_MS),
  };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
  }
  return value;
}

function positiveInteger(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Reads the baseline, or `null` when the path is absent/unset. A malformed file THROWS. */
async function loadBaseline(path: string | null): Promise<Gate6Baseline | null> {
  if (path === null) {
    return null;
  }
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return parseGate6Baseline(JSON.parse(contents));
}

/**
 * Reads each evidence file as raw JSON. Validation is the CORE's job (a
 * tampered seal must be a FINDING in the audit output, not a shell crash), so
 * this only surfaces I/O and JSON-syntax problems — and even those are handed
 * on as an unparseable `raw` rather than thrown, so one bad file cannot hide
 * the other assertions.
 */
async function loadEvidence(
  kind: string,
  paths: string[],
): Promise<{ path: string; raw: unknown }[]> {
  const inputs: { path: string; raw: unknown }[] = [];
  for (const path of paths) {
    try {
      inputs.push({ path, raw: JSON.parse(await readFile(path, 'utf8')) });
    } catch (error) {
      console.error(
        `${kind} ${path} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      inputs.push({ path, raw: null });
    }
  }
  return inputs;
}

function summarize(receipt: Gate6AuditReceipt): void {
  console.table(
    receipt.observed.map((row) => ({
      workspace: row.label,
      matches: row.matches,
      observations: row.observations,
      receipts: row.receipts,
      attachments: row.attachments,
      charWitnesses: row.characterWitnesses,
      stockWitnesses: row.stockWitnesses,
      registryRows: row.registryOwnedRows,
      run: row.enrichmentRunStatus ?? '-',
    })),
  );
  console.table(
    receipt.assertions.map((assertion) => ({
      assertion: assertion.id,
      status: assertion.status,
      inspected: assertion.inspected,
      findings: assertion.findings.length,
    })),
  );
  if (receipt.registryReceipts.length > 0) {
    console.table(
      receipt.registryReceipts.map((row) => ({
        path: row.path,
        valid: row.valid,
        workspace: row.workspace ?? '-',
        command: row.command ?? '-',
        status: row.status ?? '-',
        hostChecked: row.databaseHostChecked,
      })),
    );
  }
  if (receipt.registryManifests.length > 0) {
    console.table(
      receipt.registryManifests.map((row) => ({
        path: row.path,
        valid: row.valid,
        scope: row.scope.join(',') || '-',
        contentHash: row.contentHash?.slice(0, 12) ?? '-',
      })),
    );
  }
  if (receipt.rejectedOperationProbes.length > 0) {
    console.table(
      receipt.rejectedOperationProbes.map((row) => ({
        path: row.path,
        valid: row.valid,
        workspace: row.workspace ?? '-',
        operation: row.operation ?? '-',
        // The two capture-evidence proofs, surfaced in the terminal: WHICH
        // application guard refused, and against WHICH deployment.
        refusalCode: row.refusalCode ?? '-',
        apiEnv: row.apiEnvironment ?? '-',
        // Slot and source, in their OWN columns. Folding them into one
        // "build" value is what let a decorative release SHA hide.
        apiRevision: row.apiRevision ?? '-',
        apiSource: row.apiReleaseSha ?? '-',
        bound: row.environmentBound,
        // How many of the capture's three responses the audit re-derived as
        // coming from that one build — anything short of 3 is mixed-revision.
        originBound: row.originBoundResponses,
        surfaces: row.surfacesCompared,
        wroteNothing: row.wroteNothing,
      })),
    );
  }
  for (const assertion of receipt.assertions) {
    // A skipped assertion is announced explicitly — "green" and "not checked"
    // must never look the same in the operator's terminal either.
    if (assertion.status === 'skipped') {
      console.error(`SKIPPED [${assertion.id}] ${assertion.skipReason ?? 'not checked'}`);
      continue;
    }
    for (const finding of assertion.findings) {
      const prefix = assertion.tolerated ? 'TOLERATED' : 'FAIL';
      console.error(
        `${prefix} [${assertion.id}/${finding.code}]${finding.workspace ? ` (${finding.workspace})` : ''} ${finding.detail}`,
      );
    }
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const args = parseArgs(process.argv.slice(2));
  const baseline = await loadBaseline(args.baselinePath);
  if (baseline === null && args.requireBaseline) {
    throw new Error(
      '--require-baseline was passed but no baseline file was found; record one first with --baseline <path>',
    );
  }

  const registryReceipts: Gate6RegistryReceiptInput[] = await loadEvidence(
    'registry receipt',
    args.registryReceiptPaths,
  );
  const registryManifests: Gate6RegistryManifestInput[] = await loadEvidence(
    'registry manifest',
    args.registryManifestPaths,
  );
  const rejectedOperationProbes: Gate6RejectedOperationProbeInput[] = await loadEvidence(
    'rejected-operation probe',
    args.rejectedOperationProbePaths,
  );

  const env = loadEnv();
  const firebase = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;

  await runWithLifecycle({
    run: async (signal) => {
      console.log(`Database host: ${databaseHost}`);
      console.log(`Baseline mode: ${baseline === null ? 'record' : 'compare'}`);
      console.log(
        `Bounds: requestTimeoutMs=${args.requestTimeoutMs} maxStallMs=${args.maxStallMs} heartbeatMs=${args.heartbeatIntervalMs}`,
      );
      console.log(
        `Registry receipts: ${registryReceipts.length === 0 ? 'none supplied (attestation will be SKIPPED)' : registryReceipts.length}` +
          ` · manifests: ${registryManifests.length}` +
          ` · rejected-operation probes: ${rejectedOperationProbes.length === 0 ? 'none supplied (assertion will be SKIPPED)' : rejectedOperationProbes.length}`,
      );

      const receipt = await runGate6Audit(firebase.database, {
        uids: args.uids,
        nowMs: Date.now(),
        baseline,
        strictWitnessObservationRefs: args.strictWitnessObservationRefs,
        registryReceipts,
        registryManifests,
        requireRegistryReceipts: args.requireRegistryReceipts,
        rejectedOperationProbes,
        requireRejectedOperationProbes: args.requireRejectedOperationProbes,
        // The receipt's `databaseHost` is cross-checked against the database
        // this audit is actually pointed at — a receipt sealed on staging is
        // not evidence about production.
        expectedDatabaseHost: databaseHost,
        maxReceiptAgeMs: args.maxReceiptAgeMs,
        maxProbeAgeMs: args.maxProbeAgeMs,
        // Bounded execution: the lifecycle wrapper's signal reaches every RTDB
        // read, so an interrupt stops the audit at the next read boundary
        // instead of after it eventually returns.
        requestTimeoutMs: args.requestTimeoutMs,
        maxStallMs: args.maxStallMs,
        heartbeatIntervalMs: args.heartbeatIntervalMs,
        signal,
      });

      if (args.outPath !== null) {
        await writeFile(args.outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      }
      if (!args.quiet) {
        console.log(JSON.stringify(receipt, null, 2));
      }
      summarize(receipt);

      if (baseline === null && args.baselinePath !== null) {
        await writeFile(
          args.baselinePath,
          `${JSON.stringify(receipt.baseline, null, 2)}\n`,
          'utf8',
        );
        console.log(`Recorded baseline -> ${args.baselinePath}`);
      }

      if (receipt.ok) {
        console.log(
          receipt.skippedCount === 0
            ? 'gate6Audit: PASS — every assertion holds.'
            : `gate6Audit: PASS — every assertion CHECKED holds, but ${receipt.skippedCount} was/were SKIPPED for want of evidence (see status above).`,
        );
        return 0;
      }
      console.error(`gate6Audit: FAIL — ${receipt.findingCount} finding(s).`);
      return 1;
    },
    cleanup: async () => {
      firebase.database.goOffline();
      await deleteApp(firebase.app);
    },
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
  // The failure happened BEFORE the lifecycle wrapper could own termination
  // (env/config/Firebase init), or the audit itself threw an execution
  // condition. Arm the same unref'd backstop so neither path can zombie.
  setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
});
