/**
 * Plan 39.1-51: node:test cases for `evaluateBuiltChunksCore.mjs`, the pure half of
 * `pnpm --filter @smash-tracker/web run verify:built-chunks` (the PR #181 class:
 * a built chunk that throws when a browser evaluates it — jsdom and vitest never
 * evaluate built chunks). No browser, no Vite. The core is imported inside each
 * test body so a missing module fails every case by name instead of the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const loadCore = () => import('./evaluateBuiltChunksCore.mjs');

/** A chunk record in the shape vite build() returns. */
function chunk(
  fileName,
  { isEntry = false, isDynamicEntry = false, imports = [], dynamicImports = [] } = {},
) {
  return { type: 'chunk', fileName, isEntry, isDynamicEntry, imports, dynamicImports };
}

const sortSccs = (sccs) => sccs.map((s) => [...s].sort()).sort((a, b) => a[0].localeCompare(b[0]));

test('built-chunks: computeEagerClosure follows static imports from every entry, never dynamicImports', async () => {
  const { computeEagerClosure } = await loadCore();
  const chunks = [
    chunk('assets/index.js', {
      isEntry: true,
      imports: ['assets/react.js'],
      dynamicImports: ['assets/Page.js'],
    }),
    chunk('assets/react.js', { imports: ['assets/shared.js'] }),
    chunk('assets/shared.js'),
    chunk('assets/Page.js', {
      isDynamicEntry: true,
      imports: ['assets/shared.js', 'assets/charts.js'],
    }),
    chunk('assets/charts.js'),
  ];
  const eager = computeEagerClosure(chunks);
  assert.deepEqual([...eager].sort(), ['assets/index.js', 'assets/react.js', 'assets/shared.js']);
  assert.equal(
    eager.has('assets/Page.js'),
    false,
    'a lazy chunk reachable only dynamically stays out',
  );
  assert.equal(eager.has('assets/charts.js'), false);
});

test('built-chunks: findChunkCycles returns [] for an acyclic graph', async () => {
  const { findChunkCycles } = await loadCore();
  const chunks = [chunk('a', { imports: ['b'] }), chunk('b', { imports: ['c'] }), chunk('c')];
  assert.deepEqual(findChunkCycles(chunks), []);
});

test('built-chunks: findChunkCycles finds a <-> b as one SCC', async () => {
  const { findChunkCycles } = await loadCore();
  const chunks = [
    chunk('a', { imports: ['b'] }),
    chunk('b', { imports: ['a'] }),
    chunk('c', { imports: ['a'] }),
  ];
  assert.deepEqual(sortSccs(findChunkCycles(chunks)), [['a', 'b']]);
});

test('built-chunks: findChunkCycles finds a self-import as one SCC', async () => {
  const { findChunkCycles } = await loadCore();
  const chunks = [chunk('a', { imports: ['a'] }), chunk('b', { imports: ['a'] })];
  assert.deepEqual(findChunkCycles(chunks), [['a']]);
});

test('built-chunks: findChunkCycles names all three chunks of the PR #181 shape', async () => {
  const { findChunkCycles } = await loadCore();
  const chunks = [
    chunk('assets/index.js', { isEntry: true, dynamicImports: ['assets/MatchupsPage.js'] }),
    chunk('assets/MatchupsPage.js', { isDynamicEntry: true, imports: ['assets/charts-vendor.js'] }),
    chunk('assets/charts-vendor.js', { imports: ['assets/TrendLine.js'] }),
    chunk('assets/TrendLine.js', { imports: ['assets/redux-shim.js'] }),
    chunk('assets/redux-shim.js', { imports: ['assets/charts-vendor.js'] }),
  ];
  assert.deepEqual(sortSccs(findChunkCycles(chunks)), [
    ['assets/TrendLine.js', 'assets/charts-vendor.js', 'assets/redux-shim.js'],
  ]);
});

test('built-chunks: findChunkCycles finds two disjoint cycles as two SCCs', async () => {
  const { findChunkCycles } = await loadCore();
  const chunks = [
    chunk('a', { imports: ['b'] }),
    chunk('b', { imports: ['a'] }),
    chunk('c', { imports: ['d'] }),
    chunk('d', { imports: ['e'] }),
    chunk('e', { imports: ['c'] }),
  ];
  assert.deepEqual(sortSccs(findChunkCycles(chunks)), [
    ['a', 'b'],
    ['c', 'd', 'e'],
  ]);
});

test('built-chunks: planScenarios lists eager-alone, lazy-alone, every-chunk-alone, lazy-reverse and all-after-boot', async () => {
  const { planScenarios } = await loadCore();
  const chunks = [
    chunk('assets/index.js', {
      isEntry: true,
      imports: ['assets/react.js'],
      dynamicImports: ['assets/B.js', 'assets/A.js'],
    }),
    chunk('assets/react.js'),
    chunk('assets/A.js', { isDynamicEntry: true, imports: ['assets/util.js'] }),
    chunk('assets/B.js', { isDynamicEntry: true }),
    chunk('assets/util.js'),
    { type: 'asset', fileName: 'assets/index.css' },
  ];
  const plan = planScenarios(chunks);
  assert.deepEqual(plan['eager-alone'], ['assets/index.js', 'assets/react.js']);
  assert.deepEqual(plan['lazy-alone'], ['assets/A.js', 'assets/B.js']);
  assert.deepEqual(plan['every-chunk-alone'], [
    'assets/A.js',
    'assets/B.js',
    'assets/index.js',
    'assets/react.js',
    'assets/util.js',
  ]);
  assert.deepEqual(plan['lazy-reverse'], ['assets/B.js', 'assets/A.js']);
  assert.deepEqual(plan['all-after-boot'], ['assets/A.js', 'assets/B.js']);
});

