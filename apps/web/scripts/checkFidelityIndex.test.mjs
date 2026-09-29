/**
 * Plan 39.1-41 Task 2 (node:test): the ONE fidelity gate every Matchups
 * sketch-003 plan (39.1-41 … 48) runs — brief section 6 step 6. The module is
 * imported dynamically inside each test so a missing module fails the test,
 * not the file. The citation resolver reads FIXTURE COPIES of the registry
 * files (brief section 8, CONTEXT, UI-SPEC, sketches MANIFEST) written to a
 * temp phase directory here — never a hard-coded id list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./checkFidelityIndex.mjs', import.meta.url));

async function load() {
  return import(new URL('./checkFidelityIndex.mjs', import.meta.url).href);
}

const BRIEF = `# brief

## 8. Planner-decision registry

| Id | Decision |
|----|----------|
| PD-41-1 | Scoped trends start at quarter. |
| PD-41-2 | Tier dots. |

## 9. Old -> new numbering

| PD-49-9 | outside section 8, never a registered decision |
`;

const CONTEXT = `# context

<domain>
Phase boundary.
</domain>

- **D-06 (decided by owner):** all time.
- **D-15 (decided by owner):** the 12-month window.
`;

const UI_SPEC = `# UI-SPEC

## 6. Layout

### 6.1 \`PageShell\` and \`PageGrid\`

## 7. New Primitives

### 7.10 \`FormStrip\` — kit member #1

## 11. Mark bounds

| DD-07 | reading order |
`;

const MANIFEST = `# Sketch manifest

## Decisions taken at the sketch-003 review (owner, 2026-09-25)
`;

/** A temp `<root>/phases/39.1-x` phase dir with the four registry fixtures, plus a capture dir. */
function makePhaseDir({ omit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-index-'));
  const phaseDir = path.join(root, 'phases', '39.1-x');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'sketches'), { recursive: true });
  const files = {
    brief: [path.join(phaseDir, '39.1-MATCHUPS-SKETCH003-BRIEF.md'), BRIEF],
    context: [path.join(phaseDir, '39.1-CONTEXT.md'), CONTEXT],
    uiSpec: [path.join(phaseDir, '39.1-UI-SPEC.md'), UI_SPEC],
    manifest: [path.join(root, 'sketches', 'MANIFEST.md'), MANIFEST],
  };
  for (const [key, [file, text]] of Object.entries(files)) {
    if (key !== omit) fs.writeFileSync(file, text);
  }
  const indexDir = path.join(phaseDir, 'design-audit', 'matchups-fidelity', 'after-test');
  fs.mkdirSync(indexDir, { recursive: true });
  for (const ds of ['thin', 'deep']) {
    for (const w of ['1440', '390']) {
      fs.writeFileSync(path.join(indexDir, `side-by-side-${ds}-${w}.png`), Buffer.alloc(4096, 1));
    }
  }
  fs.writeFileSync(path.join(indexDir, 'tiny.png'), Buffer.alloc(100, 1));
  return { root, phaseDir, indexDir };
}

const HEADER = `| capture | dataset | width | element | observed | verdict |
|---|---|---|---|---|---|`;

function row(ds, w, element, observed, verdict, capture = `side-by-side-${ds}-${w}.png`) {
  return `| ${capture} | ${ds} | ${w} | ${element} | ${observed} | ${verdict} |`;
}

/** A complete, valid table for M2 and M16 across thin / deep x 1440 / 390. */
function validRows() {
  const rows = [];
  for (const ds of ['thin', 'deep']) {
    for (const w of ['1440', '390']) {
      rows.push(row(ds, w, 'M2 grain', 'quarterly on both sides', 'OK'));
      rows.push(row(ds, w, 'M16 page height', 'no horizontal scroll', 'OK'));
    }
  }
  return rows;
}

function table(rows) {
  return `# INDEX\n\n${HEADER}\n${rows.join('\n')}\n`;
}

async function evaluate(text, phaseDir, indexDir, overrides = {}) {
  const { evaluateFidelityIndex, loadCitationRegistry } = await load();
  return evaluateFidelityIndex(text, {
    elements: ['M2', 'M16'],
    datasets: ['thin', 'deep'],
    widths: ['1440', '390'],
    fileExists: (name) => {
      const file = path.join(indexDir, name);
      return fs.existsSync(file) ? fs.statSync(file).size : null;
    },
    registry: loadCitationRegistry(phaseDir),
    ...overrides,
  });
}

test('fidelity-index: a complete, valid table passes', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const result = await evaluate(table(validRows()), phaseDir, indexDir);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.malformed, []);
  assert.deepEqual(result.open, []);
  assert.equal(result.ok, true);
  assert.equal(result.rows, 8);
});

