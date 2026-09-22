import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Modules matched into the `charts-vendor` chunk (SCL-02, D-01, D-19): recharts
 * 3.10.1's own source plus the runtime dependencies that ONLY it uses in this
 * app (`d3-*`, `es-toolkit`, `victory-vendor`, `@reduxjs/toolkit`,
 * `react-redux`, `immer`, `reselect`, `decimal.js-light`, `eventemitter3`,
 * `tiny-invariant` — confirmed via `pnpm why` against every one of these
 * names, plan 37-01/37-02). `clsx`, `react` and `react-dom` are deliberately
 * NOT matched here — this app (or its already-eager deps, e.g.
 * `class-variance-authority`'s use of `clsx`) already reaches those modules
 * eagerly, and capturing a shared module in this chunk is the exact SCL-02
 * hazard this predicate exists to avoid.
 *
 * `redux`, `redux-thunk`, `internmap`, `react-is` and the `with-selector`
 * entry points of `use-sync-external-store` ARE matched (production incident
 * 2026-09-22): nothing eager imports them — they are reached only through
 * recharts/react-redux/d3 — and leaving them unmatched let Rolldown place them
 * in the lazy TrendLine chunk, which imports charts-vendor while charts-vendor
 * imported them back. `use-sync-external-store/shim/index.js` itself stays
 * unmatched: it IS eager (react-i18next's `useTranslation` chunk). That static cycle
 * threw `undefined is not a function` evaluating charts-vendor on Matchups.
 * `bundleIsolation.guard.test.ts` asserts charts-vendor is in no chunk cycle
 * and that nothing forbidden reaches the eager graph, so a wrong call here
 * fails either way.
 *
 * Plan 37-02 (bundleIsolation.guard.test.ts's first real run) measured this
 * exact leak: the legacy `output.manualChunks` function API (used by 37-01)
 * is translated by Rolldown (Vite 8's bundler) into a `codeSplitting.groups`
 * entry with `includeDependenciesRecursively` defaulted to `true` — which
 * sweeps the FULL transitive dependency closure of every matched module
 * (including `clsx`/`react`'s CJS interop copy/`use-sync-external-store`,
 * pulled in by `react-redux`) into the SAME physical chunk, even though the
 * predicate function itself never matches those names. Because those exact
 * modules are also reachable from already-eager code (`clsx` via `cn()` and
 * `class-variance-authority`; `react`'s CJS build via `react-dom`), Rolldown
 * co-located them inside the `charts-vendor` chunk and the ENTRY document
 * gained a direct static import edge to it — a real, measured boot-stall
 * regression (26 modulepreload links, one over the 25 baseline). Switching to
 * the modern, non-deprecated `output.codeSplitting.groups` API with
 * `includeDependenciesRecursively: false` restores the isolation: only
 * modules that literally match `test` land in `charts-vendor`; everything
 * else (including the shared runtime bits above) falls back to Rolldown's
 * default automatic chunking, which correctly keeps them in the pre-existing
 * eager chunks they already belonged to. Verified by
 * `bundleIsolation.guard.test.ts`: 25 modulepreload links, `charts-vendor`
 * absent from the eager closure, zero forbidden modules reachable from entry.
 */
const CHARTS_VENDOR_TEST =
  /node_modules[\\/](?:(recharts|d3-[^\\/]*|internmap|es-toolkit|victory-vendor|@reduxjs[\\/]toolkit|react-redux|redux|redux-thunk|react-is|immer|reselect|decimal\.js-light|eventemitter3|tiny-invariant)[\\/]|use-sync-external-store[\\/].*with-selector)/;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'charts-vendor',
              test: CHARTS_VENDOR_TEST,
              // D-19/SCL-02: do NOT sweep in the full dependency closure of
              // matched modules — see the doc comment above.
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
});
