/**
 * GATE 0 FORENSICS PROBE — READ-ONLY, Phase 30.2 corrective directive (2026-08-15).
 *
 * Reconfirms the production-state matrix before any mutation:
 *   - per-account counts for every tree the enrichment apply can touch
 *   - run/lease records (preserved as evidence — this script never writes)
 *   - database host + destination uid echo
 *
 * Zero writes by construction: only .get() reads. Terminates promptly via
 * goOffline + app.delete in finally (the zombie-lifecycle defect this
 * corrective scope fixes does not apply here).
 *
 * Usage (from apps/api, with .env loaded):
 *   pnpm exec tsx scripts/gate0ForensicsProbe.ts \
 *     --hbox-uid ... --mkleo-uid ... --sparg0-uid ... --izaw-uid ...
 */
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';

const TREES = [
  'researchEnrichmentObservations',
  'researchEnrichmentReceipts',
  'researchEnrichmentAttachments',
  'researchEnrichmentProjection',
  'researchEnrichmentRuns',
  'researchEnrichmentCoverage',
  'researchEnrichmentShrinkReviews',
] as const;

const ACCOUNTS = ['hbox', 'mkleo', 'sparg0', 'izaw'] as const;
type AccountKey = (typeof ACCOUNTS)[number];

function readUidFlags(argv: string[]): Record<AccountKey, string> {
  const uids = {} as Record<AccountKey, string>;
  for (const key of ACCOUNTS) {
    const flag = `--${key}-uid`;
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value) {
      throw new Error(`${flag} is required`);
    }
    uids[key] = value;
  }
  return uids;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const uids = readUidFlags(process.argv.slice(2));
  const env = loadEnv();
  const { app, database } = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  console.log(`# Gate 0 forensics probe (READ-ONLY) — ${new Date().toISOString()}`);
  console.log(`Database host: ${databaseHost}`);

  try {
    for (const key of ACCOUNTS) {
      const uid = uids[key];
      console.log(`\n## ${key} (${uid})`);
      for (const tree of TREES) {
        const snapshot = await database.ref(`${tree}/${uid}`).get();
        const count = snapshot.exists() ? snapshot.numChildren() : 0;
        console.log(`${tree}: ${count}`);
        if (tree === 'researchEnrichmentRuns' && snapshot.exists()) {
          const runs = snapshot.val() as Record<string, Record<string, unknown>>;
          for (const [runId, run] of Object.entries(runs)) {
            const summary = ['status', 'phase', 'startedAtMs', 'updatedAtMs', 'leaseExpiresAtMs']
              .map((field) => `${field}=${JSON.stringify(run?.[field])}`)
              .join(' ');
            console.log(`  run ${runId}: ${summary}`);
          }
        }
      }
      const matchesSnapshot = await database.ref(`matches/${uid}`).get();
      console.log(`matches: ${matchesSnapshot.exists() ? matchesSnapshot.numChildren() : 0}`);
    }
  } finally {
    database.goOffline();
    await deleteApp(app);
  }
}

void main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
