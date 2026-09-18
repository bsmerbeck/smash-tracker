import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * A minimal structural shape for the pieces of Rolldown's `OutputChunk` this
 * guard reads. Deliberately NOT imported from the `rolldown` package: it is
 * `vite`'s own bundler dependency, not a declared dependency of this
 * workspace package, and importing its types directly would be a phantom
 * dependency on pnpm's strict `node_modules` layout.
 */
interface BuiltChunk {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry: boolean;
  imports: string[];
  moduleIds: string[];
}

/**
 * Phase 37 Plan 02 (CHRT-04/SCL-02, D-02/D-19): the BUILD-OUTPUT half of the
 * chart-kit bundle isolation guarantee. Before this file, "recharts never
 * touches the entry chunk" was a doc comment in `vite.config.ts` and a
 * developer's memory of having eyeballed one `pnpm build` — not an oracle
 * anyone could re-run. This file runs a REAL, UNMODIFIED `vite build` (via
 * `configFile`, mirroring `perfHarnessProductionBuild.guard.test.ts`'s
 * structure) into a throwaway temp `outDir` — never the tracked `dist/` — and
 * proves the isolation from the Rollup/Rolldown chunk GRAPH itself, not from
 * config source text: a chunk's `moduleIds` carry real module attribution
 * even after minification, where a content grep for the string `recharts`
 * would find nothing.
 *
 * Deliberately excluded from the default `pnpm test` run (own
 * `.guard.test.ts` suffix, `vitest.config.ts`'s `exclude`) — a real
 * production build per run is too slow for the default suite. Run explicitly
 * via `pnpm --filter @smash-tracker/web run guard:chart-bundle`.
 *
 * PROVEN FAILING (both directions, executed by hand during plan 37-02,
 * reverted before commit — see the plan's SUMMARY for the exact observed
 * messages):
 *   1. Temporarily adding `import '@/components/charts/TrendLine'` as a
 *      static import to `apps/web/src/main.tsx` (an eagerly-loaded file)
 *      turned the "nothing forbidden is eager" assertion red, naming the
 *      entry chunk and a `node_modules/recharts` module id.
 *   2. This guard's OWN measurement run is what caught the real SCL-02
 *      regression this file exists to prevent: the `manualChunks` API
 *      `vite.config.ts` used before this plan (legacy Rollup-compat form,
 *      translated by Rolldown into a `codeSplitting` group with
 *      `includeDependenciesRecursively` defaulted to `true`) swept `clsx`'s
 *      and `react`'s CJS-interop module into the `charts-vendor` chunk
 *      because `react-redux` requires them — and since those exact modules
 *      are ALSO reachable from already-eager code (`cn()`,
 *      `class-variance-authority`), the entry document gained a direct
 *      static import edge to `charts-vendor` and the modulepreload count
 *      measured 26, one over the 25 pre-phase baseline. See
 *      `vite.config.ts`'s doc comment for the full diagnosis and the fix
 *      (the non-deprecated `output.codeSplitting.groups` API with
 *      `includeDependenciesRecursively: false`). That fix is what makes this
 *      guard pass today.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The chart libraries this kit isolates, PLUS the recharts-exclusive runtime
 * dependencies the `charts-vendor` predicate places (verified against
 * `npm view recharts@3.10.1 dependencies` and `pnpm why` for each name —
 * plan 37-01/37-02). `clsx` and `use-sync-external-store` are deliberately
 * ABSENT: this app reaches them from eagerly-loaded code already (`cn()`,
 * `class-variance-authority`, `react-dom`'s CJS interop), so including them
 * here would make this guard permanently red against correct code (R1-MEDIUM-7).
 * If a future run flags one of the listed names because an eager module also
 * uses it, REMOVE that name from this set and from the chunk predicate with
 * the reason recorded — never widen this set to make the guard pass.
 */
const FORBIDDEN_CHART_MODULE =
  /node_modules[\\/](recharts|chart\.js|react-chartjs-2|victory-vendor|es-toolkit|@reduxjs[\\/]toolkit|react-redux|immer|reselect|decimal\.js-light|eventemitter3|tiny-invariant|d3-)/;

/**
 * Measured on 2026-09-17 by running this exact guard's own `beforeAll` build
 * once with a temporary logging line and counting `rel="modulepreload"`
 * occurrences in the emitted `outDir/index.html` — equivalently reproducible
 * via `pnpm --filter @smash-tracker/web run guard:chart-bundle` (this file's
 * own last `it` block performs the identical count on every run). Research
 * measured 25 on a pre-phase tree on 2026-09-17 (before this plan's
 * chart-kit work); this plan's own measurement, on the post-37-01-plus-fix
 * tree (see `vite.config.ts`'s doc comment for the `codeSplitting` fix this
 * measurement depended on), is ALSO exactly 25 — the fix restores the
 * pre-phase baseline exactly rather than merely getting under it. Equality
 * below is deliberate in BOTH directions: one link MORE is the boot-stall
 * regression class this lock exists to catch (it is what this guard caught,
 * at 26, during this plan's own execution before the fix); one link
 * FEWER is a real improvement that must be re-measured and re-baselined in a
 * reviewed diff, never silently absorbed by loosening this constant.
 *
 * Re-measured 2026-09-18 (plan 37-05, Counterpick Advisor gate/rank +
 * disclosure): re-running this guard's own build after 37-05's Task 1 (the
 * ONLY task that changed) moved the count from 25 to 26. Diagnosed by
 * building both the pre-37-05 tree and the post-Task-1 tree with the
 * SAME unmodified `vite.config.ts` in two disposable worktrees and diffing
 * the raw `href` list `rel="modulepreload"` resolves to: the other four
 * assertions in this file (eager-graph non-emptiness, nothing forbidden
 * eagerly reachable, `charts-vendor` lazy, the forbidden pattern matching
 * something) all stayed green — the new link is `AnalyticsFilterContext`'s
 * chunk, which was already part of the SAME eager bundle before (inlined
 * into the entry chunk), now split into its own file by Rolldown's
 * automatic chunking once 37-05's new shared-package file
 * (`packages/shared/src/evidence/pickBan.ts`, reached through the
 * already-eager `@smash-tracker/shared` barrel) grew that chunk past an
 * internal size threshold. No new import edge, no chart-library module in
 * the eager set — a chunking reshuffle of already-eager code, not the
 * boot-stall regression class this lock exists to catch. Re-baselined to 26
 * per this file's own instruction ("re-measured and re-baselined in a
 * reviewed diff, never silently absorbed").
 */
