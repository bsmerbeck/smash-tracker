import { webcrypto } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { assertOutputPathIsGitignored } from './outputPathGuard.js';

/**
 * Phase 36 Plan 06 (SCL-01, D-20): the pure, unit-testable core of the
 * sparg0 real-data export.
 *
 * STRUCTURALLY READ-ONLY. This file contains no RTDB mutation call of any
 * kind — no `.set(`, `.update(`, `.remove(`, `.push(`, or `.transaction(`
 * anywhere in its non-comment body. A source guard in this plan's
 * `<verify>` greps this file for those method names and fails the task if
 * any appear; do not add one, and do not "satisfy" the guard by moving a
 * write call into a trailing comment — the guard strips comments before
 * scanning.
 *
 * Follows the `acctTopologyAudit.ts` / `acctTopologyAuditCore.ts` split
 * already established in this directory: this module is the pure,
 * fixture-tested core; `sparg0Export.ts` is the thin CLI composition root
 * (ADC init, flag parsing, file write, guaranteed-termination lifecycle).
 */

/**
 * The exact `.gitignore` glob covering this export's output (see the repo
 * root `.gitignore`, D-28). Uses `[^/]*` (not `.*`, WR-04-i2) — gitignore's
 * `*` glob never crosses a directory boundary, so the wildcard segment here
 * must not either, or the "exact glob" claim above is false for a nested
 * path like `apps/api/sparg0-export-dir/evil.json`.
 */
export const SPARG0_EXPORT_OUT_PATTERN = /^apps\/api\/sparg0-export[^/]*\.json$/;

/**
 * WR-03/D-28: refuses to write unless `--out` matches
 * `apps/api/sparg0-export*.json` (the exact gitignored pattern this script's
 * docstring promises) AND is confirmed ignored by `git check-ignore -q`.
 * Called BEFORE any network/RTDB read — see `sparg0Export.ts`'s `main()`.
 * Throws `UnsafeOutputPathError`; the message never includes a uid or any
 * exported match data.
 */
export function assertSafeSparg0ExportOutPath(options: {
  outPath: string;
  repoRoot: string;
  isGitIgnored?: (absolutePath: string, repoRoot: string) => boolean;
}): void {
  assertOutputPathIsGitignored({
    ...options,
    allowedPattern: SPARG0_EXPORT_OUT_PATTERN,
    allowedPatternDescription: 'apps/api/sparg0-export*.json',
  });
}

export interface Sparg0ExportResult {
  uid: string;
  matchCount: number;
  /** Every raw stored match value, unparsed — a byte-faithful export, not a validated read. */
  matches: unknown[];
  exportedAt: number;
}

/**
 * Reads `matches/{uid}` with a single `.get()` and nothing else. Returns
 * every raw stored value under that node (unparsed against
 * `matchRecordSchema` — this is a byte-faithful export, so a corrupt record
 * the API's own `listMatches` would skip-and-log is still captured here,
 * which is useful for a scale measurement that cares about raw payload
 * shape, not schema validity).
 */
export async function exportMatchesForUid(deps: {
  database: Database;
  uid: string;
  clock?: () => number;
}): Promise<Sparg0ExportResult> {
  const { database, uid, clock = Date.now } = deps;
  const snapshot = await database.ref(`matches/${uid}`).get();
  const raw = snapshot.exists() ? (snapshot.val() as Record<string, unknown>) : {};
  const matches = Object.values(raw);
  return {
    uid,
    matchCount: matches.length,
    matches,
    exportedAt: clock(),
  };
}

export interface Sparg0ExportReceipt {
  uid: string;
  matchCount: number;
  exportedAt: number;
  databaseHost: string;
  /** sha256 of `JSON.stringify(matches)` — lets the harness confirm it is reading the file the owner actually produced. */
  matchesSha256: string;
  /** The actual exported payload — the reason this script exists (D-20: the harness consumes this local file, never production directly). */
  matches: unknown[];
}

/**
 * Digests via the Web Crypto `subtle.digest` one-shot form (never the Node
 * `Hash` streaming API's incremental accumulator method) — that method's
 * name is a substring of the RTDB write verb this file's read-only guard
 * greps for, so a genuinely unrelated cryptographic hash would otherwise
 * trip the same structural check that exists to catch a real database
 * write. `subtle.digest` takes the whole input in one call and has no
 * method by that name.
 */
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

/**
 * Builds the JSON envelope the CLI writes to `--out`: uid, match count,
 * exported-at timestamp, database host, a sha256 of the serialized matches,
 * and the raw matches themselves.
 */
export async function buildExportReceipt(input: {
  uid: string;
  matchCount: number;
  matches: unknown[];
  exportedAt: number;
  databaseHost: string;
}): Promise<Sparg0ExportReceipt> {
  const { uid, matchCount, matches, exportedAt, databaseHost } = input;
  const matchesSha256 = await sha256Hex(JSON.stringify(matches));
  return { uid, matchCount, exportedAt, databaseHost, matchesSha256, matches };
}
