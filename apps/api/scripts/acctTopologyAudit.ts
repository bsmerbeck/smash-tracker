/**
 * ACCT TOPOLOGY AUDIT — Phase 30.1 ACCT-01/ACCT-03 (READ-ONLY).
 *
 * Proves against LIVE production that none of the four demo accounts appears as
 * a managed client of the developer's coaching account. Two halves, both
 * required — see `acctTopologyAuditCore.ts` for why the second one is the point:
 *
 *   SUBJECT half   no destination UID is a member of a coach tenant
 *                  (`clientMembers/{tenantId}/{uid}`) or the owner of a managed
 *                  tenant (`clientOwnedTenants/{uid}/{tenantId}`).
 *   SOURCE half    no player-named source tenant from the canonical migration
 *                  manifest is still VISIBLE as a managed client, i.e. present
 *                  under `coachClients/{coachUid}` with `archivedAt == null`.
 *
 * The source half exists because the UID-only check returns PASS while
 * "Hungrybox", "MkLeo", "Sparg0" and "IzAw" still render in the developer's
 * Client Hub — the exact topology the owner correction removes (Codex hard gate
 * at `fb9a3930`, P0).
 *
 * WHY NOT `preflightDestinations`: that gates a migration before it runs, and
 * the production copy already ran on 2026-08-11. The clause is a claim about
 * CURRENT topology, so only a read of the live trees answers it.
 *
 * USAGE (no `--help` is implemented — this docstring is the interface, matching
 * the other operators in this directory):
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/acctTopologyAudit.ts \
 *     --coach-uid "$COACH_UID" \
 *     --hbox-uid "$HBOX_UID" --mkleo-uid "$MKLEO_UID" \
 *     --sparg0-uid "$SPARG0_UID" --izaw-uid "$IZAW_UID" \
 *     --migration-manifest ./apps/api/migration-manifest.json \
 *     --reviewed-sha "$(git rev-parse HEAD)" \
 *     --out ./acct-topology-audit.json
 *
 * FLAGS
 *   --coach-uid <uid>            REQUIRED. The developer's coaching account.
 *   --hbox-uid / --mkleo-uid / --sparg0-uid / --izaw-uid
 *                                REQUIRED, all four, all DISTINCT, none equal to
 *                                --coach-uid. The set must equal the manifest's
 *                                four `destUid`s exactly.
 *   --migration-manifest <path>  REQUIRED. The canonical migration manifest. Its
 *                                `sha256` is recomputed and must match, and its
 *                                `sourceToDestMap` supplies the four source
 *                                tenant ids — they are never hardcoded here.
 *   --reviewed-sha <sha>         REQUIRED. Sealed into the receipt as the build
 *                                this evidence was produced from. Supplied, not
 *                                self-derived: a tool asserting its own identity
 *                                proves nothing.
 *   --out <path>                 Optional JSON receipt.
 *   --request-timeout-ms <n>     Per-read deadline. Default 30000.
 *   --max-stall-ms <n>           No-progress watchdog. Default 300000.
 *   --heartbeat-ms <n>           Heartbeat cadence. Default 30000.
 *
 * THERE IS NO EMPTY-COACH-TREE ESCAPE HATCH. An earlier revision had
 * `--allow-empty-coach-tree`; Codex removed it. The developer tree is known to
 * be nonempty, so an empty read means a mistyped (but path-safe) coach uid, and
 * a flag that turns that into exit 0 is a false-green escape.
 *
 * BOUNDED EXECUTION. Every read carries `--request-timeout-ms`, a heartbeat
 * prints progress, a no-progress watchdog aborts after `--max-stall-ms`, and
 * `runWithLifecycle` guarantees cleanup plus a hard exit within 10s of a
 * terminal result — the same lifecycle the other Gate-6 operators use, for the
 * same reason (an operator that hangs looks alive for hours).
 *
 * EXIT CODES: 0 only when the audit produced zero findings. Any finding,
 * malformed input, manifest mismatch, emulator host, or empty coach tree exits
 * nonzero. SIGINT/SIGTERM exit 130.
 *
 * This script performs READS ONLY — it constructs no write of any kind. Its only
 * output side effect is the optional `--out` file.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS } from '../src/research/registry/deadline.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import {
  GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
  GATE6_DEFAULT_MAX_STALL_MS,
} from './gate6AuditCore.js';
import {
  computeArtifactHash,
  manifestArtifactSchema,
  type ManifestArtifactParsed,
} from './migrateManifestArtifact.js';
import {
  auditAcctTopology,
  type AcctTopologySourceTenant,
  type AcctTopologySubject,
} from './acctTopologyAuditCore.js';

const SUBJECT_FLAGS: readonly { flag: string; label: string }[] = [
  { flag: '--hbox-uid', label: 'hbox' },
  { flag: '--mkleo-uid', label: 'mkleo' },
  { flag: '--sparg0-uid', label: 'sparg0' },
  { flag: '--izaw-uid', label: 'izaw' },
];

const VALUE_FLAGS = new Set<string>([
  '--coach-uid',
  '--migration-manifest',
  '--reviewed-sha',
  '--out',
  '--request-timeout-ms',
  '--max-stall-ms',
  '--heartbeat-ms',
  ...SUBJECT_FLAGS.map((entry) => entry.flag),
]);

export interface AcctTopologyArgs {
  coachUid: string;
  subjects: AcctTopologySubject[];
  manifestPath: string;
  reviewedSha: string;
  outPath: string | null;
  requestTimeoutMs: number;
  maxStallMs: number;
  heartbeatIntervalMs: number;
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
export function parseAcctTopologyArgs(argv: readonly string[]): AcctTopologyArgs {
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

  const coachUid = required('--coach-uid', 'the developer coaching account under audit');
  const manifestPath = required('--migration-manifest', 'the canonical migration manifest');
  const reviewedSha = required('--reviewed-sha', 'the git SHA this evidence was produced from');

  const subjects: AcctTopologySubject[] = [];
  const missing: string[] = [];
  for (const { flag, label } of SUBJECT_FLAGS) {
    const uid = values.get(flag);
    if (!uid) {
      missing.push(flag);
      continue;
    }
    subjects.push({ label, uid });
  }
  if (missing.length > 0) {
    throw new Error(
      `all four demo uids are required — missing ${missing.join(', ')}. ` +
        'This is a four-account clause; a partial run is not a reduced form of it.',
    );
  }

  return {
    coachUid,
    subjects,
    manifestPath,
    reviewedSha,
    outPath: values.get('--out') ?? null,
    requestTimeoutMs: positiveInteger(
      values,
      '--request-timeout-ms',
      DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
    ),
    maxStallMs: positiveInteger(values, '--max-stall-ms', GATE6_DEFAULT_MAX_STALL_MS),
    heartbeatIntervalMs: positiveInteger(
      values,
      '--heartbeat-ms',
      GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
  };
}

/**
 * Parses the manifest through the SAME strict schema the migration operator
 * uses, recomputes its canonical hash, and binds the four `destUid`s to the
 * uids supplied on the command line. A manifest whose map does not name exactly
 * the accounts being audited is not evidence about them.
 */