const ENTRY_MODULEPRELOAD_LOCK = 26;

let outDir: string;
let builtOutput: BuiltChunk[];

beforeAll(async () => {
  outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chart-bundle-isolation-guard-'));
  const result = await build({
    root: WEB_ROOT,
    configFile: path.join(WEB_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
    },
  });
  // `build()` returns `RollupOutput | RollupOutput[] | RollupWatcher` depending
  // on config; this project builds a single bundle with no watch mode, so the
  // single-output shape is the only one reachable here.
  const singleResult = Array.isArray(result) ? result[0] : result;
  builtOutput = (singleResult as { output: BuiltChunk[] }).output;
}, 120_000);

afterAll(async () => {
  if (outDir) {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

function outputChunks(): BuiltChunk[] {
  return builtOutput.filter((entry) => entry.type === 'chunk');
}

/**
 * The eager graph, computed from Rollup's own chunk-to-chunk `imports` field
 * (static import edges) — never `dynamicImports`, which is precisely the
 * lazy boundary this guard protects. A breadth-first closure starting from
 * every entry chunk.
 */
function computeEagerClosure(chunks: BuiltChunk[]): Set<string> {
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entryChunks = chunks.filter((chunk) => chunk.isEntry);
  const eager = new Set<string>();
  const queue: string[] = entryChunks.map((chunk) => chunk.fileName);
  while (queue.length > 0) {
    const fileName = queue.shift()!;
    if (eager.has(fileName)) continue;
    eager.add(fileName);
    const chunk = byFileName.get(fileName);
    if (!chunk) continue;
    for (const imported of chunk.imports) {
      if (!eager.has(imported)) {
        queue.push(imported);
      }
    }
  }
  return eager;
}

describe('chart bundle isolation — build-output guard (SCL-02, D-02, D-19)', () => {
  it('the eager graph is computed from real static-import edges, not guessed', () => {
    const chunks = outputChunks();
    const entryChunks = chunks.filter((chunk) => chunk.isEntry);
    expect(entryChunks.length).toBeGreaterThan(0);

    const eager = computeEagerClosure(chunks);
    for (const entryChunk of entryChunks) {
      expect(eager.has(entryChunk.fileName)).toBe(true);
    }
    // Recorded as an observation in the plan 37-02 SUMMARY, not asserted as a
    // minimum: the exact size is a property of this build, not a contract.
    expect(eager.size).toBeGreaterThan(0);
  });

  it('nothing forbidden is reachable from the eager (statically-imported) graph', () => {
    const chunks = outputChunks();
    const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const eager = computeEagerClosure(chunks);

    const offenders: { fileName: string; moduleId: string }[] = [];
    for (const fileName of eager) {
      const chunk = byFileName.get(fileName);
      if (!chunk) continue;
      const match = chunk.moduleIds.find((id) => FORBIDDEN_CHART_MODULE.test(id));
      if (match) {
        offenders.push({ fileName, moduleId: match });
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('the forbidden-module pattern is not vacuous — it matches something, somewhere', () => {
    const chunks = outputChunks();
    const anyMatch = chunks.some((chunk) =>
      chunk.moduleIds.some((id) => FORBIDDEN_CHART_MODULE.test(id)),
    );
    expect(anyMatch).toBe(true);
  });

  it('the manualChunks predicate produced exactly the charts-vendor chunk it promised (D-19), and it is lazy', () => {
    const chunks = outputChunks();
    const eager = computeEagerClosure(chunks);

    const chartsVendorChunks = chunks.filter((chunk) => chunk.fileName.includes('charts-vendor'));
    expect(chartsVendorChunks).toHaveLength(1);

    const chartsVendorChunk = chartsVendorChunks[0];
    if (!chartsVendorChunk) {
      throw new Error('expected exactly one charts-vendor chunk (asserted above)');
    }
    const hasRechartsModule = chartsVendorChunk.moduleIds.some((id) =>
      /node_modules[\\/]recharts[\\/]/.test(id),
    );
    expect(hasRechartsModule).toBe(true);
    expect(eager.has(chartsVendorChunk.fileName)).toBe(false);
  });

  it('the entry document preload budget is locked at the measured value (D-02/D-20)', () => {
    const entryHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const modulepreloadCount = (entryHtml.match(/rel="modulepreload"/g) ?? []).length;
    expect(modulepreloadCount).toBe(ENTRY_MODULEPRELOAD_LOCK);
  });
});
