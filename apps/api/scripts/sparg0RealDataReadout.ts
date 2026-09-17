/**
 * SPARG0 REAL-DATA READOUT — Phase 36 Plan 06 Task 4 addendum (SCL-01).
 *
 * Reads the LOCAL, gitignored export file `sparg0Export.ts` already wrote
 * (`apps/api/sparg0-export.json` by convention) and runs the same
 * engine-compute / gzip-payload measurement the synthetic budgets use, over
 * sparg0's real match shape. This is a LOCAL FILE READ, not a production
 * read (D-20) — no Firebase/RTDB import exists anywhere in this file or in
 * `sparg0RealDataReadoutCore.ts`.
 *
 * USAGE (`--file` is REPO-ROOT-RELATIVE, always — see the cwd note below):
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/sparg0RealDataReadout.ts \
 *     --file apps/api/sparg0-export.json
 *
 * `pnpm --filter <pkg> exec` sets `cwd` to the package directory
 * (`apps/api/`), not the repo root the usage line above invokes it from —
 * resolving `--file` against `process.cwd()` would silently look for
 * `apps/api/apps/api/sparg0-export.json` and fail with ENOENT (the exact
 * class of bug `sparg0Export.ts`'s `--out` handling hit and fixed via
 * `resolveGitRepoRoot()`; see `outputPathGuard.ts`). This script resolves
 * `--file` against the git repo root the same way, so the documented
 * repo-root-relative path is always correct regardless of invocation cwd.
 *
 * PRINTS ONLY AGGREGATE LINES — counts, milliseconds, bytes, a sha256
 * fingerprint, a database hostname. Never a match row, an opponent tag, a
 * uid, or a tournament name. See `sparg0RealDataReadoutCore.ts`'s doc
 * comment for the full PII boundary this file's output must never cross.
 */
import path from 'node:path';
import { resolveGitRepoRoot } from './outputPathGuard.js';
import {
  buildRealDataReadout,
  formatRealDataReadoutLines,
  loadSparg0ExportEnvelope,
} from './sparg0RealDataReadoutCore.js';

async function main(): Promise<void> {
  const fileFlagIndex = process.argv.indexOf('--file');
  const rawFilePath = fileFlagIndex >= 0 ? process.argv[fileFlagIndex + 1] : undefined;
  if (!rawFilePath) {
    throw new Error(
      '--file is required (a repo-root-relative export JSON path, e.g. apps/api/sparg0-export.json)',
    );
  }
  const repoRoot = resolveGitRepoRoot();
  const filePath = path.resolve(repoRoot, rawFilePath);

  const envelope = await loadSparg0ExportEnvelope(filePath);
  const readout = buildRealDataReadout(envelope);
  for (const line of formatRealDataReadoutLines(readout)) {
    console.log(line);
  }
}

if (process.argv[1] && process.argv[1].endsWith('sparg0RealDataReadout.ts')) {
  void main().then(undefined, (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
