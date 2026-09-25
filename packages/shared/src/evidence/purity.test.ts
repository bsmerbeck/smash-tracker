import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-36-01-01 (Information Disclosure): every module under
 * `packages/shared/src/evidence/` must be pure — no module-level mutable
 * binding and no module-level cache — so a browser render and a Fastify
 * request computing at the same time cannot observe each other. Scans the
 * SOURCE files on disk rather than importing them, so a module-level `let`
 * is caught even if nothing currently exercises the path that would leak.
 */

const evidenceDir = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(): string[] {
  return readdirSync(evidenceDir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
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
 * `Map`/`Set` built once from static data (e.g. `predicate.ts`'s
 * `KNOWN_FIGHTER_IDS`, derived from the fixed fighter roster and never
 * mutated afterward) is an immutable derived constant, not a cache, and is
 * NOT what this check is for — matching the plan's own wording ("assigned
 * to a mutable binding").
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

describe('evidence/ module purity (T-36-01-01)', () => {
  it('self-check: the file list is non-empty (a silently-empty glob must not vacuously pass)', () => {
    expect(listSourceFiles().length).toBeGreaterThanOrEqual(11);
  });

  it('declares no module-level mutable binding or module-level cache', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles()) {
      const body = stripComments(readFileSync(join(evidenceDir, file), 'utf8'));
      if (hasModuleLevelMutableBinding(body)) {
        offenders.push(`${file}: module-level let/var`);
      }
      if (hasModuleLevelMutableCache(body)) {
        offenders.push(`${file}: module-level new Map()/new Set() cache`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
