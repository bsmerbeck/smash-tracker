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
 * would find nothing (except where it demonstrably does — see the content-
 * grep assertion below, which exists precisely because a library CAN leave
 * literal identifying strings in its own minified output, e.g. internal
 * error messages).
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
 *
 * ## The re-baseline history and why the count is now a BOUND, not a lock
 * (CR-01/WR-01 code-review fix, 2026-09-18)
 *
 * The exact `modulepreload` count was re-baselined 25 (research, pre-phase)
 * -> 26 (plan 37-05, Task 1: `AnalyticsFilterContext` split into its own
 * chunk once `packages/shared` grew by one file) -> **25 again** (some later
 * 37-06 change — new `retrospective.ts` ruleset-filtering logic and six
 * locales' worth of new `tournaments.retro.*` keys — pushed the eager module
 * graph back under whatever internal Rolldown chunking threshold triggered
 * the 26 split, with NO plan or SUMMARY after the 25->26 re-baseline ever
 * re-running this guard to notice). Three real, benign chunking reshuffles
 * in one phase prove the exact count is not a stable enough signal to be the
 * PRIMARY oracle: an exact-equality lock either goes permanently red on
 * ordinary healthy-tree churn (forcing a re-baseline nobody has an incentive
 * to actually investigate before rubber-stamping) or, worse, silently STAYS
 * GREEN across a same-count swap that trades one small chunk for one large
 * one — which is exactly the boot-stall hazard this guard exists to catch.
 *
 * The real protections, as of this fix, are (in order of what actually
 * catches a regression):
 *   1. **The eager-BYTES budget** (`EAGER_BYTES_BASELINE`/
 *      `EAGER_BYTES_TOLERANCE`, below) — sums the on-disk size of every
 *      chunk file in the eager closure (the same closure `computeEagerClosure`
 *      already computes from real static-import edges: every `modulepreload`-
 *      linked asset PLUS the entry script itself) and locks it at the
 *      measured value with a small tolerance. This is the metric that
 *      actually corresponds to the boot-stall mechanism (bytes-to-parse-and-
 *      execute before first paint), not a proxy for it.
 *   2. **The forbidden-library CONTENT grep** (`FORBIDDEN_LIBRARY_CONTENT_SIGNATURE`,
 *      below) — reads the actual bytes of every eager chunk file and checks
 *      for a forbidden library's own literal identifying strings (confirmed
 *      present in this app's real `charts-vendor` chunk: `recharts` and
 *      `react-redux` both survive minification as literal substrings, most
 *      likely from internal invariant/error messages). This is independent
 *      of and strictly additional to assertion 3 below (which reads Rollup's
 *      OWN `moduleIds` attribution, not raw bytes) — a defense-in-depth pair
 *      so a hole in one detection mechanism doesn't silently pass the other.
 *   3. The pre-existing `moduleIds`-based "nothing forbidden is reachable"
 *      assertion (module-graph attribution, survives minification because
 *      Rollup tracks it independently of the emitted source).
 *   4. `charts-vendor` chunk existence + laziness (D-19).
 *   5. **The modulepreload count is now a BOUND** (`ENTRY_MODULEPRELOAD_BOUND
 *      = 26`, i.e. the 25 baseline + 1), not an exact lock: an early-warning
 *      signal that stays green through the exact kind of benign reshuffle
 *      that hit this guard three times, while still catching a real,
 *      unreviewed GROWTH past baseline+1.
 *
 * **Re-baseline rule for `EAGER_BYTES_BASELINE`:** it may be re-baselined
 * DOWN (an eager-payload shrink) at any time with no special justification —
 * a smaller number is never the hazard this guard exists to catch. Re-
 * baselining it UP requires a reviewed, recorded reason in a diff (the same
 * standard the retired exact-count lock used), following the two-worktree
 * before/after build-diff method plan 37-05's SUMMARY established. Never
 * silently absorb a byte-budget failure by loosening the tolerance instead
 * of diagnosing the cause.
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
 * Content-level counterpart to `FORBIDDEN_CHART_MODULE` above (WR-01/CR-01
 * fix): matches a forbidden library's own literal name as it can survive
 * INSIDE minified emitted bytes (e.g. an internal error/invariant message),
 * independent of Rollup's `moduleIds` attribution metadata. No
 * `node_modules[\\/]` path prefix here — this pattern is tested against raw
 * file CONTENT, which never contains a source path for code that ships in
 * production. Confirmed non-vacuous against this app's own `charts-vendor`
 * chunk (`recharts` and `react-redux` both appear literally); `d3-*`,
 * `es-toolkit`, and `victory-vendor` are NOT expected to appear literally
 * (they're fully renamed/tree-shaken away) — their presence here is
 * defense-in-depth for a future recharts/d3 version that stops doing so, not
 * a claim that they currently match anything.
 */
const FORBIDDEN_LIBRARY_CONTENT_SIGNATURE =
  /\b(recharts|victory-vendor|react-redux|@reduxjs\/toolkit|es-toolkit|chart\.js|react-chartjs-2|d3-[a-z]+)\b/;

/**
 * The modulepreload count is now a BOUND (early-warning signal), not the
 * primary lock — see the top-of-file doc comment's "re-baseline history"
 * section for the full reasoning. 25 is the last-measured healthy baseline
 * (2026-09-18, post-37-06); 26 (+1) tolerates the exact kind of benign
 * single-chunk-split reshuffle this guard has now observed twice in one
 * phase without forcing an unreviewed re-baseline. A measurement ABOVE 26
 * still fails loudly; a measurement of 25 or 26 passes without needing a
 * diff. The eager-BYTES budget below is what actually catches a same-count
 * payload-weight regression this bound alone would miss.
 */
const ENTRY_MODULEPRELOAD_BOUND = 26;

/**
 * Eager-payload byte budget (WR-01 fix): the sum of the on-disk size of
 * every file in the eager closure (every `modulepreload`-linked chunk PLUS
 * the entry script itself — the same 26-file set `computeEagerClosure`
 * computes from real static-import edges). Measured fresh against this
 * commit (2026-09-18, HEAD `4780caf2`, after all of 37-01..37-06) by running
 * THIS EXACT guard file under `pnpm --filter @smash-tracker/web run
 * guard:chart-bundle` (i.e. `vite build()` invoked from inside a Vitest
 * worker process): 1,056,636 bytes, reproduced identically across 3 cold
 * process runs.
 *
 * **This number is deliberately NOT the same as a plain `pnpm build`'s
 * `dist/` output for the same eager set** (measured separately, via a bare
 * Node script invoking the identical unmodified `vite.config.ts` outside
 * any Vitest process: 835,184 bytes — about 21% smaller). Root cause not
 * fully chased down (out of scope for this fix), but confirmed to be a
 * broad, uniform inflation across nearly every emitted chunk (not a
 * chart-library leak: the eager file SET is byte-for-byte identical between
 * the two contexts — same 26 filenames, same content-grep/moduleIds
 * results — only the absolute sizes differ), consistent with Vite/Rolldown
 * resolving a less-optimized build target or output shape when nested
 * inside a Vitest worker versus a bare CLI/Node invocation. Since this
 * guard ALWAYS runs its measurement through the nested-under-Vitest path
 * (that's what `pnpm run guard:chart-bundle` actually executes), the
 * baseline is measured and locked through that SAME path — the number that
 * matters is "does this guard's own repeatable measurement regress",
 * not "does it match `dist/`'s reported size". Do not re-baseline this
 * constant using a bare `pnpm build` measurement; always use this guard's
 * own run.
 *
 * Tolerance is `min(2% of baseline, 16 KiB)`: 2% of 1,056,636 is
 * 21,132.72 B; 16 KiB (16,384 B) is the smaller of the two, so 16,384 B is
 * what's used. Locked upper bound: 1,056,636 + 16,384 = 1,073,020 B. A
 * measurement at or below that bound passes; anything above it is a real,
 * reviewable payload regression. See the top-of-file doc comment for the
 * re-baseline rule.
 */
/**
 * Re-baselined UP 1_056_636 → 1_126_712 on 2026-09-22 (owner decision, Phase 39.1
 * close-out). Measured on a fresh `pnpm build` at HEAD after plans 39.1-01..24
 * and the review-fix chain. Attribution from the per-wave build logs
 * (39.1-ORCHESTRATOR-NOTES.md, Finding 5): the eager `i18n-*.js` chunk grew
 * ~14 kB when the English insight vocabulary landed (39.1-11, 208 leaf keys);
 * the eager shared-package chunk grew ~3 kB with the part of the insight
 * engine the analytics pages pull through the `@smash-tracker/shared` barrel;
 * the entry stylesheet grew ~2 kB (Tailwind scanning ~40 new components); the
 * remaining ~50 kB predates the first measurement (2026-09-20, 1,094,696 B)
 * and is unattributed between Phase 38 and 39.1's Track B. No forbidden
 * library reached the eager graph at any point (this guard's other seven
 * assertions stayed green throughout). Follow-ups the owner may still choose:
 * lazy-load the `insights`/`analytics` locale namespaces (−~14 kB per locale)
 * or split the insight engine out of the eager shared chunk.
 */
const EAGER_BYTES_BASELINE = 1_126_712;
const EAGER_BYTES_TOLERANCE = 16 * 1024;

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

  it("no eager-path asset file contains a forbidden library's own bytes, verified by content — not module attribution (WR-01/CR-01)", () => {
    const chunks = outputChunks();
    const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const eager = computeEagerClosure(chunks);

    const offenders: { fileName: string; signature: string }[] = [];
    for (const fileName of eager) {
      const chunk = byFileName.get(fileName);
      if (!chunk || chunk.type !== 'chunk') continue;
      const filePath = path.join(outDir, fileName);
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(FORBIDDEN_LIBRARY_CONTENT_SIGNATURE);
      if (match) {
        offenders.push({ fileName, signature: match[0] });
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('the forbidden-library content signature is not vacuous — it matches inside the (lazy) charts-vendor chunk', () => {
    const chunks = outputChunks();
    const chartsVendorChunk = chunks.find((chunk) => chunk.fileName.includes('charts-vendor'));
    if (!chartsVendorChunk) {
      throw new Error('expected a charts-vendor chunk (asserted in the sibling test above)');
    }
    const content = fs.readFileSync(path.join(outDir, chartsVendorChunk.fileName), 'utf8');
    expect(FORBIDDEN_LIBRARY_CONTENT_SIGNATURE.test(content)).toBe(true);
  });

  it('the entry document preload count stays within the early-warning bound (D-02/D-20)', () => {
    const entryHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const modulepreloadCount = (entryHtml.match(/rel="modulepreload"/g) ?? []).length;
    expect(modulepreloadCount).toBeLessThanOrEqual(ENTRY_MODULEPRELOAD_BOUND);
  });

  it('the eager-payload byte budget is locked at the measured value with a small tolerance (D-02/WR-01)', () => {
    const chunks = outputChunks();
    const eager = computeEagerClosure(chunks);

    let totalBytes = 0;
    for (const fileName of eager) {
      const filePath = path.join(outDir, fileName);
      totalBytes += fs.statSync(filePath).size;
    }

    expect(totalBytes).toBeGreaterThan(0);
    expect(totalBytes).toBeLessThanOrEqual(EAGER_BYTES_BASELINE + EAGER_BYTES_TOLERANCE);
  });
});
