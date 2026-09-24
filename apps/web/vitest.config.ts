import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// IN-01 (39.1-REVIEW iteration 2): fine-grain period labels, form-strip tick
// titles and session captions format in the host's LOCAL zone (WR-02), so
// their fixtures only hold in some zones (a noon-UTC fixture is a different
// day at UTC+12..+14). Pin the whole web unit run to UTC — the zone CI
// runners already use — so the suite is deterministic on every host. Set
// here, before vitest forks its workers, so each worker starts in UTC; a
// test that needs another zone (`periodTicks.timezone.test.ts`) overrides
// `process.env.TZ` itself before importing the module under test.
process.env.TZ = 'UTC';

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
    // Phase 39.1 Plan 10 (palette oracle): `scripts/guardPaletteCore.test.mjs`
    // is the SAME plain-`node:test` shape as `guardLayoutCore.test.mjs` above
    // (its own `<verify>` command is `node --test`, not vitest) — excluded
    // for the identical reason.
    //
    // WR-B04 (39.1-REVIEW.md): `scripts/guardLayoutShutdown.test.mjs` is the
    // same plain-`node:test` shape too — all three are wired into the root
    // `test` script's `test:guards` step below (via `node --test`) instead,
    // so vitest's own suite never touches them. WR-06 (39.1-REVIEW):
    // `scripts/ciChartBundleGuard.test.mjs` (pins the CI chart-bundle guard
    // step) is the same shape and wired the same way.
    exclude: [
      ...configDefaults.exclude,
      '**/*.guard.test.ts',
      'scripts/guardLayoutCore.test.mjs',
      'scripts/guardPaletteCore.test.mjs',
      'scripts/guardLayoutShutdown.test.mjs',
      'scripts/ciChartBundleGuard.test.mjs',
    ],
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
