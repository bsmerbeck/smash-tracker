import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-39.1-01-01 (Information Disclosure), restated for the new engine
 * — near-literal copy of `evidence/purity.test.ts`, retargeted to
 * `packages/shared/src/insight/` and walking its `templates/` subdirectory
 * too: every module under here must be pure — no module-level mutable
 * binding and no module-level cache — so a browser render and a future
 * server-side report computation (EVID-10 spirit) can never share mutable
 * state. Scans the SOURCE files on disk rather than importing them, so a
 * module-level `let` is caught even if nothing currently exercises the path
 * that would leak.
 */

const insightDir = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Strips line and block comments so a comment containing `let`/`new Map(` doesn't false-positive. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** True when `let`/`var` appears at module (top) level — i.e. NOT indented inside a function/block. */
function hasModuleLevelMutableBinding(body: string): boolean {
  return body
    .split('\n')
    .some((line) => /^(export\s+)?(let|var)\s+\w/.test(line.trim()) && !/^\s/.test(line));
}

/**
 * True when a `new Map(`/`new Set(` at module level is assigned to a
 * MUTABLE binding (`let`/`var`) — the actual leak vector, since its
 * contents could be written to across requests. A `const` binding to a
 * `Map`/`Set` built once from static data is an immutable derived constant,
 * not a cache, and is NOT what this check is for (mirrors
 * `evidence/purity.test.ts`'s identical rationale).
 */
function hasModuleLevelMutableCache(body: string): boolean {
  return body
    .split('\n')
    .some(
      (line) =>
        !/^\s/.test(line) &&
        /^(export\s+)?(let|var)\s+\w+.*=\s*new\s+(Map|Set)\s*\(/.test(line.trim()),
    );
}

describe('insight/ module purity (T-39.1-01-01)', () => {
  const files = listSourceFiles(insightDir);

  it('self-check: the file list is non-empty and at least the number of non-test source files this plan creates (a silently-empty glob must not vacuously pass)', () => {
    // Measured from a real `find` run at authoring time (recorded in the plan SUMMARY): 16
    // non-test source files across insight/ and insight/templates/ (index, types, policy,
    // wilsonInterval, twoProportion, horizon, ladder, salience, rail, engine,
    // templates/{registry,core,subject,cohort,roster,formNow}). Kept as a literal floor, not
    // re-derived from `files.length` itself.
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  it('declares no module-level mutable binding or module-level cache', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = stripComments(readFileSync(file, 'utf8'));
      const label = relative(insightDir, file);
      if (hasModuleLevelMutableBinding(body)) {
        offenders.push(`${label}: module-level let/var`);
      }
      if (hasModuleLevelMutableCache(body)) {
        offenders.push(`${label}: module-level new Map()/new Set() cache`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
