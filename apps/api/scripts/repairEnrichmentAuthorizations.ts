/**
 * ENRICHMENT AUTHORIZATION REPAIR — Gate 6 P3 one-time bounded operator (CLI).
 *
 * Repairs EXACTLY the two reviewed defect classes on ONE demo account:
 *
 *   49-class   a Liquipedia VOD-list observation was refreshed in place under
 *              its stable id while its receipt/attachment kept the PRIOR
 *              fingerprint — re-authorized to the SAME target set against the
 *              CURRENT fingerprint, only after the row independently
 *              re-resolves there;
 *   3-class    obsolete pre-offset predecessor rows — removed SUCCESSOR-FIRST:
 *              the semantic successor must be present (and, when the
 *              predecessor was attached, freshly authorized and projection-
 *              converged) BEFORE the predecessor cascade runs.
 *
 * All decisions live in `repairEnrichmentAuthorizationsCore.ts` (tested
 * against FakeDatabase); this file is only argument parsing, environment
 * binding, and receipts. The operator refuses any process that is not
 * NODE_ENV=production against the exact production host/project, refuses a
 * set emulator host, holds the terminal-run maintenance lease for the whole
 * apply, and performs at most `ENRICHMENT_REPAIR_MAX_ACTIONS` reviewed
 * actions.
 *
 * USAGE (no `--help` is implemented — this docstring is the interface,
 * matching the other operators in this directory). The intended sequence is
 * plan -> human review of the plan file -> apply -> compare:
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/repairEnrichmentAuthorizations.ts \
 *     --mode plan --account mkleo --reviewed-sha "$(git rev-parse HEAD)" \
 *     --out ./enrichment-repair-plan.mkleo.json
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/repairEnrichmentAuthorizations.ts \
 *     --mode apply --account mkleo --reviewed-sha "$(git rev-parse HEAD)" \
 *     --plan ./enrichment-repair-plan.mkleo.json \
 *     --receipt-out ./enrichment-repair-receipt.mkleo.json
 *
 * MODES
 *   plan      READ-ONLY. Analyzes live state and writes the bounded plan to
 *             `--out`. Exits 0 only when the plan has ZERO blocked reasons;
 *             a blocked plan is still written, for review, and exits 1.
 *   apply     Executes a reviewed plan. Refuses unless the live state hash
 *             equals the reviewed plan's exactly.
 *   resume    Crash-recovery re-entry for an interrupted apply: skips the
 *             exact-state equality but still requires every monotonic
 *             reviewed-state proof.
 *   compare   READ-ONLY convergence check of a plan against live state.
 *             Exits 0 only when every reviewed action is proven converged.
 *
 * FLAGS
 *   --mode <plan|apply|resume|compare>   REQUIRED.
 *   --account <mkleo|sparg0>             REQUIRED. Binds the run to that
 *                                        account's frozen uid/page/count
 *                                        contract in the core.
 *   --reviewed-sha <sha>                 REQUIRED. Sealed into the artifact as
 *                                        the build this evidence was produced
 *                                        from. Supplied, not self-derived.
 *   --out <path>                         plan mode only, REQUIRED there.
 *   --plan <path>                        apply/resume/compare, REQUIRED there.
 *   --receipt-out <path>                 apply/resume/compare, optional JSON
 *                                        receipt with sealed identity.
 *   --request-timeout-ms <n>             Per-read deadline. Default 30000.
 *   --max-age-ms <n>                     Maximum reviewed-plan age accepted by
 *                                        apply/resume/compare. Default 1 hour.
 *
 * EXIT CODES: 0 only on an unblocked plan / converged apply / converged
 * compare. Any refusal, blocked plan, drifted state, or malformed input exits
 * nonzero. SIGINT/SIGTERM exit 130.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS } from '../src/research/registry/deadline.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import {
  applyEnrichmentRepairPlan,
  compareEnrichmentRepairPlan,
  createEnrichmentRepairPlan,
  ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS,
  ENRICHMENT_REPAIR_TARGETS,
  resumeEnrichmentRepairPlan,
  type EnrichmentRepairApplyResult,
  type EnrichmentRepairCompareResult,
  type EnrichmentRepairOptions,
} from './repairEnrichmentAuthorizationsCore.js';

const MODES = ['plan', 'apply', 'resume', 'compare'] as const;
type RepairMode = (typeof MODES)[number];

const ACCOUNTS = ['mkleo', 'sparg0'] as const;
type RepairAccount = (typeof ACCOUNTS)[number];

const VALUE_FLAGS = new Set<string>([
  '--mode',
  '--account',
  '--reviewed-sha',
  '--out',
  '--plan',
  '--receipt-out',
  '--request-timeout-ms',
  '--max-age-ms',
]);

export interface RepairCliArgs {
  mode: RepairMode;
  account: RepairAccount;
  reviewedSha: string;
  outPath: string | null;
  planPath: string | null;
  receiptOutPath: string | null;
  requestTimeoutMs: number;
  maxAgeMs: number;
}

function positiveInteger(values: Map<string, string>, flag: string, fallback: number): number {
  const raw = values.get(flag);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Rejects unknown flags and duplicate occurrences — a silently-ignored typo'd flag is a false green. */
