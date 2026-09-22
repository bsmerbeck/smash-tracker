/**
 * WR-06 (39.1-REVIEW): the chart-bundle guard (`guard:chart-bundle` —
 * `bundleIsolation.guard.test.ts`, including its no-chunk-cycle assertion)
 * is excluded from `pnpm test` because it runs a real production build, so
 * it only protects anything if CI runs it. The 2026-09-22 charts-vendor
 * incident shipped through exactly that gap (jsdom/vitest never evaluate
 * built chunks). This pins the CI step: `.github/workflows/ci.yml` must run
 * the web package's `guard:chart-bundle` script, AFTER the workspace build
 * (the guard's Vite build resolves `@smash-tracker/shared` from its built
 * `dist/`).
 *
 * Plain Node test, run via `node --test` alongside the other guard tests
 * (`pnpm --filter @smash-tracker/web test:guards`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ciPath = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

test('CI runs the chart-bundle guard after the build', () => {
  const ci = readFileSync(ciPath, 'utf8');
  const runLines = ci
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('run:'))
    .map((line) => line.slice('run:'.length).trim());
  const guardIndex = runLines.findIndex((cmd) =>
    /pnpm --filter @smash-tracker\/web (run )?guard:chart-bundle$/.test(cmd),
  );
  const buildIndex = runLines.indexOf('pnpm build');
  assert.notEqual(
    guardIndex,
    -1,
    'ci.yml has no `pnpm --filter @smash-tracker/web guard:chart-bundle` step',
  );
  assert.notEqual(buildIndex, -1, 'ci.yml has no `pnpm build` step');
  assert.ok(guardIndex > buildIndex, 'the chart-bundle guard must run after `pnpm build`');
});

test('the guard script CI calls exists and targets the bundle-isolation guard', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.match(pkg.scripts['guard:chart-bundle'] ?? '', /bundleIsolation\.guard\.test\.ts/);
});
