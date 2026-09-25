/**
 * SPARG0 EXPORT — Phase 36 Plan 06 (SCL-01, D-20). READ-ONLY.
 *
 * Exports one account's real `matches/{uid}` data to a local, gitignored
 * JSON file, so the SCL-01 measurement harness can run the shared engine
 * against sparg0's real production shape without Claude ever reading
 * production itself. THE OWNER RUNS THIS SCRIPT, under their own existing
 * Application Default Credentials — the same credential path every other
 * `apps/api/scripts/*` operator already uses. The harness then consumes
 * only the local output file.
 *
 * USAGE (no `--help` is implemented — this docstring is the interface,
 * matching the other operators in this directory):
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/sparg0Export.ts \
 *     --uid <sparg0-uid> --out apps/api/sparg0-export.json
 *
 * FLAGS
 *   --uid <uid>   REQUIRED. The account to export. Never hardcoded in
 *                 source — supplied by the operator on every invocation.
 *   --out <path>  REQUIRED. Where to write the JSON export. This path MUST
 *                 match `apps/api/sparg0-export*.json` (see the block in the
 *                 repo root `.gitignore`, added in the same change as this
 *                 script) AND be confirmed ignored by `git check-ignore -q`
 *                 — both checked and enforced (`assertSafeSparg0ExportOutPath`
 *                 in `sparg0ExportCore.ts`) before any network/RTDB read,
 *                 which returns the resolved absolute path this process
 *                 writes to (fix A/WR-05, shared with `liqSpikeProbe.ts`) —
 *                 the raw `--out` string is never re-resolved a second time
 *                 (`pnpm --filter <pkg> exec` sets `cwd` to `apps/api/`, so a
 *                 second resolution of the same relative string would
 *                 silently target a different, nonexistent path).
 *                 Exported production match data must never be committed.
 *
 * READ ONLY. This script constructs no write of any kind — see
 * `sparg0ExportCore.ts` for the structural guard. It refuses to run when
 * `FIREBASE_DATABASE_EMULATOR_HOST` is set: this export must read
 * production, not an emulator. It prints only counts and the output path —
 * never a match row, an opponent tag, an email, or any uid other than the
 * one the operator passed on the command line.
 */
import { writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import { resolveGitRepoRoot, toRepoRelativePath } from './outputPathGuard.js';
import {
  exportMatchesForUid,
  buildExportReceipt,
  assertSafeSparg0ExportOutPath,
} from './sparg0ExportCore.js';

const VALUE_FLAGS = new Set<string>(['--uid', '--out']);

export interface Sparg0ExportArgs {
  uid: string;
  outPath: string;
}

/** Strict `--name value` parsing — an unknown flag or a duplicate is an error, never a silent skip. */
export function parseSparg0ExportArgs(argv: readonly string[]): Sparg0ExportArgs {
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

  const uid = values.get('--uid');
  if (!uid) {
    throw new Error('--uid is required (the account to export)');
  }
  const outPath = values.get('--out');
  if (!outPath) {
    throw new Error('--out is required (where to write the JSON export)');
  }

  return { uid, outPath };
}

/**
 * Fail closed when pointed at an emulator — this export must read
 * production, mirroring `acctTopologyAudit.ts`'s identical refusal.
 */
export function assertNotEmulator(emulatorHost: string | undefined): void {
  if (emulatorHost) {
    throw new Error(
      `FIREBASE_DATABASE_EMULATOR_HOST is set (${emulatorHost}) — this export must read production, not an emulator`,
    );
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

  const args = parseSparg0ExportArgs(process.argv.slice(2));

  // WR-03/D-28: refuse an unsafe `--out` before any network/RTDB read. The
  // RESOLVED ABSOLUTE PATH returned here is the ONLY path this process ever
  // writes to (fix A/WR-05, shared with liqSpikeProbe.ts) — never re-resolve
  // `args.outPath` a second time. `pnpm --filter <pkg> exec` sets `cwd` to
  // `apps/api/`, so a second, independent resolution of this same relative
  // string against `process.cwd()` would silently target a different,
  // nonexistent path (see `outputPathGuard.ts`'s doc comment).
  const repoRoot = resolveGitRepoRoot();
  const resolvedOutPath = assertSafeSparg0ExportOutPath({ outPath: args.outPath, repoRoot });

  const env = loadEnv();
  assertNotEmulator(env.FIREBASE_DATABASE_EMULATOR_HOST);

  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  const firebase = initFirebase(env);

  const exitCode = await runWithLifecycle({
    run: async () => {
      console.log(`Database host: ${databaseHost}`);
      console.log('Exporting matches for the supplied uid (read-only)...');

      const result = await exportMatchesForUid({ database: firebase.database, uid: args.uid });
      const receipt = await buildExportReceipt({
        uid: result.uid,
        matchCount: result.matchCount,
        matches: result.matches,
        exportedAt: result.exportedAt,
        databaseHost,
      });

      // The SAME resolved absolute path validated above, before any
      // network/RTDB read — never a second, independent resolution.
      await writeFile(resolvedOutPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      console.log(`Matches exported: ${receipt.matchCount}`);
      console.log(`[receipt] sparg0-export: path=${toRepoRelativePath(resolvedOutPath, repoRoot)}`);

      return 0;
    },
    cleanup: async () => {
      firebase.database.goOffline();
      await deleteApp(firebase.app);
    },
  });

  process.exit(exitCode);
}

// Only run when invoked directly — the test harness imports the pure helpers.
if (process.argv[1] && process.argv[1].endsWith('sparg0Export.ts')) {
  void main().then(undefined, (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