export function parseRepairCliArgs(argv: readonly string[]): RepairCliArgs {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    if (!VALUE_FLAGS.has(token)) {
      throw new Error(`unknown flag: ${token}`);
    }
    if (values.has(token)) {
      throw new Error(`duplicate flag: ${token} was supplied more than once`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token, value);
    i += 1;
  }

  const required = (flag: string, what: string): string => {
    const value = values.get(flag);
    if (!value) {
      throw new Error(`${flag} is required (${what})`);
    }
    return value;
  };

  const mode = required('--mode', 'plan, apply, resume, or compare');
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join('/')}, received ${JSON.stringify(mode)}`);
  }
  const account = required('--account', 'mkleo or sparg0');
  if (!(ACCOUNTS as readonly string[]).includes(account)) {
    throw new Error(
      `--account must be one of ${ACCOUNTS.join('/')}, received ${JSON.stringify(account)}`,
    );
  }
  const reviewedSha = required('--reviewed-sha', 'the git SHA this evidence was produced from');
  if (!/^[0-9a-f]{40}$/i.test(reviewedSha)) {
    throw new Error(
      `--reviewed-sha must be a full 40-character hexadecimal git SHA, received ${JSON.stringify(reviewedSha)}`,
    );
  }

  const outPath = values.get('--out') ?? null;
  const planPath = values.get('--plan') ?? null;
  const receiptOutPath = values.get('--receipt-out') ?? null;
  if (mode === 'plan') {
    if (!outPath) {
      throw new Error('--out is required in plan mode (the plan file is the review artifact)');
    }
    if (planPath || receiptOutPath) {
      throw new Error('--plan/--receipt-out are not accepted in plan mode');
    }
  } else {
    if (!planPath) {
      throw new Error(`--plan is required in ${mode} mode (the reviewed plan file)`);
    }
    if (outPath) {
      throw new Error(`--out is only accepted in plan mode, not ${mode}`);
    }
  }

  return {
    mode: mode as RepairMode,
    account: account as RepairAccount,
    reviewedSha,
    outPath,
    planPath,
    receiptOutPath,
    requestTimeoutMs: positiveInteger(
      values,
      '--request-timeout-ms',
      DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
    ),
    maxAgeMs: positiveInteger(values, '--max-age-ms', ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS),
  };
}

/** Sealed evidence artifact for apply/resume/compare. Pure, so it round-trips through JSON. */
export function buildRepairCliReceipt(input: {
  mode: RepairMode;
  account: RepairAccount;
  uid: string;
  reviewedSha: string;
  generatedAtMs: number;
  databaseHost: string;
  firebaseProjectId: string | null;
  /** Always `null` — a set emulator host aborts before any read. Sealed so the receipt states it. */
  databaseEmulatorHost: null;
  planPath: string;
  planContentHash: string | null;
  bounds: { requestTimeoutMs: number; maxAgeMs: number };
  exitCode: number;
  result: EnrichmentRepairApplyResult | EnrichmentRepairCompareResult;
}) {
  return {
    receiptVersion: 1,
    operator: 'enrichment-authorization-repair' as const,
    ...input,
  };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const args = parseRepairCliArgs(process.argv.slice(2));
  const env = loadEnv();
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  const firebase = initFirebase(env);
  // `initFirebase` passes only credential+databaseURL to initializeApp, so
  // `app.options.projectId` is ALWAYS null under local ADC — as written by the
  // prior session this check could never pass on any machine. The project is
  // instead DECLARED explicitly by the operator via GOOGLE_CLOUD_PROJECT (or
  // GCLOUD_PROJECT), and the core still refuses null or any value other than
  // the production project; the database HOST is pinned independently.
  const projectId =
    firebase.app.options.projectId ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    null;

  const exitCode = await runWithLifecycle({
    run: async (signal) => {
      const options: EnrichmentRepairOptions = {
        database: firebase.database,
        databaseHost,
        projectId,
        environment: env.NODE_ENV,
        databaseEmulatorHost: env.FIREBASE_DATABASE_EMULATOR_HOST ?? null,
        account: args.account,
        uid: ENRICHMENT_REPAIR_TARGETS[args.account].uid,
        nowMs: Date.now(),
        requestTimeoutMs: args.requestTimeoutMs,
        signal,
        now: Date.now,
        onProgress: (label) => console.log(`[repair] ${label}`),
      };

      console.log(`Database host: ${databaseHost} · project: ${projectId ?? '(unset)'}`);
      console.log(`Mode: ${args.mode} · account: ${args.account} · uid: ${options.uid}`);
      console.log(`Reviewed SHA: ${args.reviewedSha}`);
      console.log(`Bounds: requestTimeoutMs=${args.requestTimeoutMs} maxAgeMs=${args.maxAgeMs}`);

      if (args.mode === 'plan') {
        const plan = await createEnrichmentRepairPlan(options);
        await writeFile(args.outPath!, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
        console.log(
          `Plan: staleAuthorizations=${plan.staleAuthorizations.length} ` +
            `successorPairs=${plan.successorPairs.length} contentHash=${plan.contentHash}`,
        );
        console.log(`[plan] path=${args.outPath}`);
        if (plan.blockedReasons.length > 0) {
          for (const reason of plan.blockedReasons) {
            console.error(`BLOCKED: ${reason}`);
          }
          console.error('FAIL: the plan is blocked; nothing may be applied from it.');
          return 1;
        }
        console.log('PASS: plan generated with zero blocked reasons; review it before apply.');
        return 0;
      }

      const rawPlan: unknown = JSON.parse(await readFile(args.planPath!, 'utf8'));
      const planContentHash =
        rawPlan !== null &&
        typeof rawPlan === 'object' &&
        typeof (rawPlan as Record<string, unknown>).contentHash === 'string'
          ? ((rawPlan as Record<string, unknown>).contentHash as string)
          : null;

      let result: EnrichmentRepairApplyResult | EnrichmentRepairCompareResult;
      let code: number;
      if (args.mode === 'compare') {
        const compared = await compareEnrichmentRepairPlan(rawPlan, options, args.maxAgeMs);
        for (const finding of compared.findings) {
          console.error(`FINDING: ${finding}`);
        }
        console.log(
          `Compare: ok=${compared.ok} reauthorized=${compared.staleAuthorizationsReauthorized} ` +
            `successors=${compared.successorsAuthorized} predecessorsRemoved=${compared.predecessorsRemoved}`,
        );
        result = compared;
        code = compared.ok ? 0 : 1;
      } else {
        const execute =
          args.mode === 'apply' ? applyEnrichmentRepairPlan : resumeEnrichmentRepairPlan;
        const applied = await execute(rawPlan, options, args.maxAgeMs);
        console.log(
          `${args.mode === 'apply' ? 'Apply' : 'Resume'}: ` +
            `reauthorized=${applied.staleAuthorizationsReauthorized} ` +
            `successors=${applied.successorsAuthorized} ` +
            `predecessorsRemoved=${applied.predecessorsRemoved} ` +
            `targetSetsReprojected=${applied.targetSetsReprojected}`,
        );
        result = applied;
        code = 0;
      }

      if (args.receiptOutPath) {
        const receipt = buildRepairCliReceipt({
          mode: args.mode,
          account: args.account,
          uid: options.uid,
          reviewedSha: args.reviewedSha,
          generatedAtMs: Date.now(),
          databaseHost,
          firebaseProjectId: projectId,
          databaseEmulatorHost: null,
          planPath: args.planPath!,
          planContentHash,
          bounds: { requestTimeoutMs: args.requestTimeoutMs, maxAgeMs: args.maxAgeMs },
          exitCode: code,
          result,
        });
        await writeFile(args.receiptOutPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        console.log(`[receipt] enrichment-repair: path=${args.receiptOutPath}`);
      }

      return code;
    },
    cleanup: async () => {
      firebase.database.goOffline();
      await deleteApp(firebase.app);
    },
  });

  process.exit(exitCode);
}

// Only run when invoked directly — the test harness imports the pure helpers.
if (process.argv[1] && process.argv[1].endsWith('repairEnrichmentAuthorizations.ts')) {
  void main().then(undefined, (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
