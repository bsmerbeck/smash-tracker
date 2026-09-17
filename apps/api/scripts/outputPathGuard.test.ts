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
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: 'apps/api/sparg0-export.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => false,
      }),
    ).toThrow(/not confirmed ignored by git/);
  });

  it('does not throw for a path that matches the pattern and is confirmed ignored', () => {
    expect(() =>
      assertOutputPathIsGitignored({
        outPath: 'apps/api/sparg0-export.json',
        repoRoot: REPO_ROOT,
        allowedPattern: PATTERN,
        allowedPatternDescription: DESCRIPTION,
        isGitIgnored: () => true,
      }),
    ).not.toThrow();
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
