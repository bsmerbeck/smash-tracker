import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { GUARD_HARNESS_UID } from './fakeGuardAuthContextValue';

/**
 * Phase 39.1 Plan 09 (T-39.1-09-07): BUILD-OUTPUT half of the layout-oracle
 * harness's production-isolation guard, copied from the shipped perf
 * harness's `perfHarnessProductionBuild.guard.test.ts` (NOT edited by this
 * plan). Deliberately EXCLUDED from the default `pnpm test` run (own
 * `.guard.test.ts` suffix, `vitest.config.ts`'s `exclude`) — a real
 * `vite build` per run is too slow for the default suite. Picked up by the
 * EXISTING `vitest.guard.config.ts` include glob with no config change, so
 * this file runs under the existing `guard:perf-harness-build` script
 * alongside the perf harness's own isolation guard.
 *
 * Runs the REAL, UNMODIFIED `vite.config.ts` (via `configFile`) into a
 * throwaway temp `outDir` — never the tracked `dist/` — then greps every
 * emitted file for this harness's marker string and its fake uid. The
 * STATIC half below proves the STRUCTURAL precondition (nothing imports the
 * harness, no `vite.config.ts` override); this half proves the OUTCOME.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let outDir: string;

beforeAll(async () => {
  outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'guard-layout-harness-build-guard-'));
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

describe('layout-oracle harness production isolation — build-output half', () => {
  it('the real production build never emits guard-layout.html as an entry', () => {
    expect(fs.existsSync(path.join(outDir, 'guard-layout.html'))).toBe(false);
  });

  it('no emitted file contains the harness marker string or the fake harness uid', () => {
    const offenders: { file: string; needle: string }[] = [];
    const needles = ['guard-layout-harness', GUARD_HARNESS_UID];
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

describe('layout-oracle harness production isolation — static half', () => {
  const SRC_ROOT = path.join(WEB_ROOT, 'src');
  const GUARD_HARNESS_DIR = path.join(SRC_ROOT, 'guardHarness');

  function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        listSourceFiles(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('apps/web/guard-layout.html exists (sanity: this guard is not vacuous)', () => {
    expect(fs.existsSync(path.join(WEB_ROOT, 'guard-layout.html'))).toBe(true);
  });

  it('vite.config.ts never references the harness entry or carries a build.rollupOptions.input override', () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, 'vite.config.ts'), 'utf8');
    expect(source).not.toMatch(/guard-layout/i);
    expect(source).not.toMatch(/\binput\s*:/);
  });

  it('the production index.html never references the harness entry', () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
    expect(source).not.toMatch(/guard-layout/i);
  });

  it('no file outside src/guardHarness/ imports from it', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      if (file.startsWith(GUARD_HARNESS_DIR)) {
        continue;
      }
      const source = fs.readFileSync(file, 'utf8');
      if (/from ['"](@\/guardHarness|\.\.?\/.*guardHarness)/i.test(source)) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing under scripts/ (the Node-only Vite plugin + oracle runner) is imported by src/', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf8');
      if (
        /from ['"].*\/scripts\/(guardLayoutFixturePlugin|guardLayout|guardLayoutHarness)/i.test(
          source,
        )
      ) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