test('built-chunks: buildControlChunks writes a mutual top-level-read cycle pair and a missing-export chunk, all named __control-', async () => {
  const { buildControlChunks } = await loadCore();
  const controls = buildControlChunks({ entryFileName: 'assets/index-abc.js' });
  const byName = new Map(controls.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ['missing-export', 'static-cycle']);

  const cycle = byName.get('static-cycle');
  assert.equal(cycle.files.length, 2);
  const [a, b] = cycle.files;
  const base = (f) => path.posix.basename(f.fileName);
  assert.match(a.source, new RegExp(`from '\\./${base(b)}'`), 'a imports b');
  assert.match(b.source, new RegExp(`from '\\./${base(a)}'`), 'b imports a');
  // Each reads the other's binding at top level (outside any function).
  assert.match(a.source, /export const \w+ = .*\bcontrolB\b/);
  assert.match(b.source, /export const \w+ = .*\bcontrolA\b/);
  assert.deepEqual(
    cycle.records.map((r) => [r.fileName, r.imports]),
    [
      [a.fileName, [b.fileName]],
      [b.fileName, [a.fileName]],
    ],
  );

  const missing = byName.get('missing-export');
  assert.equal(missing.files.length, 1);
  assert.match(missing.files[0].source, /import \{ (\w+) \} from '\.\/index-abc\.js'/);
  assert.deepEqual(missing.records, [
    { fileName: missing.files[0].fileName, imports: ['assets/index-abc.js'] },
  ]);

  for (const c of controls) {
    assert.ok(
      c.files.some((f) => f.fileName === c.importTarget),
      `${c.name} import target is one of its files`,
    );
    for (const f of c.files) assert.ok(base(f).startsWith('__control-'), f.fileName);
  }
});

function okRun() {
  return {
    scenarios: [
      { name: 'eager-alone', pages: 3, imports: 3, errors: 0 },
      { name: 'lazy-alone', pages: 2, imports: 2, errors: 0 },
      { name: 'boot', pages: 1, imports: 1, errors: 0 },
      { name: 'all-after-boot', pages: 1, imports: 2, errors: 0 },
      { name: 'lazy-reverse', pages: 1, imports: 2, errors: 0 },
      { name: 'every-chunk-alone', pages: 6, imports: 6, errors: 0 },
    ],
    controls: [
      { name: 'static-cycle', caught: true },
      { name: 'missing-export', caught: true },
    ],
    sccs: 0,
    controlSccs: 1,
    bootRendered: true,
    modulepreload: 25,
  };
}

test('built-chunks: evaluateRun is OK on a clean run', async () => {
  const { evaluateRun } = await loadCore();
  assert.deepEqual(evaluateRun(okRun()), { ok: true, reasons: [] });
});

test('built-chunks: evaluateRun names a real scenario with errors', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.scenarios[1].errors = 1;
  assert.deepEqual(evaluateRun(run), { ok: false, reasons: ['scenario-errors:lazy-alone'] });
});

test('built-chunks: evaluateRun names a control that was not caught', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.controls[0].caught = false;
  assert.deepEqual(evaluateRun(run), { ok: false, reasons: ['control-not-caught:static-cycle'] });
  const run2 = okRun();
  run2.controls = run2.controls.filter((c) => c.name !== 'missing-export');
  assert.deepEqual(evaluateRun(run2), {
    ok: false,
    reasons: ['control-not-caught:missing-export'],
  });
});

test('built-chunks: evaluateRun names a cycle in the real chunk graph', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.sccs = 1;
  run.controlSccs = 2;
  assert.deepEqual(evaluateRun(run), { ok: false, reasons: ['real-graph-cycle'] });
});

test('built-chunks: evaluateRun names a control pair that does not form exactly one SCC', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.controlSccs = 0;
  assert.deepEqual(evaluateRun(run), { ok: false, reasons: ['control-scc-count'] });
});

test('built-chunks: evaluateRun names a boot that rendered nothing', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.bootRendered = false;
  assert.deepEqual(evaluateRun(run), { ok: false, reasons: ['boot-not-rendered'] });
});

test('built-chunks: evaluateRun names a scenario that ran no import (or never ran)', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.scenarios[3].imports = 0;
  assert.deepEqual(evaluateRun(run), {
    ok: false,
    reasons: ['scenario-no-imports:all-after-boot'],
  });
  const run2 = okRun();
  run2.scenarios = run2.scenarios.filter((s) => s.name !== 'lazy-reverse');
  assert.deepEqual(evaluateRun(run2), { ok: false, reasons: ['scenario-no-imports:lazy-reverse'] });
});

test('built-chunks: evaluateRun names a modulepreload count above 26', async () => {
  const { evaluateRun } = await loadCore();
  const run = okRun();
  run.modulepreload = 27;
  assert.deepEqual(evaluateRun(run), { ok: false, reasons: ['modulepreload-over-bound'] });
  const run2 = okRun();
  run2.modulepreload = 26;
  assert.deepEqual(evaluateRun(run2), { ok: true, reasons: [] });
});
