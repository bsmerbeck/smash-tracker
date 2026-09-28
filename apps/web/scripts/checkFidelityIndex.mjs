#!/usr/bin/env node
/**
 * Plan 39.1-41 Task 2: the ONE fidelity gate every Matchups sketch-003 plan
 * (39.1-41 … 48) runs — `39.1-MATCHUPS-SKETCH003-BRIEF.md` section 6 step 6.
 *
 * USAGE:
 *   node apps/web/scripts/checkFidelityIndex.mjs --phase-dir <abs> --index <abs INDEX.md>
 *     --elements M2,M16 [--datasets thin,deep] [--widths 1440,390]
 *   node apps/web/scripts/checkFidelityIndex.mjs --phase-dir <abs>
 *     --gap-recheck <abs MATCHUPS-FIDELITY.md> --min-rows <n>
 *
 * The difference table (`| capture | dataset | width | element | observed |
 * verdict |`, rows = lines starting with `|` whose first cell ends in `.png`)
 * must hold a row for every required element x dataset x width; every row is
 * six non-empty cells with a closed-vocabulary verdict (`OK`,
 * `DEFECT(open)`, `DEFECT(fixed)`, `DECIDED`) and an existing capture of at
 * least 2 048 bytes (resolved relative to the INDEX.md directory). A DECIDED
 * row cites a registered source and EVERY citation-shaped token in it must
 * resolve against the registry files read from disk on every run (one real
 * citation never launders an invented one); a DEFECT(fixed) row carries a
 * commit hash; any DEFECT(open) fails. A missing registry file is a hard
 * FAIL, never a pass.
 */
import fs from 'node:fs';
import path from 'node:path';

export const FIDELITY_VERDICTS = ['OK', 'DEFECT(open)', 'DEFECT(fixed)', 'DECIDED'];
export const MIN_CAPTURE_BYTES = 2_048;
const COMMIT_HASH_PATTERN = /\b[0-9a-f]{7,40}\b/;

