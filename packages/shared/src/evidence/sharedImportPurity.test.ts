import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Review C1-B2: `purity.test.ts` scans only for module-level mutable
 * bindings and says nothing about imports. The web imports
 * `packages/shared/src/index.ts` from 440+ call sites, and the package
 * exposes no `./evidence` subpath (`package.json`'s `exports` map has only
 * `.` and `./testUtils`) — so anything this directory exports is reachable
 * from the browser bundle through the root barrel, exactly the rule
 * `researchEnrichment.ts`'s shipped doc comment states for the same reason.
 * This test is what makes that rule ENFORCED rather than remembered.
 *
 * Review C2-L5: matches the `node:` specifier wherever it appears — a
 * static `import`, a `export ... from 'node:...'` re-export, or a dynamic
 * `import('node:...')` — NOT only at the head of a line starting with
 * `import`. The plan's own `<verify>` block also runs a cheap shell backstop
 * (`grep -rn "node:" ... | grep -cE "^[^:]+:[0-9]+:\s*import"`) that by
 * construction only matches a single-line `import` statement at the START
 * of a line; a multi-line import or a dynamic `import()` mid-line would slip
 * past that shell form. Do NOT narrow this committed test to match the
 * weaker shell regex — this test is the load-bearing gate.
 */

const evidenceDir = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(): string[] {
  return readdirSync(evidenceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
}

/** Matches a `node:` specifier inside a static import, a re-export, or a dynamic `import(...)` — wherever it appears in the file, not only at line-start. */
const NODE_SPECIFIER_PATTERN = /(?:from\s*|import\s*\(\s*)['"]node:[a-zA-Z0-9/_-]+['"]/;

describe('evidence/ directory import purity (T-39-01-07 / review C1-B2)', () => {
  it('self-check: the scanned file list is non-empty (a silently-empty glob must not vacuously pass)', () => {
    expect(listSourceFiles().length).toBeGreaterThan(0);
  });

  it('SH-IN-01: the pattern itself convicts every import form — static, re-export, dynamic, side-effect-only and require — and nothing else', () => {
    for (const offender of [
      "import { createHash } from 'node:crypto';",
      "export { readFileSync } from 'node:fs';",
      "const fs = await import('node:fs');",
      "import 'node:crypto';",
      'import "node:process";',
      "const fs = require('node:fs');",
      "const path = require ( 'node:path' );",
    ]) {
      expect(NODE_SPECIFIER_PATTERN.test(offender), offender).toBe(true);
    }
    for (const clean of [
      "import { z } from 'zod';",
      "import './claims.js';",
      "const label = 'node:crypto is banned here';",
    ]) {
      expect(NODE_SPECIFIER_PATTERN.test(clean), clean).toBe(false);
    }
  });

  it('no non-test module under packages/shared/src/evidence/ imports a node: specifier', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles()) {
      const body = readFileSync(join(evidenceDir, file), 'utf8');
      if (NODE_SPECIFIER_PATTERN.test(body)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
