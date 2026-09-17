import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { PERF_HARNESS_UID } from './fakeAuthContextValue';

/**
 * Phase 36 Plan 06 (SCL-01 Task 3B): BUILD-OUTPUT half of the perf-harness
 * production-isolation guard. Deliberately EXCLUDED from the default
 * `pnpm test` run (own `.guard.test.ts` suffix, `vitest.config.ts`'s
 * `exclude`, D-26's identical "expensive/CI-flaky check, but real and
 * committed" precedent as the SCL-01 `.budget.test.ts` files) — a real
 * `vite build` per run is too slow for the default suite. Run explicitly
 * via `pnpm --filter @smash-tracker/web run guard:perf-harness-build`.
 *
 * Runs the REAL, UNMODIFIED `vite.config.ts` (via `configFile`) into a
 * throwaway temp `outDir` — never the tracked `dist/` — then greps every
 * emitted file for the harness marker string and the fake uid. The static
 * half (`perfHarnessStaticIsolation.test.ts`, part of the default suite)
 * proves the STRUCTURAL precondition (nothing imports the harness, no
 * `vite.config.ts` override); this half proves the OUTCOME.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let outDir: string;

beforeAll(async () => {
  outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scl01-perf-harness-build-guard-'));
  await build({
    root: WEB_ROOT,
    configFile: path.join(WEB_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
    },
  });
}, 120_000);

afterAll(async () => {
  if (outDir) {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

function listBuiltFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listBuiltFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('perf harness production isolation — build-output half', () => {
  it('the real production build never emits perf-harness.html as an entry', () => {
    expect(fs.existsSync(path.join(outDir, 'perf-harness.html'))).toBe(false);
  });

  it('no emitted file contains the harness marker string or the fake harness uid', () => {
    const offenders: { file: string; needle: string }[] = [];
    const needles = ['perf-harness', PERF_HARNESS_UID];
    for (const file of listBuiltFiles(outDir)) {
      const contents = fs.readFileSync(file, 'utf8');
      for (const needle of needles) {
        if (contents.includes(needle)) {
          offenders.push({ file: path.relative(outDir, file), needle });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('index.html (the production entry) is present and unaffected', () => {
    expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(true);
  });
});
