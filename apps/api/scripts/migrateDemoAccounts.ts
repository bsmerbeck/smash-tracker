import { readFileSync, writeFileSync } from 'node:fs';
import { deleteApp } from 'firebase-admin/app';
import { getResearchConfig, loadEnv, type Env } from '../src/config/env.js';
import { initFirebase, type FirebaseServices } from '../src/firebase/admin.js';
import {
  archiveSources,
  preflightDestinations,
  runMigration,
  verifyMigration,
} from '../src/research/migration/manifest.js';
import { enableCoachingMode } from '../src/research/migration/coachingMode.js';
import {
  computeArtifactHash,
  manifestArtifactSchema,
  validateArchiveTargets,
  type DbIdentity,
  type ManifestArtifact,
  type ManifestArtifactWithoutHash,
  type SourceToDestMapping,
  type WorkspaceManifest,
} from './migrateManifestArtifact.js';

/**
 * Phase 30.1 Plan 04 (Demo Account Topology & Migration — ACCT-01, ACCT-02,
 * WKSP-01A): the owner-run `tsx` admin-SDK CLI that drives the Plan-01/02
 * migration machinery (`runMigration`/`verifyMigration`/
 * `preflightDestinations`/`archiveSources`, `enableCoachingMode`) against
 * the four demo workspaces via a structurally-ordered `copy` -> (owner
 * login validation) -> sign-off -> `archive` flow.
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/migrateDemoAccounts.ts copy \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     [--manifest-out ./migration-manifest.json]
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/migrateDemoAccounts.ts archive \
 *     --manifest-in ./migration-manifest.json --coach-uid <developerUid>
 *
 * Mirrors `seedDemo.ts`'s thin I/O-shell shape and posture: this file is NOT
 * unit-tested directly — only typecheck + lint + the Plan-01/02
 * (`src/research/migration/*.test.ts`) and this file's sibling
 * `migrateManifestArtifact.test.ts` suites cover the logic it calls. Import
 * surface is limited to `../src/config/env.js`, `../src/firebase/admin.js`,
 * the Plan-01/02 migration modules, `./migrateManifestArtifact.js`, node
 * `fs`/`crypto`, and `firebase-admin/app` for teardown — NO import from
 * `../src/events`, `routes`, `jobs`, `billing`, or `onboarding` (SEED-06/
 * RTEN-04).
 *
 * NEVER accepts a `--password` or `--email` flag (CONTEXT hard
 * credential-exclusion, T-30.1-01): the owner creates the four accounts
 * through the existing sign-up UI and supplies ONLY their uids. This CLI
 * never handles a credential, and only a database host + uids are ever
 * logged.
 *
 * The four source tenant ids below are NOT secret (CONTEXT.md lines 59-63)
 * — they are the well-known research-tenant ids Phase 30 already created.
 */

interface SourceTenant {
  sourceId: string;
  label: string;
}

const SOURCE_TENANTS = {
  hbox: { sourceId: '0f0443e4-c637-4dd4-9c3a-c8365c1f7ad6', label: 'Hungrybox' },
  mkleo: { sourceId: 'd4c17fdc-be36-49a1-8223-e0a3ab16a40c', label: 'MkLeo' },
  sparg0: { sourceId: 'e5d9f25d-929d-4884-875d-67cfab05d5c1', label: 'Sparg0' },
  izaw: { sourceId: '1438981f-2830-469d-ac96-cca1ee8cc75b', label: 'IzAw' },
} as const satisfies Record<string, SourceTenant>;

type WorkspaceKey = keyof typeof SOURCE_TENANTS;

/** The set of the four source tenant ids — the authority `validateArchiveTargets` checks archive-time maps against. */
const EXPECTED_SOURCE_IDS: readonly string[] = Object.values(SOURCE_TENANTS).map(
  (tenant) => tenant.sourceId,
);

const CREDENTIAL_FLAGS = ['--password', '--email'];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CopyArgs {
  subcommand: 'copy';
  destUids: Record<WorkspaceKey, string>;
  manifestOut: string;
}

