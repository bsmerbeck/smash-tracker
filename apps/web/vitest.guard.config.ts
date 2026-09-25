import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Production-build guards (every `*.guard.test.ts` under `src/`), first added for the
 * SCL-01 perf harness (Phase 36 Plan 06, D-26). Deliberately separate from
 * `vitest.config.ts` and kept out of the default `test` script — each guard
 * runs a real `vite build`, so it is slow by nature; that cost is why it is
 * excluded from the default suite, not a reason to skip running it. Run
 * explicitly via `pnpm --filter @smash-tracker/web run guard:perf-harness-build`
 * (every guard) or `guard:chart-bundle` (the chart-bundle isolation guard
 * alone). `guard:chart-bundle` IS wired into CI (`.github/workflows/ci.yml`,
 * after `pnpm build`; pinned by `scripts/ciChartBundleGuard.test.mjs`,
 * 39.1-REVIEW WR-06) — do not "restore" an un-wired state.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.guard.test.ts'],
    testTimeout: 120_000,
    reporters: ['verbose'],
  },
});
