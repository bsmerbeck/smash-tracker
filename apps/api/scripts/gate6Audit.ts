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
 *     [--registry-receipt ./receipt-hbox.json]... [--require-registry-receipt] \
 *     [--require-baseline] [--strict-witness-observation-refs] [--quiet]
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
 * REGISTRY RECEIPT ATTESTATION (assertion 12), the cross-tool seam:
 * - `--registry-receipt <path>` is REPEATABLE — one per account. Each file is
 *   matched to its workspace by its OWN sealed `workspace` member, so the
 *   flags need no per-account variants and a mislabelled file is caught by
 *   the uid cross-check rather than silently accepted.
 * - Supplying none SKIPS the assertion: `status: 'skipped'` with a
 *   `skipReason`, visible in the JSON and in the terminal, and counted in the
 *   receipt's `skippedCount`. Skipped is never rendered as passed.
 * - `--require-registry-receipt` turns absence — and partial coverage of the
 *   four accounts — into findings, mirroring `--require-baseline`.
 *
 * This script performs READS ONLY — it constructs no write of any kind.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import {
  GATE6_WORKSPACE_KEYS,
  parseGate6Baseline,
  runGate6Audit,
  type Gate6AuditReceipt,
  type Gate6Baseline,
  type Gate6RegistryReceiptInput,
  type Gate6UidMap,
} from './gate6AuditCore.js';

interface ParsedArgs {
  uids: Gate6UidMap;
  baselinePath: string | null;
  outPath: string | null;
  /** Repeatable: one registry-operator receipt file per account. */
  registryReceiptPaths: string[];
  requireBaseline: boolean;
  requireRegistryReceipts: boolean;
  strictWitnessObservationRefs: boolean;
  quiet: boolean;
}

const BOOLEAN_FLAGS = new Set([
  '--require-baseline',
  '--require-registry-receipt',
  '--strict-witness-observation-refs',
  '--quiet',
]);

/** Flags that may appear more than once; every occurrence is kept. */
const REPEATABLE_FLAGS = new Set(['--registry-receipt']);

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
    requireBaseline: switches.has('--require-baseline'),
    requireRegistryReceipts: switches.has('--require-registry-receipt'),
    strictWitnessObservationRefs: switches.has('--strict-witness-observation-refs'),
    quiet: switches.has('--quiet'),
  };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
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
 * Reads each receipt file as raw JSON. Validation is the CORE's job (a
 * tampered seal must be a FINDING in the audit output, not a shell crash), so
 * this only surfaces I/O and JSON-syntax problems — and even those are handed
 * on as an unparseable `raw` rather than thrown, so one bad file cannot hide
 * the other eleven assertions.
 */
async function loadRegistryReceipts(paths: string[]): Promise<Gate6RegistryReceiptInput[]> {
  const inputs: Gate6RegistryReceiptInput[] = [];
  for (const path of paths) {
    try {
      inputs.push({ path, raw: JSON.parse(await readFile(path, 'utf8')) });
    } catch (error) {
      console.error(
        `registry receipt ${path} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
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

  const registryReceipts = await loadRegistryReceipts(args.registryReceiptPaths);

  const env = loadEnv();
  const firebase = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;

  await runWithLifecycle({
    run: async () => {
      console.log(`Database host: ${databaseHost}`);
      console.log(`Baseline mode: ${baseline === null ? 'record' : 'compare'}`);
      console.log(
        `Registry receipts: ${registryReceipts.length === 0 ? 'none supplied (attestation will be SKIPPED)' : registryReceipts.length}`,
      );

      const receipt = await runGate6Audit(firebase.database, {
        uids: args.uids,
        nowMs: Date.now(),
        baseline,
        strictWitnessObservationRefs: args.strictWitnessObservationRefs,
        registryReceipts,
        requireRegistryReceipts: args.requireRegistryReceipts,
        // The receipt's `databaseHost` is cross-checked against the database
        // this audit is actually pointed at — a receipt sealed on staging is
        // not evidence about production.
        expectedDatabaseHost: databaseHost,
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
});
