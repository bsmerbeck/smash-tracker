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
 * 30.3 OPERATOR HARDENING (owner/Codex Gate-6 directive): this file is now a
 * THIN COMPOSITION ROOT. All subcommand logic lives in
 * `deriveTournamentRegistryCore.ts` (testable against `FakeDatabase`, zero
 * network); the guaranteed-termination contract lives in
 * `enrichLifecycle.ts` (try/finally-owned Firebase lifecycle, SIGINT/SIGTERM
 * handling, exit within 10s of any terminal result) — the same wrapper the
 * hardened enrichment operator uses.
 *
 * Apply ONE ACCOUNT AT A TIME (`--account`), review its receipt, then move on:
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/deriveTournamentRegistry.ts dry-run \
 *     --account hbox \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --manifest-out ./registry-manifest.hbox.json --receipt-dir ./receipts
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/deriveTournamentRegistry.ts apply \
 *     --account hbox \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --manifest-in ./registry-manifest.hbox.json --receipt-dir ./receipts
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/deriveTournamentRegistry.ts compare \
 *     --account hbox \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --manifest-in ./registry-manifest.hbox.json --receipt-dir ./receipts
 *
 * Omitting `--account` keeps the all-accounts behaviour. Optional bounds:
 * `--max-age-ms` (manifest staleness, default 6h), `--max-stall-ms`
 * (no-progress watchdog, default 5m), `--request-timeout-ms` (per RTDB
 * operation, default 30s), `--heartbeat-ms` (default 30s).
 *
 * Recovery after an interruption: NEVER re-run a manifest whose apply was
 * interrupted. The operator detects a partially applied manifest and refuses
 * it — regenerate with `dry-run`, review, then apply the fresh one.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { runRegistryOperator } from './deriveTournamentRegistryCore.js';
import { runWithLifecycle } from './enrichLifecycle.js';

async function main(): Promise<number> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const argv = process.argv.slice(2);
  const env = loadEnv();
  const { app, database } = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;

  return runWithLifecycle({
    run: (signal) =>
      runRegistryOperator(argv, {
        database,
        databaseHost,
        now: () => Date.now(),
        log: (line) => console.log(line),
        table: (rows) => console.table(rows),
        readFileText: (path) => readFile(path, 'utf8'),
        writeFileText: (path, content) => writeFile(path, content, 'utf8'),
        signal,
      }),
    cleanup: async () => {
      // Take RTDB offline first (it is the persistent connection that kept
      // the enrichment operator alive 80+ minutes after death), then await
      // full app teardown.
      database.goOffline();
      await deleteApp(app);
    },
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  // The failure happened BEFORE the lifecycle wrapper could own termination
  // (env/config/Firebase init) — nothing long-lived exists yet, but arm the
  // same unref'd backstop so this path can never zombie either.
  setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
});
