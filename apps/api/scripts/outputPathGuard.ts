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
 *
 * `assertInputPathIsGitignored` (WR-05-i3, below) is the READ-side
 * counterpart — the same shape of check for a `--file` a script reads
 * rather than writes, minus the write-side's directory-writability check.
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
/**
 * `flagName`/`verb` let the same check serve both `--out` (write, "write")
 * and `--file` (read, "read") without the error text lying about which flag
 * or which operation is being refused (WR-05-i3). `checkWritable` is
 * write-side only — a read has no reason to require its parent directory be
 * writable.
 */
function assertFilesystemTargetIsSafe(
  resolvedPath: string,
  repoRoot: string,
  options: { flagName: string; verb: 'write' | 'read'; checkWritable: boolean },
): void {
  const { flagName, verb, checkWritable } = options;
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
      `${flagName} already exists as a symlink — refusing to ${verb} through it (will not overwrite or follow a pre-existing symlink)`,
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
      `${flagName} directory could not be resolved on the real filesystem — refusing to ${verb}`,
    );
  }
  const expectedParentReal = path.resolve(repoRootReal, relativeDir);
  if (parentReal !== expectedParentReal) {
    throw new UnsafeOutputPathError(
      `${flagName} resolves through a symlinked directory outside the repository — refusing to ${verb}`,
    );
  }

  if (!checkWritable) {
    return;
  }

  // A write failure must never happen AFTER the network/RTDB read this
  // guard exists to precede — check writability now, while the only cost of
  // being wrong is re-running the guard, not re-spending a request budget
  // or a production read.
  try {
    fs.accessSync(parentReal, fs.constants.W_OK);
  } catch {
    throw new UnsafeOutputPathError(
      `${flagName} directory exists but is not writable — refusing to proceed before any network/RTDB read`,
    );
  }
}

/**
 * Throws `UnsafeOutputPathError` unless `outPath`, resolved against
 * `repoRoot`, both matches `allowedPattern` (which also rules out traversal
 * outside the repo, since every allowed pattern is anchored under
 * `apps/api/`) AND is confirmed ignored by git AND the real filesystem
 * target (not just the path string) is free of symlink tampering AND its
 * parent directory is writable.
 *
 * Returns the resolved ABSOLUTE path — callers MUST write to exactly this
 * value, never re-resolve the original `outPath` string a second time.
 * `pnpm --filter <pkg> exec` sets `cwd` to the package directory
 * (`apps/api/`), not the repo root the docs invoke it from, so a SECOND,
 * independent resolution of the same relative `--out` string against
 * `process.cwd()` (e.g. a later raw `writeFile(outPath, ...)` call) silently
 * targets a DIFFERENT, usually nonexistent, path than the one validated
 * here — exactly the incident that made the owner's first live spike run
 * fail with `ENOENT` after it had already spent its Liquipedia request
 * budget. Both `sparg0Export.ts` and `liqSpikeProbe.ts` now hold onto this
 * return value and write to it directly, later, without calling this
 * function a second time.
 */
export function assertOutputPathIsGitignored(options: AssertOutputPathIsGitignoredOptions): string {
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

  assertFilesystemTargetIsSafe(resolved, repoRoot, {
    flagName: '--out',
    verb: 'write',
    checkWritable: true,
  });

  const isGitIgnored = options.isGitIgnored ?? defaultIsGitIgnored;
  if (!isGitIgnored(resolved, repoRoot)) {
    throw new UnsafeOutputPathError(
      `--out is not confirmed ignored by git (git check-ignore reported it as tracked/trackable) — refusing to write; expected to match ${allowedPatternDescription}`,
    );
  }

  return resolved;
}

export interface AssertInputPathIsGitignoredOptions {
  filePath: string;
  repoRoot: string;
  /** Anchored regex tested against the path relative to `repoRoot`, forward-slash-normalized. */
  allowedPattern: RegExp;
  /** Human-readable description of `allowedPattern`, used only in error messages. */
  allowedPatternDescription: string;
  /** Injected for tests; defaults to shelling out to `git check-ignore -q`. */
  isGitIgnored?: (absolutePath: string, repoRoot: string) => boolean;
}

/**
 * WR-05-i3 (36-REVIEW.md iteration 3): the READ-side symmetric counterpart
 * to `assertOutputPathIsGitignored`. `sparg0RealDataReadout.ts`'s `--file`
 * previously had NO traversal, pattern, symlink, or gitignore-membership
 * check at all — a value like `../../../etc/passwd` resolved outside the
 * repo entirely and was passed straight to `readFile`, despite that script's
 * own doc comments repeatedly asserting the input is "the LOCAL, gitignored
 * export file." This closes that asymmetry: same traversal + pattern +
 * symlink refusal + git-ignored confirmation as the write side (delegating
 * to the SAME `assertFilesystemTargetIsSafe` primitive so the two guards can
 * never independently drift), MINUS the write side's directory-writability
 * check, which has no meaning for a read.
 *
 * Fails closed on every branch, same as `assertOutputPathIsGitignored`. The
 * error message names only the expected pattern — never the resolved path's
 * contents or any PII. Returns the resolved absolute path; callers must read
 * from exactly this value, never re-resolve the original `filePath` string a
 * second time (same `pnpm --filter <pkg> exec` cwd hazard the write side's
 * doc comment already documents).
 */
export function assertInputPathIsGitignored(options: AssertInputPathIsGitignoredOptions): string {
  const { filePath, allowedPattern, allowedPatternDescription } = options;
  const repoRoot = path.resolve(options.repoRoot);
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafeOutputPathError(
      `--file must resolve inside the repository (no path traversal outside the repo root); expected to match ${allowedPatternDescription}`,
    );
  }

  const normalizedRelative = relative.split(path.sep).join('/');
  if (!allowedPattern.test(normalizedRelative)) {
    throw new UnsafeOutputPathError(
      `--file must match ${allowedPatternDescription} (the .gitignore rule this script relies on) — refusing to read`,
    );
  }

  assertFilesystemTargetIsSafe(resolved, repoRoot, {
    flagName: '--file',
    verb: 'read',
    checkWritable: false,
  });

  const isGitIgnored = options.isGitIgnored ?? defaultIsGitIgnored;
  if (!isGitIgnored(resolved, repoRoot)) {
    throw new UnsafeOutputPathError(
      `--file is not confirmed ignored by git (git check-ignore reported it as tracked/trackable) — refusing to read; expected to match ${allowedPatternDescription}`,
    );
  }

  return resolved;
}

/** Renders `absolutePath` relative to `repoRoot`, forward-slash-normalized — for a `[receipt]` line that names a portable, repo-relative path rather than the local filesystem's absolute layout. */
export function toRepoRelativePath(absolutePath: string, repoRoot: string): string {
  return path.relative(path.resolve(repoRoot), absolutePath).split(path.sep).join('/');
}
