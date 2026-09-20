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
    //
    // Phase 39.1 Plan 09 (layout oracle): `scripts/guardLayoutCore.test.mjs`
    // is a PLAIN NODE test file (`node:test`, not vitest's `describe`/`it`)
    // so it is runnable standalone via `node --test`, the same "pure core,
    // unit-testable without a browser" split `scl01BrowserBudgetCore.mjs`
    // uses — but that sibling file uses vitest's own imports, so it is
    // deliberately NOT excluded here. Without this entry, vitest's default
    // include glob still matches `guardLayoutCore.test.mjs` (same `.test.mjs`
    // extension) and calling `node:test`'s `test()` registers nothing with
    // vitest's own collector, so vitest reports "No test suite found in
    // file" and fails the default suite on a file that node --test correctly
    // passes (verified empirically both ways before adding this line).
    exclude: [...configDefaults.exclude, '**/*.guard.test.ts', 'scripts/guardLayoutCore.test.mjs'],
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
