import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 36 Plan 06 (SCL-01 Task 3B): STATIC half of the perf-harness
 * production-isolation guard — part of the normal `pnpm test` run (fast,
 * no build required). The BUILD-OUTPUT half lives in the separate,
 * excluded-from-default-run `perfHarnessProductionBuild.guard.test.ts`
 * (run via `pnpm --filter @smash-tracker/web run guard:perf-harness-build`).
 *
 * This half proves the STRUCTURAL precondition that makes the build-output
 * guard true: nothing OUTSIDE `src/perfHarness/` ever imports from it, and
 * neither the tracked `vite.config.ts` nor the production `index.html`
 * references the harness entry — so `vite build`'s default single-entry
 * behavior (no `build.rollupOptions.input` override) is the only thing
 * that can ever decide what ships, and it never sees the harness.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_ROOT = path.join(WEB_ROOT, 'src');
const PERF_HARNESS_DIR = path.join(SRC_ROOT, 'perfHarness');

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

describe('perf harness production isolation — static half', () => {
  it('apps/web/perf-harness.html exists (sanity: this guard is not vacuous)', () => {
    expect(fs.existsSync(path.join(WEB_ROOT, 'perf-harness.html'))).toBe(true);
  });

  it('vite.config.ts never references the harness entry or a build.rollupOptions.input override', () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, 'vite.config.ts'), 'utf8');
    expect(source).not.toMatch(/perf-harness/i);
    expect(source).not.toMatch(/rollupOptions/);
  });

  it('the production index.html never references the harness entry', () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
    expect(source).not.toMatch(/perf-harness/i);
  });

  it('no file outside src/perfHarness/ imports from it', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      if (file.startsWith(PERF_HARNESS_DIR)) {
        continue;
      }
      const source = fs.readFileSync(file, 'utf8');
      if (/from ['"](@\/perfHarness|\.\.?\/.*perfHarness)/i.test(source)) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing under scripts/ (the Node-only Vite plugin + measurement script) is imported by src/', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf8');
      if (/from ['"].*\/scripts\/(perfFixturePlugin|scl01BrowserBudget)/i.test(source)) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