/** The four registry files, read from disk (brief section 6 step 6). Throws when any is missing. */
export function loadCitationRegistry(phaseDir) {
  const files = {
    brief: path.join(phaseDir, '39.1-MATCHUPS-SKETCH003-BRIEF.md'),
    context: path.join(phaseDir, '39.1-CONTEXT.md'),
    uiSpec: path.join(phaseDir, '39.1-UI-SPEC.md'),
    manifest: path.resolve(phaseDir, '..', '..', 'sketches', 'MANIFEST.md'),
  };
  const registry = {};
  for (const [key, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) {
      throw new Error(`registry file missing: ${file}`);
    }
    registry[key] = fs.readFileSync(file, 'utf8');
  }
  return registry;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The brief's section 8 (planner-decision registry) only — a PD row elsewhere is not registered. */
function briefSection8(brief) {
  const start = brief.search(/^## 8\./m);
  if (start < 0) return '';
  const rest = brief.slice(start + 1);
  const next = rest.search(/^## \d+\./m);
  return next < 0 ? brief.slice(start) : brief.slice(start, start + 1 + next);
}

/**
 * Every citation-shaped token in `text`, in order: `PD-4N-N`, `DD-NN`, `D-NN`,
 * `UI-SPEC section N[.M]` (or `UI-SPEC §N[.M]`), `CONTEXT domain`,
 * `MANIFEST YYYY-MM-DD`.
 */
export function citationTokens(text) {
  const tokens = [];
  const patterns = [
    /\bPD-\d+-\d+\b/g,
    /\bDD-\d+\b/g,
    /(?<![A-Za-z-])D-\d+\b/g,
    /\bUI-SPEC (?:section |§)\d+(?:\.\d+)?/g,
    /\bCONTEXT domain\b/g,
    /\bMANIFEST \d{4}-\d{2}-\d{2}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) tokens.push(match[0]);
  }
  return tokens;
}

/** True when `token` resolves against the registry texts (see brief section 6 step 6). */
export function resolveCitation(token, registry) {
  let m;
  if (/^PD-\d+-\d+$/.test(token)) {
    return new RegExp(`^\\| ${escapeRegExp(token)} \\|`, 'm').test(briefSection8(registry.brief));
  }
  if (/^DD-\d+$/.test(token)) {
    return new RegExp(`^\\| ${escapeRegExp(token)} \\|`, 'm').test(registry.uiSpec);
  }
  if (/^D-\d+$/.test(token)) {
    return new RegExp(`\\*\\*${escapeRegExp(token)}\\b`).test(registry.context);
  }
  if ((m = /^UI-SPEC (?:section |§)(\d+)(?:\.(\d+))?$/.exec(token))) {
    const [, major, minor] = m;
    return minor === undefined
      ? new RegExp(`^## ${major}\\.(\\s|$)`, 'm').test(registry.uiSpec)
      : new RegExp(`^### ${major}\\.${minor} `, 'm').test(registry.uiSpec);
  }
  if (token === 'CONTEXT domain') {
    return /<domain>/.test(registry.context);
  }
  if ((m = /^MANIFEST (\d{4}-\d{2}-\d{2})$/.exec(token))) {
    return registry.manifest.includes(`(owner, ${m[1]})`);
  }
  return false;
}

/** Splits a markdown table line into trimmed cells (the outer pipes dropped). */
function cellsOf(line) {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

/** The DECIDED-row citation problems of `text`: `uncited` or `unregistered:<token>` entries. */
function citationProblems(text, registry) {
  const tokens = citationTokens(text);
  if (tokens.length === 0) return ['uncited'];
  return tokens
    .filter((token) => !resolveCitation(token, registry))
    .map((t) => `unregistered:${t}`);
}

/**
 * Pure evaluation of an INDEX.md difference table.
 * `fileExists(captureName)` returns the capture's byte size, or a falsy value
 * when it does not exist. Returns `{ ok, rows, missing, open, malformed }`.
 */
export function evaluateFidelityIndex(
  text,
  { elements, datasets = ['thin', 'deep'], widths = ['1440', '390'], fileExists, registry },
) {
  const malformed = [];
  const open = [];
  const rows = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return;
    const cells = cellsOf(trimmed);
    if (!/\.png$/.test(cells[0] ?? '')) return;
    const where = `line ${i + 1}`;
    if (cells.length !== 6) {
      malformed.push(`${where}: ${cells.length} cells (want 6)`);
      return;
    }
    const [capture, dataset, width, element, observed, verdict] = cells;
    const problems = [];
    if (!element) problems.push('empty element');
    if (!observed) problems.push('empty observed');
    if (!FIDELITY_VERDICTS.includes(verdict)) problems.push(`unknown verdict "${verdict}"`);
    const bytes = fileExists ? fileExists(capture) : null;
    if (!bytes) problems.push(`capture missing: ${capture}`);
    else if (typeof bytes === 'number' && bytes < MIN_CAPTURE_BYTES) {
      problems.push(`capture under ${MIN_CAPTURE_BYTES} bytes: ${capture}`);
    }
    if (verdict === 'DECIDED') {
      const cited = citationProblems(`${element} ${observed}`, registry);
      problems.push(...cited.map((p) => (p === 'uncited' ? 'DECIDED without a citation' : p)));
    }
    if (verdict === 'DEFECT(fixed)' && !COMMIT_HASH_PATTERN.test(observed)) {
      problems.push('DEFECT(fixed) without a commit hash');
    }
    if (problems.length > 0) {
      malformed.push(`${where}: ${problems.join('; ')}`);
      return;
    }
    if (verdict === 'DEFECT(open)') open.push(`${where}: ${element} (${dataset} ${width})`);
    rows.push({ capture, dataset, width, element, observed, verdict });
  });

  const missing = [];
  for (const id of elements) {
    const idPattern = new RegExp(`^${escapeRegExp(id)}\\b`);
    for (const dataset of datasets) {
      for (const width of widths) {
        const found = rows.some(
          (r) => r.dataset === dataset && r.width === width && idPattern.test(r.element),
        );
        if (!found) missing.push(`${id}/${dataset}/${width}`);
      }
    }
  }
  return {
    ok: missing.length === 0 && open.length === 0 && malformed.length === 0,
    rows: rows.length,
    missing,
    open,
    malformed,
  };
}

/**
 * Pure evaluation of the plan-48 gap re-check document: the `## Gap re-check`
 * table (`| gap | resolution | capture | status |`), status `closed` or
 * `DECIDED` (DECIDED citations resolved by the same resolver), a PNG named in
 * every capture cell that exists, at least `minRows` rows, and the
 * `## Metrics` and `## Owner decisions requested` sections.
 */
export function evaluateGapRecheck(text, { minRows, fileExists, registry }) {
  const problems = [];
  const start = text.search(/^## Gap re-check\s*$/m);
  let rows = 0;
  if (start < 0) {
    problems.push('no "## Gap re-check" section');
  } else {
    const rest = text.slice(start).split('\n').slice(1);
    const end = rest.findIndex((line) => /^## /.test(line));
    const section = end < 0 ? rest : rest.slice(0, end);
    section.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) return;
      const cells = cellsOf(trimmed);
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return;
      if (cells[0] === 'gap' && cells[3] === 'status') return;
      const where = `gap row ${i + 1}`;
      if (cells.length !== 4) {
        problems.push(`${where}: ${cells.length} cells (want 4)`);
        return;
      }
      rows += 1;
      const [gap, resolution, capture, status] = cells;
      if (!gap || !resolution) problems.push(`${where}: empty cell`);
      if (status !== 'closed' && status !== 'DECIDED') {
        problems.push(`${where}: status "${status}" (want closed or DECIDED)`);
      }
      if (status === 'DECIDED') {
        for (const p of citationProblems(`${gap} ${resolution}`, registry)) {
          problems.push(`${where}: ${p === 'uncited' ? 'DECIDED without a citation' : p}`);
        }
      }
      const png = /[^\s`]+\.png\b/.exec(capture);
      if (!png) problems.push(`${where}: no PNG in the capture cell`);
      else {
        const bytes = fileExists ? fileExists(png[0]) : null;
        if (!bytes) problems.push(`${where}: capture missing: ${png[0]}`);
        else if (typeof bytes === 'number' && bytes < MIN_CAPTURE_BYTES) {
          problems.push(`${where}: capture under ${MIN_CAPTURE_BYTES} bytes: ${png[0]}`);
        }
      }
    });
  }
  if (rows < minRows) problems.push(`rows=${rows} (want at least ${minRows})`);
  if (!/^## Metrics\s*$/m.test(text)) problems.push('no "## Metrics" section');
  if (!/^## Owner decisions requested\s*$/m.test(text)) {
    problems.push('no "## Owner decisions requested" section');
  }
  return { ok: problems.length === 0, rows, problems };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    args[arg.slice(2)] = value;
    i += 1;
  }
  return args;
}

function fileSizeIn(dir) {
  return (name) => {
    const file = path.resolve(dir, name);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.statSync(file).size : null;
  };
}

function list(values) {
  return values.map((value) => value.replace(/\s+/g, '_')).join(',');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(
      `FIDELITY_INDEX_FAIL missing= open= malformed=args:${list([String(error.message)])}`,
    );
    process.exit(1);
  }
  const gapMode = Boolean(args['gap-recheck']);
  const failPrefix = gapMode ? 'GAP_RECHECK_FAIL' : 'FIDELITY_INDEX_FAIL';
  let registry;
  try {
    if (!args['phase-dir'] || !path.isAbsolute(args['phase-dir'])) {
      throw new Error('--phase-dir <absolute path> is required');
    }
    registry = loadCitationRegistry(args['phase-dir']);
  } catch (error) {
    console.log(
      gapMode
        ? `${failPrefix} problems=registry:${list([error.message])}`
        : `${failPrefix} missing= open= malformed=registry:${list([error.message])}`,
    );
    process.exit(1);
  }

  if (gapMode) {
    const file = path.resolve(args['gap-recheck']);
    if (!fs.existsSync(file)) {
      console.log(`${failPrefix} problems=missing-file:${file}`);
      process.exit(1);
    }
    const result = evaluateGapRecheck(fs.readFileSync(file, 'utf8'), {
      minRows: Number(args['min-rows'] ?? 0),
      fileExists: fileSizeIn(path.dirname(file)),
      registry,
    });
    for (const problem of result.problems) console.log(`GAP_PROBLEM ${problem}`);
    console.log(
      result.ok
        ? `GAP_RECHECK_OK rows=${result.rows}`
        : `${failPrefix} rows=${result.rows} problems=${result.problems.length}`,
    );
    process.exit(result.ok ? 0 : 1);
  }

  const index = args.index ? path.resolve(args.index) : null;
  if (!index || !fs.existsSync(index) || !args.elements) {
    console.log(`${failPrefix} missing=index-or-elements open= malformed=`);
    process.exit(1);
  }
  const result = evaluateFidelityIndex(fs.readFileSync(index, 'utf8'), {
    elements: args.elements.split(',').filter(Boolean),
    datasets: (args.datasets ?? 'thin,deep').split(',').filter(Boolean),
    widths: (args.widths ?? '1440,390').split(',').filter(Boolean),
    fileExists: fileSizeIn(path.dirname(index)),
    registry,
  });
  for (const entry of result.malformed) console.log(`MALFORMED ${entry}`);
  for (const entry of result.open) console.log(`OPEN ${entry}`);
  console.log(
    result.ok
      ? `FIDELITY_INDEX_OK rows=${result.rows}`
      : `${failPrefix} missing=${list(result.missing)} open=${result.open.length || ''} malformed=${result.malformed.length || ''}`,
  );
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