interface ArchiveArgs {
  subcommand: 'archive';
  manifestIn: string;
  coachUid: string;
}

type CliArgs = CopyArgs | ArchiveArgs;

function assertNoCredentialFlags(argv: string[]): void {
  for (const flag of CREDENTIAL_FLAGS) {
    if (argv.includes(flag)) {
      console.error(
        `"${flag}" is not a supported flag — this CLI never accepts a credential. ` +
          'The owner creates accounts through the existing sign-up UI and supplies only the resulting uids.',
      );
      process.exit(1);
    }
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function parseCopyArgs(argv: string[]): CopyArgs {
  const mapJson = readFlag(argv, '--map');
  let destUids: Partial<Record<WorkspaceKey, string>>;

  if (mapJson !== undefined) {
    try {
      destUids = JSON.parse(mapJson) as Partial<Record<WorkspaceKey, string>>;
    } catch (err) {
      console.error(`--map must be valid JSON: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    destUids = {
      hbox: readFlag(argv, '--hbox-uid'),
      mkleo: readFlag(argv, '--mkleo-uid'),
      sparg0: readFlag(argv, '--sparg0-uid'),
      izaw: readFlag(argv, '--izaw-uid'),
    };
  }

  const missing = (Object.keys(SOURCE_TENANTS) as WorkspaceKey[]).filter(
    (key) => !destUids[key] || destUids[key]!.length === 0,
  );
  if (missing.length > 0) {
    console.error(
      `copy requires all four destination uids (missing: ${missing.join(', ')}) — ` +
        'pass --hbox-uid/--mkleo-uid/--sparg0-uid/--izaw-uid, or --map \'{"hbox":"...","mkleo":"...","sparg0":"...","izaw":"..."}\'',
    );
    process.exit(1);
  }

  const manifestOut = readFlag(argv, '--manifest-out') ?? './migration-manifest.json';

  return { subcommand: 'copy', destUids: destUids as Record<WorkspaceKey, string>, manifestOut };
}

function parseArchiveArgs(argv: string[]): ArchiveArgs {
  const manifestIn = readFlag(argv, '--manifest-in');
  const coachUid = readFlag(argv, '--coach-uid');

  if (!manifestIn) {
    console.error('archive requires --manifest-in <path>');
    process.exit(1);
  }
  if (!coachUid) {
    console.error('archive requires --coach-uid <developerUid>');
    process.exit(1);
  }

  return { subcommand: 'archive', manifestIn, coachUid };
}

function parseArgs(argv: string[]): CliArgs {
  assertNoCredentialFlags(argv);

  const [subcommand, ...rest] = argv;
  if (subcommand === 'copy') {
    return parseCopyArgs(rest);
  }
  if (subcommand === 'archive') {
    return parseArchiveArgs(rest);
  }

  console.error(`Unknown subcommand "${subcommand ?? '(none)'}" — expected "copy" or "archive"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database identity (bound into the manifest artifact, re-checked at archive time)
// ---------------------------------------------------------------------------

function resolveDbIdentity(env: Env, firebase: FirebaseServices): DbIdentity {
  return {
    host: new URL(env.FIREBASE_DATABASE_URL).host,
    projectId: firebase.app.options.projectId ?? null,
  };
}

function dbIdentityMatches(artifactIdentity: unknown, connected: DbIdentity): boolean {
  if (artifactIdentity === null || typeof artifactIdentity !== 'object') {
    return false;
  }
  const record = artifactIdentity as Record<string, unknown>;
  return record.host === connected.host && record.projectId === connected.projectId;
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

async function runCopy(
  firebase: FirebaseServices,
  dbIdentity: DbIdentity,
  args: CopyArgs,
): Promise<void> {
  const destUids = Object.entries(SOURCE_TENANTS).map(([key, tenant]) => ({
    key: key as WorkspaceKey,
    tenant,
    destUid: args.destUids[key as WorkspaceKey],
  }));

  const preflight = await preflightDestinations(firebase.database, {
    destUids: destUids.map((d) => d.destUid),
    sourceIds: EXPECTED_SOURCE_IDS as string[],
  });
  if (!preflight.ok) {
    console.error('Preflight FAILED — no writes performed:');
    for (const problem of preflight.problems) {
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('Preflight OK — all four destination uids are unique, existing, and ordinary.');

  const workspaces: WorkspaceManifest[] = [];
  const sourceToDestMap: SourceToDestMapping[] = [];

  for (const { key, tenant, destUid } of destUids) {
    const manifest = await runMigration(firebase.database, {
      sourceId: tenant.sourceId,
      destUid,
    });
    workspaces.push(manifest);
    sourceToDestMap.push({ sourceId: tenant.sourceId, destUid, label: tenant.label });

    if (key === 'izaw') {
      // ACCT-03: enable Coaching mode on IzAw's account SILENTLY — never
      // through the Profile-UI toggle (that path emits
      // `coaching_mode_enabled` telemetry; review H3 standardizes on this
      // direct helper for migration/seeding).
      await enableCoachingMode(firebase.database, destUid);
    }

    console.log(
      `[${tenant.label}] ${tenant.sourceId} -> ${destUid}: ok=${manifest.ok} ` +
        `trees=${manifest.trees.map((t) => `${t.tree}(match=${t.match},src=${t.sourceCount},dest=${t.destCount})`).join(', ')} ` +
        `conflicts=${manifest.copies.flatMap((c) => c.conflicts).join(',') || 'none'} ` +
        `assertEmptyViolations=${manifest.assertEmptyViolations.join(',') || 'none'}`,
    );
  }

  const ok = workspaces.every((workspace) => workspace.ok);

  const artifactWithoutHash: ManifestArtifactWithoutHash = {
    generatedAtMs: Date.now(),
    dbIdentity,
    sourceToDestMap,
    workspaces,
    ok,
  };
  const sha256 = computeArtifactHash(artifactWithoutHash);
  const artifact: ManifestArtifact = { ...artifactWithoutHash, sha256 };

  writeFileSync(args.manifestOut, JSON.stringify(artifact, null, 2));
  console.log(`Manifest artifact written to "${args.manifestOut}" (sha256=${sha256})`);

  if (!ok) {
    console.error(
      'copy completed with at least one tree mismatch, conflict, or assert-empty violation — see per-workspace output above. Exiting non-zero.',
    );
    process.exitCode = 1;
  } else {
    console.log('copy completed cleanly for all four workspaces.');
  }
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

async function runArchive(
  firebase: FirebaseServices,
  dbIdentity: DbIdentity,
  env: Env,
  args: ArchiveArgs,
): Promise<void> {
  let rawText: string;
  try {
    rawText = readFileSync(args.manifestIn, 'utf8');
  } catch (err) {
    console.error(
      `Cannot read manifest artifact at "${args.manifestIn}": ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
    return;
  }

  let rawArtifact: unknown;
  try {
    rawArtifact = JSON.parse(rawText);
  } catch (err) {
    console.error(
      `Manifest artifact at "${args.manifestIn}" is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
    return;
  }

  if (rawArtifact === null || typeof rawArtifact !== 'object') {
    console.error('Manifest artifact is not an object — refusing to archive.');
    process.exitCode = 1;
    return;
  }
  const record = rawArtifact as Record<string, unknown>;

  if (record.ok !== true) {
    console.error(
      `Manifest artifact ok=${JSON.stringify(record.ok)} — the copy did not complete cleanly. Refusing to archive.`,
    );
    process.exitCode = 1;
    return;
  }

  const storedHash = record.sha256;
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    console.error('Manifest artifact is missing sha256 — refusing to archive.');
    process.exitCode = 1;
    return;
  }

  const withoutHash: Record<string, unknown> = { ...record };
  delete withoutHash.sha256;
  const recomputedHash = computeArtifactHash(withoutHash as ManifestArtifactWithoutHash);
  if (recomputedHash !== storedHash) {
    console.error(
      'Manifest artifact hash mismatch — the artifact does not match its own recorded hash ' +
        '(corrupt or tampered). Refusing to archive.',
    );
    process.exitCode = 1;
    return;
  }

  if (!dbIdentityMatches(record.dbIdentity, dbIdentity)) {
    console.error(
      'Manifest artifact dbIdentity does not match the currently-connected database — ' +
        'this is a stale or foreign-environment artifact. Refusing to archive.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Manifest artifact verified clean (ok=true, hash matches, dbIdentity matches ${dbIdentity.host}).`,
  );

  let validatedSourceIds: string[];
  try {
    validatedSourceIds = validateArchiveTargets(rawArtifact, EXPECTED_SOURCE_IDS);
  } catch (err) {
    console.error(
      `Manifest artifact sourceToDestMap failed validation: ${err instanceof Error ? err.message : err}. Refusing to archive.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `sourceToDestMap validated — exactly the four expected sources: ${validatedSourceIds.join(', ')}`,
  );

  // Re-parse through the same strict schema (already proven to succeed by
  // `validateArchiveTargets` above) to get the full typed mapping array —
  // the live re-verify below needs each mapping's `destUid`, which
  // `validateArchiveTargets`'s contract deliberately does not return
  // (review C3-M2: its return value is ONLY the validated source-id list).
  const parsed = manifestArtifactSchema.parse(rawArtifact);

  for (const mapping of parsed.sourceToDestMap) {
    const verification = await verifyMigration(firebase.database, {
      sourceId: mapping.sourceId,
      destUid: mapping.destUid,
    });
    if (!verification.ok) {
      console.error(
        `Live verifyMigration re-check FAILED for ${mapping.label} (${mapping.sourceId} -> ${mapping.destUid}): ` +
          `treeMismatches=${
            verification.trees
              .filter((t) => !t.match)
              .map((t) => t.tree)
              .join(',') || 'none'
          } ` +
          `assertEmptyViolations=${verification.assertEmptyViolations.join(',') || 'none'}. ` +
          'Live prod state has drifted since the copy — refusing to archive.',
      );
      process.exitCode = 1;
      return;
    }
  }
  console.log(
    'Live verifyMigration re-check passed for all four workspaces — no drift since the copy.',
  );

  const researchConfig = getResearchConfig(env);
  if (researchConfig === null) {
    console.error(
      'RESEARCH_ADMIN_UIDS is not configured — the archive gate requires a non-null ResearchConfig (Pitfall 3). Refusing to archive.',
    );
    process.exitCode = 1;
    return;
  }

  // Review MEDIUM #1 (disclosed, acceptable): re-running `archive` is
  // idempotent-IN-EFFECT (the four sources end up archived either way) but
  // NOT byte-identical, because `archiveClient(true)` stamps a fresh
  // `Date.now()` `archivedAt` on every call — a second run overwrites the
  // first run's timestamp rather than being a true no-op.
  await archiveSources(firebase.database, args.coachUid, validatedSourceIds, researchConfig);
  console.log(
    `Archived (soft, reversible — NOT deleted) source tenants: ${validatedSourceIds.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
    return;
  }

  const firebase = initFirebase(env);
  const dbIdentity = resolveDbIdentity(env, firebase);

  // T-30.1-01: log ONLY the database host, subcommand, and uids — never a
  // credential — the last chance to Ctrl-C before any write (`copy`) or
  // archive begins.
  if (args.subcommand === 'copy') {
    console.log(
      `Running "copy" against database host "${dbIdentity.host}" with destination uids: ` +
        `hbox=${args.destUids.hbox} mkleo=${args.destUids.mkleo} sparg0=${args.destUids.sparg0} izaw=${args.destUids.izaw}`,
    );
  } else {
    console.log(
      `Running "archive" against database host "${dbIdentity.host}" with manifest "${args.manifestIn}" and coach uid "${args.coachUid}"`,
    );
  }

  try {
    if (args.subcommand === 'copy') {
      await runCopy(firebase, dbIdentity, args);
    } else {
      await runArchive(firebase, dbIdentity, env, args);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // T-14-04 precedent (seedDemo.ts): the Admin SDK keeps the event loop
    // alive otherwise — tear it down explicitly on every path.
    await deleteApp(firebase.app);
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

void main();