export function resolveSourceTenants(
  rawManifest: unknown,
  subjects: readonly AcctTopologySubject[],
): { manifest: ManifestArtifactParsed; sourceTenants: AcctTopologySourceTenant[] } {
  const parsed = manifestArtifactSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new Error(`migration manifest failed schema validation: ${parsed.error.message}`);
  }
  const manifest = parsed.data;

  const { sha256, ...withoutHash } = manifest;
  const recomputed = computeArtifactHash(withoutHash);
  if (recomputed !== sha256) {
    throw new Error(
      `migration manifest hash mismatch: recorded ${sha256}, recomputed ${recomputed} — the artifact was altered`,
    );
  }

  const map = manifest.sourceToDestMap;
  if (map.length !== 4) {
    throw new Error(`sourceToDestMap must contain exactly 4 entries, found ${map.length}`);
  }
  if (new Set(map.map((entry) => entry.sourceId)).size !== 4) {
    throw new Error('sourceToDestMap contains a duplicate sourceId');
  }

  const manifestDestUids = new Set(map.map((entry) => entry.destUid));
  if (manifestDestUids.size !== 4) {
    throw new Error('sourceToDestMap contains a duplicate destUid');
  }
  // Drain a COPY: `manifestDestUids.size` was just compared to 4, and narrowing
  // that literal survives the mutating `delete` calls below, so draining the
  // original makes the emptiness check unreachable to the type checker.
  const unmatchedDestUids = new Set(manifestDestUids);
  for (const subject of subjects) {
    if (!unmatchedDestUids.delete(subject.uid)) {
      throw new Error(
        `--${subject.label}-uid is not one of the manifest's destUids — the uids being audited must be exactly the four the migration wrote`,
      );
    }
  }
  if (unmatchedDestUids.size > 0) {
    throw new Error(
      `manifest destUids not covered by the supplied flags: ${[...unmatchedDestUids].join(', ')}`,
    );
  }

  return {
    manifest,
    sourceTenants: map.map((entry) => ({
      sourceId: entry.sourceId,
      destUid: entry.destUid,
      label: entry.label,
    })),
  };
}

export interface AcctTopologyReceiptIdentity {
  generatedAtMs: number;
  reviewedSha: string;
  databaseHost: string;
  firebaseProjectId: string | null;
  /** Always `null` — a set emulator host aborts before any read. Sealed so the receipt states it. */
  databaseEmulatorHost: null;
}

/**
 * Builds the sealed evidence artifact. Pure, so it round-trips through JSON in
 * a test rather than only ever existing inside a live production run.
 *
 * Every identity field Codex required is here: generation timestamp, reviewed
 * git SHA, effective database host and project id, the (absent) emulator host,
 * the manifest hash and its full source map, the audited coach uid, and the
 * four destination uids — the last two arriving inside `result`, which seals
 * the label->uid map it actually audited.
 */
