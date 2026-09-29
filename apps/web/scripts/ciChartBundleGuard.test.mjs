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
 * CI is now several jobs on separate runners, so a `pnpm build` in one job
 * does not come before a guard in another. The original global text-order
 * check would pass on exactly that broken layout; the pin is therefore
 * job-aware (`checkChartBundleGuard` requires the build in the SAME job as
 * the guard, before it).
 *
 * Plain Node test, run via `node --test` alongside the other guard tests
 * (`pnpm --filter @smash-tracker/web test:guards`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkChartBundleGuard } from './ciWorkflowCore.mjs';

const ciPath = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

test('CI runs the chart-bundle guard after the build, in the same job', () => {
  const ci = readFileSync(ciPath, 'utf8');
  assert.deepEqual(checkChartBundleGuard(ci), []);
});

test('the pin is job-aware: a build in a different job does not satisfy the guard', () => {
  const crossJob = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: pnpm build',
    '  b:',
    '    steps:',
    '      - run: pnpm --filter @smash-tracker/web guard:chart-bundle',
    '',
  ].join('\n');
  const violations = checkChartBundleGuard(crossJob);
  assert.ok(
    violations.some((v) => v.startsWith('CHART_BUILD_MISSING')),
    `expected CHART_BUILD_MISSING, got ${JSON.stringify(violations)}`,
  );
});

test('the guard script CI calls exists and targets the bundle-isolation guard', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.match(pkg.scripts['guard:chart-bundle'] ?? '', /bundleIsolation\.guard\.test\.ts/);
});
