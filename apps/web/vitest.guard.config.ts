import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * SCL-01 perf-harness production-build guard (Phase 36 Plan 06, D-26).
 * Deliberately separate from `vitest.config.ts` and never wired into CI or
 * the default `test` script — run explicitly via
 * `pnpm --filter @smash-tracker/web run guard:perf-harness-build`. Runs a
 * real `vite build`, so it is slow by nature; that cost is why it is
 * excluded from the default suite, not a reason to skip running it.
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
