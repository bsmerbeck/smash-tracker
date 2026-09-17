import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared primitive behind the sparg0 export and Liquipedia spike probe's
 * `--out` safety checks (WR-03, D-28). Both scripts write real production
 * data (or a research artifact carrying unsanitized third-party revision
 * metadata) to a caller-supplied path; each script's own docstring promises
 * that path "must already be covered by a `.gitignore` rule" but neither
 * script enforced it. This closes that gap: it refuses to write anywhere
 * except the exact gitignored filename pattern the calling script names,
 * BEFORE any network/RTDB read (see each script's `main()`).
 *
 * Fails closed on every branch: a path that does not resolve inside the
 * repo, does not match `allowedPattern`, is not confirmed ignored by
 * `git check-ignore -q`, already exists as a symlink, or whose parent
 * directory resolves (via the real filesystem, not just the path string)
 * outside the repo's `apps/api/` directory is rejected (WR-03-i2: the
 * string-only checks above cannot see a pre-existing symlink planted at or
 * above the target path). The error message names only the expected
 * pattern — never the resolved path's contents, a uid, or any PII.
 */
export class UnsafeOutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeOutputPathError';
  }
}

export interface AssertOutputPathIsGitignoredOptions {
  outPath: string;
  repoRoot: string;
  /** Anchored regex tested against the path relative to `repoRoot`, forward-slash-normalized. */
  allowedPattern: RegExp;
  /** Human-readable description of `allowedPattern`, used only in error messages. */
  allowedPatternDescription: string;
  /** Injected for tests; defaults to shelling out to `git check-ignore -q`. */
  isGitIgnored?: (absolutePath: string, repoRoot: string) => boolean;
}

/** Resolves the repository root via `git rev-parse --show-toplevel` — robust regardless of the invoking shell's cwd (e.g. `pnpm --filter` cwd-ing into the package directory). */
export function resolveGitRepoRoot(cwd: string = process.cwd()): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

function defaultIsGitIgnored(absolutePath: string, repoRoot: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', absolutePath], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    // Non-zero exit from `git check-ignore` means "not ignored" (exit 1) or
    // a fatal git error (exit 128, e.g. not a git repo) — both fail closed.
    return false;
  }
}

/**
 * WR-03-i2: the checks above only ever inspect the path STRING — they never
 * look at what actually sits on disk. If `resolvedPath` already exists as a
 * symlink (planted by a prior run, another tool, or tampering), a later
 * `writeFile` follows it and silently writes at the symlink's target,
 * wherever that is. Separately, since every `allowedPattern` this module's
 * callers use is anchored to a single path segment directly under
 * `apps/api/` (see `SPARG0_EXPORT_OUT_PATTERN`/`LIQ_SPIKE_REPORT_OUT_PATTERN`),
 * the parent directory of any accepted path is always, lexically,
 * `<repoRoot>/apps/api` — so if `apps` or `api` itself has been swapped for a
 * symlink to somewhere else, the real (post-symlink) parent directory
 * diverges from that expectation even though the path string still "looks"
 * safe.
 *
 * Both checks use `lstat`/`realpath` (never plain `stat`, which follows
 * symlinks) so a symlink is detected rather than transparently resolved.
 * Fails closed: any error resolving the real filesystem shape (including a
 * missing `apps/api` directory) is treated as unsafe.
 */
function assertFilesystemTargetIsSafe(resolvedPath: string, repoRoot: string): void {
  let targetStat: fs.Stats | undefined;
  try {
    targetStat = fs.lstatSync(resolvedPath);
  } catch (error) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error;
    }
  }
  if (targetStat && targetStat.isSymbolicLink()) {
    throw new UnsafeOutputPathError(
      '--out already exists as a symlink — refusing to write through it (will not overwrite or follow a pre-existing symlink)',
    );
  }

  const relativeDir = path.dirname(path.relative(repoRoot, resolvedPath));
  let repoRootReal: string;
  let parentReal: string;
  try {
    repoRootReal = fs.realpathSync(repoRoot);
    parentReal = fs.realpathSync(path.dirname(resolvedPath));
  } catch {
    throw new UnsafeOutputPathError(
      '--out directory could not be resolved on the real filesystem — refusing to write',
    );
  }
  const expectedParentReal = path.resolve(repoRootReal, relativeDir);
  if (parentReal !== expectedParentReal) {
    throw new UnsafeOutputPathError(
      '--out resolves through a symlinked directory outside the repository — refusing to write',
    );
  }
}

/**
 * Throws `UnsafeOutputPathError` unless `outPath`, resolved against
 * `repoRoot`, both matches `allowedPattern` (which also rules out traversal
 * outside the repo, since every allowed pattern is anchored under
 * `apps/api/`) AND is confirmed ignored by git AND the real filesystem
 * target (not just the path string) is free of symlink tampering.
 */
export function assertOutputPathIsGitignored(options: AssertOutputPathIsGitignoredOptions): void {
  const { outPath, allowedPattern, allowedPatternDescription } = options;
  const repoRoot = path.resolve(options.repoRoot);
  const resolved = path.resolve(repoRoot, outPath);
  const relative = path.relative(repoRoot, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafeOutputPathError(
      `--out must resolve inside the repository (no path traversal outside the repo root); expected to match ${allowedPatternDescription}`,
    );
  }

  const normalizedRelative = relative.split(path.sep).join('/');
  if (!allowedPattern.test(normalizedRelative)) {
    throw new UnsafeOutputPathError(
      `--out must match ${allowedPatternDescription} (the .gitignore rule this script relies on) — refusing to write`,
    );
  }

  assertFilesystemTargetIsSafe(resolved, repoRoot);

  const isGitIgnored = options.isGitIgnored ?? defaultIsGitIgnored;
  if (!isGitIgnored(resolved, repoRoot)) {
    throw new UnsafeOutputPathError(
      `--out is not confirmed ignored by git (git check-ignore reported it as tracked/trackable) — refusing to write; expected to match ${allowedPatternDescription}`,
    );
  }
}