export function buildAcctTopologyReceipt(input: {
  identity: AcctTopologyReceiptIdentity;
  manifestPath: string;
  manifest: ManifestArtifactParsed;
  bounds: { requestTimeoutMs: number; maxStallMs: number; heartbeatIntervalMs: number };
  exitCode: number;
  result: Awaited<ReturnType<typeof auditAcctTopology>>;
}) {
  return {
    receiptVersion: 2,
    audit: 'acct-topology' as const,
    requirement: ['ACCT-01', 'ACCT-03'] as const,
    ...input.identity,
    migrationManifest: {
      path: input.manifestPath,
      sha256: input.manifest.sha256,
      generatedAtMs: input.manifest.generatedAtMs,
      dbIdentity: input.manifest.dbIdentity,
      sourceToDestMap: input.manifest.sourceToDestMap,
    },
    bounds: input.bounds,
    exitCode: input.exitCode,
    ...input.result,
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

  const args = parseAcctTopologyArgs(process.argv.slice(2));
  const rawManifest: unknown = JSON.parse(await readFile(args.manifestPath, 'utf8'));
  const { manifest, sourceTenants } = resolveSourceTenants(rawManifest, args.subjects);

  const env = loadEnv();
  if (env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error(
      `FIREBASE_DATABASE_EMULATOR_HOST is set (${env.FIREBASE_DATABASE_EMULATOR_HOST}) — this audit must read production, not an emulator`,
    );
  }
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  const firebase = initFirebase(env);
  const projectId = firebase.app.options.projectId ?? null;

  const exitCode = await runWithLifecycle({
    run: async (signal) => {
      console.log(`Database host: ${databaseHost} · project: ${projectId ?? '(unset)'}`);
      console.log(`Manifest: ${args.manifestPath} · sha256=${manifest.sha256}`);
      console.log(`Reviewed SHA: ${args.reviewedSha}`);
      console.log(
        `Bounds: requestTimeoutMs=${args.requestTimeoutMs} maxStallMs=${args.maxStallMs} heartbeatMs=${args.heartbeatIntervalMs}`,
      );

      const result = await auditAcctTopology(firebase.database, {
        coachUid: args.coachUid,
        subjects: args.subjects,
        sourceTenants,
        requestTimeoutMs: args.requestTimeoutMs,
        maxStallMs: args.maxStallMs,
        heartbeatIntervalMs: args.heartbeatIntervalMs,
        signal,
      });

      console.log(`Coach tenants: ${result.coachTenantIds.length}`);
      console.log(`Membership reads: ${result.membershipReads}`);
      for (const disposition of result.sourceDispositions) {
        console.log(
          `  source ${disposition.label} (${disposition.sourceId}): ` +
            `coachClients=${disposition.inCoachClients ? 'present' : 'absent'} ` +
            `archivedAt=${disposition.coachClientsArchivedAt ?? 'null'} ` +
            `visible=${disposition.visibleInClientHub}`,
        );
      }

      let code = 0;
      if (result.coachTenantIds.length === 0) {
        console.error(
          `FAIL [coach-tree-empty]: coachClients/${args.coachUid} is empty, so the membership ` +
            'sweep checked nothing. The developer tree is known to be nonempty — verify the coach uid.',
        );
        code = 1;
      }
      if (result.findings.length > 0) {
        for (const finding of result.findings) {
          console.error(`FINDING [${finding.violation}] ${finding.detail}`);
        }
        console.error(
          'FAIL: the ACCT-01/ACCT-03 no-managed-client clause is NOT satisfied in production. ' +
            'Do not close ACCT-01/ACCT-03.',
        );
        if (result.visibleSourceTenantCount > 0) {
          console.error(
            `NOTE: ${result.visibleSourceTenantCount} player-named source tenant(s) are still active managed clients. ` +
              'This audit is READ-ONLY and archives nothing — the archive is Phase 30.1 step 10 and needs explicit owner sign-off.',
          );
        }
        code = 1;
      } else if (code === 0) {
        console.log(
          'PASS: no destination account is a coach-tenant member or managed-tenant owner, and no ' +
            'player-named source tenant is visible in the developer Client Hub.',
        );
      }

      if (args.outPath) {
        const receipt = buildAcctTopologyReceipt({
          identity: {
            generatedAtMs: Date.now(),
            reviewedSha: args.reviewedSha,
            databaseHost,
            firebaseProjectId: projectId,
            databaseEmulatorHost: null,
          },
          manifestPath: args.manifestPath,
          manifest,
          bounds: {
            requestTimeoutMs: args.requestTimeoutMs,
            maxStallMs: args.maxStallMs,
            heartbeatIntervalMs: args.heartbeatIntervalMs,
          },
          exitCode: code,
          result,
        });
        await writeFile(args.outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        console.log(`[receipt] acct-topology: path=${args.outPath}`);
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
if (process.argv[1] && process.argv[1].endsWith('acctTopologyAudit.ts')) {
  void main().then(undefined, (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
