import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertOutputPathIsGitignored,
  resolveGitRepoRoot,
  UnsafeOutputPathError,
} from './outputPathGuard.js';

const THIS_DIR = fileURLToPath(new URL('.', import.meta.url));

const PATTERN = /^apps\/api\/sparg0-export.*\.json$/;
const DESCRIPTION = 'apps/api/sparg0-export*.json';
const REPO_ROOT = '/repo';

/**
 * WR-03-i2: the filesystem-target safety check (`lstat`/`realpath`) touches
 * real disk, so tests that exercise code past the pattern check need a repo
 * root that genuinely exists — a fake `/repo` string (fine for the earlier,
 * string-only checks) now fails closed with a filesystem-resolution error
 * before ever reaching the check under test. Creates a fresh temp dir with a
 * real `apps/api` directory; callers must `rmSync` it in a `finally`.
 */
function makeFixtureRepoRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'output-path-guard-'));
  mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
  return root;
}

describe('assertOutputPathIsGitignored', () => {
  it('throws on path traversal outside the repo root', () => {
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: '../outside-the-repo.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => true,
      }),
    ).toThrow(UnsafeOutputPathError);
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: '../outside-the-repo.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => true,
      }),
    ).toThrow(/no path traversal outside the repo root/);
  });

  it('throws on an absolute path escaping the repo root', () => {
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: '/etc/passwd',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => true,
      }),
    ).toThrow(UnsafeOutputPathError);
  });

  it('throws when the path resolves inside the repo but does not match the allowed pattern', () => {
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: 'apps/api/wrong-name.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => true,
      }),
    ).toThrow(/must match apps\/api\/sparg0-export\*\.json/);
  });

  it('throws when the path matches the pattern but git reports it as tracked (not ignored)', () => {
    const root = makeFixtureRepoRoot();
    try {
      expect(() =>
        assertOutputPathIsGitignored({
          outPath: 'apps/api/sparg0-export.json',
          repoRoot: root,
          allowedPattern: PATTERN,
          allowedPatternDescription: DESCRIPTION,
          isGitIgnored: () => false,
        }),
      ).toThrow(/not confirmed ignored by git/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not throw for a path that matches the pattern and is confirmed ignored', () => {
    const root = makeFixtureRepoRoot();
    try {
      expect(() =>
        assertOutputPathIsGitignored({
          outPath: 'apps/api/sparg0-export.json',
          repoRoot: root,
          allowedPattern: PATTERN,
          allowedPatternDescription: DESCRIPTION,
          isGitIgnored: () => true,
        }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('filesystem target safety (WR-03-i2)', () => {
    it('throws when the output path already exists as a symlink (refuses to follow or overwrite it)', () => {
      const root = makeFixtureRepoRoot();
      try {
        const outsideTarget = path.join(root, 'outside-target.json');
        writeFileSync(outsideTarget, '{}');
        const linkPath = path.join(root, 'apps', 'api', 'sparg0-export.json');
        symlinkSync(outsideTarget, linkPath);

        let called = false;
        expect(() =>
          assertOutputPathIsGitignored({
            outPath: 'apps/api/sparg0-export.json',
            repoRoot: root,
            allowedPattern: PATTERN,
            allowedPatternDescription: DESCRIPTION,
            isGitIgnored: () => {
              called = true;
              return true;
            },
          }),
        ).toThrow(/already exists as a symlink/);
        // Fails closed before ever shelling out to git — mirrors the
        // traversal check's "never invokes the git check" guarantee above.
        expect(called).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('throws when apps/api/ itself is a symlink to a directory outside the repo apps/api tree', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'output-path-guard-'));
      try {
        mkdirSync(path.join(root, 'apps'), { recursive: true });
        const elsewhere = path.join(root, 'elsewhere-api');
        mkdirSync(elsewhere, { recursive: true });
        // apps/api resolves, via the real filesystem, outside the repo's
        // genuine apps/api directory — the path STRING still looks fine.
        symlinkSync(elsewhere, path.join(root, 'apps', 'api'));

        expect(() =>
          assertOutputPathIsGitignored({
            outPath: 'apps/api/sparg0-export.json',
            repoRoot: root,
            allowedPattern: PATTERN,
            allowedPatternDescription: DESCRIPTION,
            isGitIgnored: () => true,
          }),
        ).toThrow(/resolves through a symlinked directory/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not throw for an ordinary, non-symlinked target that does not exist yet', () => {
      const root = makeFixtureRepoRoot();
      try {
        expect(() =>
          assertOutputPathIsGitignored({
            outPath: 'apps/api/sparg0-export.json',
            repoRoot: root,
            allowedPattern: PATTERN,
            allowedPatternDescription: DESCRIPTION,
            isGitIgnored: () => true,
          }),
        ).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('never invokes the git check when the path traversal check already failed (fails closed before the shell-out)', () => {
    let called = false;
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: '../outside-the-repo.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => {
          called = true;
          return true;
        },
      }),
    ).toThrow(UnsafeOutputPathError);
    expect(called).toBe(false);
  });

  it('error messages never include the resolved absolute path (no leaking local filesystem layout)', () => {
    try {
      assertOutputPathIsGitignored({
        outPath: 'apps/api/wrong-name.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => true,
      });
      throw new Error('expected assertOutputPathIsGitignored to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeOutputPathError);
      expect((error as Error).message).not.toContain(REPO_ROOT);
    }
  });
});

describe('resolveGitRepoRoot', () => {
  it('resolves the real repository root from this test file location', () => {
    const root = resolveGitRepoRoot(THIS_DIR);
    // This file lives at <repoRoot>/apps/api/scripts/outputPathGuard.test.ts.
    expect(root.endsWith('smash-tracker')).toBe(true);
  });
});