test('fidelity-index: every element x dataset x width without a row is missing', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const rows = validRows().filter((r) => !(r.includes('| deep | 390 |') && r.includes('M16')));
  const result = await evaluate(table(rows), phaseDir, indexDir);
  assert.deepEqual(result.missing, ['M16/deep/390']);
  assert.equal(result.ok, false);
  // M1 is never satisfied by an M16 row (the id must be a whole token).
  const m1 = await evaluate(table(validRows()), phaseDir, indexDir, { elements: ['M1'] });
  assert.equal(m1.missing.length, 4);
});

test('fidelity-index: a row that is not six cells, or has an empty element / observed cell, is malformed', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const five = '| side-by-side-thin-1440.png | thin | 1440 | M2 grain | OK |';
  const emptyObserved = row('thin', '1440', 'M2 labels', ' ', 'OK');
  const emptyElement = row('thin', '1440', ' ', 'something', 'OK');
  for (const bad of [five, emptyObserved, emptyElement]) {
    const result = await evaluate(table([...validRows(), bad]), phaseDir, indexDir);
    assert.equal(result.malformed.length, 1, bad);
    assert.equal(result.ok, false);
  }
});

test('fidelity-index: an unknown verdict is malformed — "DEFECT (open)" and free text included', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  for (const verdict of ['DEFECT (open)', 'Defect(open)', 'fine', 'OK-ish']) {
    const result = await evaluate(
      table([...validRows(), row('deep', '1440', 'M2 dots', 'x', verdict)]),
      phaseDir,
      indexDir,
    );
    assert.equal(result.malformed.length, 1, verdict);
    assert.equal(result.ok, false, verdict);
  }
});

test('fidelity-index: a capture that is missing or under 2 048 bytes is malformed', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const missing = row('deep', '1440', 'M2 dots', 'x', 'OK', 'side-by-side-nope-1440.png');
  const tiny = row('deep', '1440', 'M2 dots', 'x', 'OK', 'tiny.png');
  for (const bad of [missing, tiny]) {
    const result = await evaluate(table([...validRows(), bad]), phaseDir, indexDir);
    assert.equal(result.malformed.length, 1, bad);
  }
});

test('fidelity-index: a DECIDED row without a citation is malformed', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const result = await evaluate(
    table([...validRows(), row('deep', '1440', 'M2 band', 'the band is wider', 'DECIDED')]),
    phaseDir,
    indexDir,
  );
  assert.equal(result.malformed.length, 1);
  assert.match(result.malformed[0], /citation/);
});

test('fidelity-index: registered citations resolve (PD-41-1, D-15, DD-07, UI-SPEC section 7.10 / 11, CONTEXT domain, MANIFEST 2026-09-25)', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const observed = [
    'quarterly per PD-41-1',
    'fixed window, D-15',
    'reading order DD-07',
    '16px gap, UI-SPEC section 7.10',
    'empty quarters not drawn, UI-SPEC section 11',
    'the sidebar, UI-SPEC section 6.1',
    'scope, CONTEXT domain',
    'variant A, MANIFEST 2026-09-25',
  ];
  const rows = observed.map((o) => row('deep', '1440', 'M2 decided', o, 'DECIDED'));
  const result = await evaluate(table([...validRows(), ...rows]), phaseDir, indexDir);
  assert.deepEqual(result.malformed, []);
  assert.equal(result.ok, true);
});

test('fidelity-index: an invented PD-49-9, D-99, DD-99 or UI-SPEC section 99 is malformed unregistered:<token>', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  for (const [observed, token] of [
    ['per PD-49-9', 'PD-49-9'],
    ['per D-99', 'D-99'],
    ['per DD-99', 'DD-99'],
    ['per UI-SPEC section 99', 'UI-SPEC section 99'],
    ['per MANIFEST 2026-09-24', 'MANIFEST 2026-09-24'],
  ]) {
    const result = await evaluate(
      table([...validRows(), row('deep', '1440', 'M2 decided', observed, 'DECIDED')]),
      phaseDir,
      indexDir,
    );
    assert.equal(result.malformed.length, 1, observed);
    assert.match(result.malformed[0], new RegExp(`unregistered:${token}`), observed);
  }
});

test('fidelity-index: a real citation never launders an invented one (D-15 AND PD-49-9 fails)', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const result = await evaluate(
    table([...validRows(), row('deep', '1440', 'M2 decided', 'D-15 and PD-49-9', 'DECIDED')]),
    phaseDir,
    indexDir,
  );
  assert.equal(result.malformed.length, 1);
  assert.match(result.malformed[0], /unregistered:PD-49-9/);
});

test('fidelity-index: a DEFECT(fixed) row needs a 7-40 char hex commit hash', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const noHash = await evaluate(
    table([
      ...validRows(),
      row('deep', '1440', 'M2 dots', 'fixed in the last commit', 'DEFECT(fixed)'),
    ]),
    phaseDir,
    indexDir,
  );
  assert.equal(noHash.malformed.length, 1);
  const withHash = await evaluate(
    table([...validRows(), row('deep', '1440', 'M2 dots', 'fixed in dccddd33', 'DEFECT(fixed)')]),
    phaseDir,
    indexDir,
  );
  assert.deepEqual(withHash.malformed, []);
  assert.equal(withHash.ok, true);
});

