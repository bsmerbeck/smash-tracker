import { execFileSync } from 'node:child_process';
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
 * repo, does not match `allowedPattern`, or is not confirmed ignored by
 * `git check-ignore -q` is rejected. The error message names only the
 * expected pattern — never the resolved path's contents, a uid, or any PII.
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
 * Throws `UnsafeOutputPathError` unless `outPath`, resolved against
 * `repoRoot`, both matches `allowedPattern` (which also rules out traversal
 * outside the repo, since every allowed pattern is anchored under
 * `apps/api/`) AND is confirmed ignored by git.
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

  const isGitIgnored = options.isGitIgnored ?? defaultIsGitIgnored;
  if (!isGitIgnored(resolved, repoRoot)) {
    throw new UnsafeOutputPathError(
      `--out is not confirmed ignored by git (git check-ignore reported it as tracked/trackable) — refusing to write; expected to match ${allowedPatternDescription}`,
    );
  }
}
