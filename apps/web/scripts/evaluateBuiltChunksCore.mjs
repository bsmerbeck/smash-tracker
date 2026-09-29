/**
 * Plan 39.1-51: the pure half of `verify:built-chunks` (`evaluateBuiltChunks.mjs`).
 *
 * The PR #181 production crash (charts-vendor <-> TrendLine static chunk cycle,
 * `TypeError: undefined is not a function`) only shows when a browser evaluates the
 * BUILT chunks; jsdom and vitest never do. The CLI builds the production bundle,
 * serves it and imports chunks in headless Chrome; this module holds everything that
 * needs no browser, so node:test (`evaluateBuiltChunksCore.test.mjs`) can pin it.
 */

/** The `rel="modulepreload"` bound `bundleIsolation.guard.test.ts` enforces (read, never edited). */
export const MODULEPRELOAD_BOUND = 26;

/** The scenarios the CLI runs, in the order it prints them. */
export const SCENARIO_NAMES = [
  'eager-alone',
  'lazy-alone',
  'boot',
  'all-after-boot',
  'lazy-reverse',
  'every-chunk-alone',
];

export const CONTROL_NAMES = ['static-cycle', 'missing-export'];

const jsChunks = (chunks) => chunks.filter((c) => c.type === undefined || c.type === 'chunk');

/**
 * Entry chunks plus the closure of their static `imports` — never `dynamicImports`,
 * the lazy boundary (the same closure the chart-bundle guard computes).
 */
export function computeEagerClosure(chunks) {
  const byFileName = new Map(jsChunks(chunks).map((c) => [c.fileName, c]));
  const eager = new Set();
  const queue = jsChunks(chunks)
    .filter((c) => c.isEntry)
    .map((c) => c.fileName);
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (eager.has(fileName)) continue;
    eager.add(fileName);
    for (const imported of byFileName.get(fileName)?.imports ?? []) {
      if (!eager.has(imported)) queue.push(imported);
    }
  }
  return eager;
}

/**
 * Tarjan's strongly connected components over static `imports` edges. Returns every
 * component that is a cycle: two or more chunks, or one chunk importing itself.
 * Iterative, so a deep chunk graph cannot overflow the stack.
 */
export function findChunkCycles(chunks) {
  const nodes = jsChunks(chunks);
  const edges = new Map(nodes.map((c) => [c.fileName, c.imports ?? []]));
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  for (const start of nodes.map((c) => c.fileName)) {
    if (index.has(start)) continue;
    const work = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = (edges.get(frame.node) ?? []).filter((t) => edges.has(t));
      if (frame.next < targets.length) {
        const target = targets[frame.next];
        frame.next += 1;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        const selfLoop = (edges.get(frame.node) ?? []).includes(frame.node);
        if (component.length > 1 || selfLoop) sccs.push(component.sort());
      }
    }
  }
  return sccs;
}

/**
 * The chunk lists each scenario imports (sorted by file name, so runs compare):
 * eager-alone = the eager closure (entry included); lazy-alone = every dynamic-entry
 * chunk; every-chunk-alone = every JS chunk; lazy-reverse = lazy-alone reversed;
 * all-after-boot = lazy-alone in order.
 */
export function planScenarios(chunks) {
  const js = jsChunks(chunks);
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const eager = [...computeEagerClosure(js)].sort(byName);
  const lazy = js
    .filter((c) => c.isDynamicEntry)
    .map((c) => c.fileName)
    .sort(byName);
  return {
    'eager-alone': eager,
    'lazy-alone': lazy,
    'every-chunk-alone': js.map((c) => c.fileName).sort(byName),
    'lazy-reverse': [...lazy].reverse(),
    'all-after-boot': [...lazy],
  };
}

/**
 * Two deliberately broken chunks the evaluator must catch, written next to the real
 * chunks in the TEMP build output only:
 * - static-cycle: two chunks importing each other, each reading the other's `const`
 *   binding at top level. Importing one evaluates the other first against an
 *   uninitialized binding (the PR #181 mechanism) and throws.
 * - missing-export: a chunk importing a named export the entry chunk does not
 *   provide; module linking fails before anything evaluates.
 * `records` are the chunk-graph records Tarjan sees; `importTarget` is the file a
 * blank page imports.
 */
export function buildControlChunks({ entryFileName }) {
  const dir = entryFileName.includes('/')
    ? entryFileName.slice(0, entryFileName.lastIndexOf('/') + 1)
    : '';
  const entryBase = entryFileName.slice(dir.length);
  const a = `${dir}__control-cycle-a.js`;
  const b = `${dir}__control-cycle-b.js`;
  const missing = `${dir}__control-missing-export.js`;
  return [
    {
      name: 'static-cycle',
      importTarget: a,
      files: [
        {
          fileName: a,
          source: `import { controlB } from './__control-cycle-b.js';\nexport const controlA = 'a' + controlB.length;\n`,
        },
        {
          fileName: b,
          source: `import { controlA } from './__control-cycle-a.js';\nexport const controlB = 'b' + controlA.length;\n`,
        },
      ],
      records: [
        { fileName: a, imports: [b] },
        { fileName: b, imports: [a] },
      ],
    },
    {
      name: 'missing-export',
      importTarget: missing,
      files: [
        {
          fileName: missing,
          source: `import { __chunkEvalMissingExport } from './${entryBase}';\nexport const controlMissing = __chunkEvalMissingExport();\n`,
        },
      ],
      records: [{ fileName: missing, imports: [entryFileName] }],
    },
  ];
}

/**
 * The verdict: OK only when every real scenario ran at least one import with 0
 * errors, both controls were caught, the real graph has no cycle and the graph plus
 * the controls exactly one, the boot rendered, and modulepreload is within the bound.
 * Every failed condition is its own named reason.
 */
export function evaluateRun({
  scenarios,
  controls,
  sccs,
  controlSccs,
  bootRendered,
  modulepreload,
  modulepreloadBound = MODULEPRELOAD_BOUND,
}) {
  const reasons = [];
  const byName = new Map(scenarios.map((s) => [s.name, s]));
  for (const name of SCENARIO_NAMES) {
    const s = byName.get(name);
    if (!s || s.imports < 1) reasons.push(`scenario-no-imports:${name}`);
    if (s && s.errors > 0) reasons.push(`scenario-errors:${name}`);
  }
  const caught = new Map(controls.map((c) => [c.name, c.caught]));
  for (const name of CONTROL_NAMES) {
    if (caught.get(name) !== true) reasons.push(`control-not-caught:${name}`);
  }
  if (sccs !== 0) reasons.push('real-graph-cycle');
  else if (controlSccs !== 1) reasons.push('control-scc-count');
  if (!bootRendered) reasons.push('boot-not-rendered');
  if (!(modulepreload <= modulepreloadBound)) reasons.push('modulepreload-over-bound');
  return { ok: reasons.length === 0, reasons };
}