test('fidelity-index: any DEFECT(open) row is open and fails', async () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const result = await evaluate(
    table([...validRows(), row('deep', '390', 'M2 labels', 'the 60% label clips', 'DEFECT(open)')]),
    phaseDir,
    indexDir,
  );
  assert.equal(result.open.length, 1);
  assert.equal(result.ok, false);
});

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('fidelity-index: the CLI prints FIDELITY_INDEX_OK and exits 0 on a valid table', () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const index = path.join(indexDir, 'INDEX.md');
  fs.writeFileSync(index, table(validRows()));
  const out = runCli(['--phase-dir', phaseDir, '--index', index, '--elements', 'M2,M16']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^FIDELITY_INDEX_OK rows=8$/m);
});

test('fidelity-index: the CLI prints FIDELITY_INDEX_FAIL and exits 1 on an open defect', () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const index = path.join(indexDir, 'INDEX.md');
  fs.writeFileSync(index, table([...validRows(), row('deep', '390', 'M2 x', 'y', 'DEFECT(open)')]));
  const out = runCli(['--phase-dir', phaseDir, '--index', index, '--elements', 'M2,M16']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^FIDELITY_INDEX_FAIL missing=\S* open=\S+ malformed=\S*$/m);
});

test('fidelity-index: a missing registry file is a hard FAIL, never a pass', () => {
  for (const omit of ['brief', 'context', 'uiSpec', 'manifest']) {
    const { phaseDir, indexDir } = makePhaseDir({ omit });
    const index = path.join(indexDir, 'INDEX.md');
    fs.writeFileSync(index, table(validRows()));
    const out = runCli(['--phase-dir', phaseDir, '--index', index, '--elements', 'M2,M16']);
    assert.equal(out.status, 1, omit);
    assert.match(out.stdout, /FIDELITY_INDEX_FAIL/, omit);
  }
});

// --gap-recheck (plan 48): the `## Gap re-check` table + the Metrics and
// Owner decisions requested sections.

function gapDoc({ rows, metrics = true, owner = true }) {
  return [
    '# MATCHUPS-FIDELITY',
    '',
    '## Gap re-check',
    '',
    '| gap | resolution | capture | status |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(metrics ? ['## Metrics', '', 'page heights'] : []),
    ...(owner ? ['', '## Owner decisions requested', '', '- PD-41-1'] : []),
    '',
  ].join('\n');
}

const GAP_ROWS = [
  '| trend grain | quarterly | side-by-side-deep-1440.png | closed |',
  '| strip gap | 16px, UI-SPEC section 7.10 | side-by-side-deep-390.png | DECIDED |',
];

function runGap(phaseDir, indexDir, text, minRows = 2) {
  const file = path.join(indexDir, 'MATCHUPS-FIDELITY.md');
  fs.writeFileSync(file, text);
  return runCli(['--phase-dir', phaseDir, '--gap-recheck', file, '--min-rows', String(minRows)]);
}

test('fidelity-index: gap re-check passes a complete document (GAP_RECHECK_OK)', () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const out = runGap(phaseDir, indexDir, gapDoc({ rows: GAP_ROWS }));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^GAP_RECHECK_OK rows=2$/m);
});

test('fidelity-index: gap re-check fails below --min-rows, on a bad status, an unresolved DECIDED, a missing PNG or a missing section', () => {
  const { phaseDir, indexDir } = makePhaseDir();
  const cases = [
    ['min-rows', gapDoc({ rows: GAP_ROWS }), 3],
    ['status', gapDoc({ rows: [...GAP_ROWS, '| x | y | side-by-side-deep-1440.png | open |'] }), 2],
    [
      'unresolved',
      gapDoc({ rows: [...GAP_ROWS, '| x | per PD-49-9 | side-by-side-deep-1440.png | DECIDED |'] }),
      2,
    ],
    [
      'uncited',
      gapDoc({ rows: [...GAP_ROWS, '| x | taste | side-by-side-deep-1440.png | DECIDED |'] }),
      2,
    ],
    ['no-png', gapDoc({ rows: [...GAP_ROWS, '| x | y | see above | closed |'] }), 2],
    ['missing-png', gapDoc({ rows: [...GAP_ROWS, '| x | y | nope.png | closed |'] }), 2],
    ['metrics', gapDoc({ rows: GAP_ROWS, metrics: false }), 2],
    ['owner', gapDoc({ rows: GAP_ROWS, owner: false }), 2],
  ];
  for (const [name, text, minRows] of cases) {
    const out = runGap(phaseDir, indexDir, text, minRows);
    assert.equal(out.status, 1, name);
    assert.match(out.stdout, /^GAP_RECHECK_FAIL /m, name);
  }
});
