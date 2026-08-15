/**
 * Phase 30.3 (Tournament Registry Backfill): owner-only operator for the
 * four ordinary demo accounts — derives the admin-imported historical
 * tournament-registry rows from each account's ALREADY-MIGRATED
 * `researchSource/{uid}/sets` records and reconciles
 * `tournamentEntries/{uid}` against them. Destination-only: it never
 * contacts start.gg, never touches a research tenant, and never creates
 * `startggLinks`/OAuth state. The frozen Phase 30.1 research tenants are
 * intentionally out of scope.
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/deriveTournamentRegistry.ts dry-run \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --manifest-out ./registry-manifest.json
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/deriveTournamentRegistry.ts apply \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --manifest-in ./registry-manifest.json [--max-age-ms 21600000]
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/deriveTournamentRegistry.ts compare \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --manifest-in ./registry-manifest.json [--max-age-ms 21600000]
 *
 * Mirrors `enrichDemoAccounts.ts`'s dry-run -> hash -> apply -> compare
 * posture and `migrateDemoAccounts.ts`'s thin I/O-shell shape: this file is
 * NOT unit-tested directly — the logic lives in the tested
 * `./registryManifestArtifact.ts` and `../src/research/registry/*` modules.
 *
 * - `dry-run` calls ONLY the read-only planner (writesPerformed: 0 is
 *   structural), writes the reviewable manifest artifact, and prints a
 *   summary table.
 * - `apply` validates the artifact (strict schema, content hash, uid map,
 *   staleness), pins the database host, re-plans read-only and refuses on
 *   ANY drift from the reviewed manifest (row-set hash AND action buckets),
 *   then — and only then — applies the FRESH plan.
 * - `compare` re-plans read-only and reports per-account exact-match: the
 *   live registry holds exactly the reviewed row set with zero pending
 *   writes, removals, or collisions.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import {
  applyTournamentRegistryPlan,
  planTournamentRegistry,
  type TournamentRegistryPlan,
} from '../src/research/registry/reconcile.js';
import {
  buildRegistryAccountManifest,
  buildRegistryComparisonRow,
  createRegistryManifest,
  registryWorkspaceKeys,
  validateRegistryManifest,
  type RegistryManifest,
  type RegistryUidMap,
  type RegistryWorkspaceKey,
} from './registryManifestArtifact.js';

const labels: Record<RegistryWorkspaceKey, string> = {
  hbox: 'Hungrybox',
  mkleo: 'MkLeo',
  sparg0: 'Sparg0',
  izaw: 'IzAw',
};
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

type FirebaseDatabase = ReturnType<typeof initFirebase>['database'];

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

function summarizePlan(workspace: RegistryWorkspaceKey, plan: TournamentRegistryPlan): object {
  return {
    workspace,
    sourceSets: plan.sourceSetCount,
    derivedRows: plan.derivedRows.length,
    creates: plan.creates.length,
    updates: plan.updates.length,
    unchanged: plan.unchanged.length,
    orphanRemovals: plan.orphanRemovals.length,
    collisions: plan.collisions.length,
    foreignPreserved: plan.preservedForeignCount,
    corruptSourceRecords: plan.corruptSourceRecords,
  };
}

async function dryRun(
  database: FirebaseDatabase,
  uids: RegistryUidMap,
  manifestPath: string,
  databaseHost: string,
): Promise<void> {
  const nowMs = Date.now();
  const plans = {} as Record<RegistryWorkspaceKey, TournamentRegistryPlan>;
  for (const workspace of registryWorkspaceKeys) {
    plans[workspace] = await planTournamentRegistry(database, uids[workspace], nowMs);
  }
  const manifest = createRegistryManifest({
    formatVersion: 1,
    generatedAtMs: nowMs,
    databaseHost,
    targetUids: uids,
    writesPerformed: 0,
    accounts: {
      hbox: buildRegistryAccountManifest(labels.hbox, plans.hbox),
      mkleo: buildRegistryAccountManifest(labels.mkleo, plans.mkleo),
      sparg0: buildRegistryAccountManifest(labels.sparg0, plans.sparg0),
      izaw: buildRegistryAccountManifest(labels.izaw, plans.izaw),
    },
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.table(
    registryWorkspaceKeys.map((workspace) => summarizePlan(workspace, plans[workspace])),
  );
  console.log(`Zero writes performed. Manifest: ${manifestPath}`);
}

async function apply(
  database: FirebaseDatabase,
  uids: RegistryUidMap,
  manifest: RegistryManifest,
): Promise<void> {
  // Read-only preflight over ALL FOUR accounts first — apply begins only
  // after every account matches its reviewed manifest, so a drift on the
  // fourth can never leave the first three half-applied.
  const freshPlans = {} as Record<RegistryWorkspaceKey, TournamentRegistryPlan>;
  for (const workspace of registryWorkspaceKeys) {
    const plan = await planTournamentRegistry(database, uids[workspace], Date.now());
    const fresh = buildRegistryAccountManifest(labels[workspace], plan);
    const reviewed = manifest.accounts[workspace];
    const bucketsMatch =
      JSON.stringify(fresh.creates) === JSON.stringify(reviewed.creates) &&
      JSON.stringify(fresh.updates) === JSON.stringify(reviewed.updates) &&
      JSON.stringify(fresh.unchanged) === JSON.stringify(reviewed.unchanged) &&
      JSON.stringify(fresh.collisions) === JSON.stringify(reviewed.collisions) &&
      JSON.stringify(fresh.orphanRemovals) === JSON.stringify(reviewed.orphanRemovals);
    if (fresh.rowSetHash !== reviewed.rowSetHash || !bucketsMatch) {
      throw new Error(
        `Apply refused: current read-only plan differs from the reviewed manifest for ${workspace} ` +
          '(source data or destination registry changed since dry-run — re-run dry-run and review again)',
      );
    }
    freshPlans[workspace] = plan;
  }
  console.log('Read-only preflight matches the reviewed manifest for all four accounts.');

  for (const workspace of registryWorkspaceKeys) {
    const result = await applyTournamentRegistryPlan(database, freshPlans[workspace]);
    console.log(
      `${workspace}: written=${result.written.length} removed=${result.removed.length} ` +
        `abortedForeign=${result.abortedForeign.join(',') || 'none'}`,
    );
    if (result.abortedForeign.length > 0) {
      // A foreign value landed between preflight and apply — nothing was
      // clobbered, but the exact apply did not complete.
      process.exitCode = 1;
    }
  }
}

async function compare(
  database: FirebaseDatabase,
  uids: RegistryUidMap,
  manifest: RegistryManifest,
): Promise<void> {
  const rows = [];
  for (const workspace of registryWorkspaceKeys) {
    const plan = await planTournamentRegistry(database, uids[workspace], Date.now());
    rows.push(buildRegistryComparisonRow(workspace, manifest.accounts[workspace], plan));
  }
  console.table(rows);
  if (!rows.every((row) => row.exactMatch)) {
    console.error('compare: at least one account does not exactly match the reviewed manifest.');
    process.exitCode = 1;
  } else {
    console.log('compare: all four accounts exactly match the reviewed manifest.');
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
  const { command, flags } = parseArgs(process.argv.slice(2));
  const uids = readUids(flags);
  const env = loadEnv();
  const firebase = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  console.log(`Database host: ${databaseHost}`);
  console.log(`Target UIDs: ${registryWorkspaceKeys.map((key) => uids[key]).join(', ')}`);

  try {
    if (command === 'dry-run') {
      await dryRun(firebase.database, uids, required(flags, '--manifest-out'), databaseHost);
      return;
    }
    const maxAgeMs = positiveInteger(flags, '--max-age-ms', DEFAULT_MAX_AGE_MS);
    const manifest = validateRegistryManifest(
      JSON.parse(await readFile(required(flags, '--manifest-in'), 'utf8')),
      uids,
      Date.now(),
      maxAgeMs,
    );
    if (manifest.databaseHost !== databaseHost) {
      throw new Error('Manifest database host does not match the active database');
    }
    if (command === 'apply') {
      await apply(firebase.database, uids, manifest);
    } else {
      await compare(firebase.database, uids, manifest);
    }
  } finally {
    // seedDemo.ts/migrateDemoAccounts.ts precedent: the Admin SDK keeps the
    // event loop alive otherwise — tear it down explicitly on every path.
    await deleteApp(firebase.app);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
