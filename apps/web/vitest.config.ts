import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    // SCL-01 perf-harness build guard (D-26 precedent): a real `vite build`
    // per run is too slow for the default suite — it runs only via
    // `pnpm run guard:perf-harness-build` (vitest.guard.config.ts).
    exclude: [...configDefaults.exclude, '**/*.guard.test.ts'],
    // GitHub Actions runners are ~3x slower than dev hardware; the heaviest
    // userEvent interaction tests (e.g. GspPage Quick Logger double-entry)
    // legitimately exceed vitest's 5s default there. 15s still catches hangs.
    testTimeout: 15_000,
    alias: {
      // jsdom has no canvas; the real chart components only produce
      // "Not implemented: getContext" / "Failed to create chart" noise in
      // test output. Chart math is covered by each chart's exported pure
      // builder functions, so components render a stable placeholder.
      'react-chartjs-2': fileURLToPath(
        new URL('./src/test/stubs/react-chartjs-2.tsx', import.meta.url),
      ),
    },
  },
});
