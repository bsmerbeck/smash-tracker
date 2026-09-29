#!/usr/bin/env node
/**
 * Plan 39.1-34 (plan-check W2 — the owner's core complaint): sketch 002-C's
 * career timeline beside the implementation, on the owner's REAL data, at
 * 1440x900 and 390x844. Design fidelity is gated by a human-readable
 * difference table built from these PNGs, never asserted by layout checks
 * alone. Plan 39.1-35 extends it: the casual account (guard:layout's
 * `casual` scale, the thin state) beside the sketch's casual dataset, plus two
 * readout probes on the sparg0 export (a hover over the 12th-newest month at
 * 1440, a keyboard step at 390).
 *
 * USAGE (absolute paths only):
 *   TIMELINE_FIDELITY_EXPORT=/abs/sparg0-export.json \
 *     pnpm --filter @smash-tracker/web run capture:timeline-fidelity -- \
 *     --out /abs/screenshots/timeline-fidelity --sketch /abs/002/index.html
 *
 * Data handling (T-39.1-34-06): the export named by TIMELINE_FIDELITY_EXPORT
 * is read into memory only — never copied, written, logged or committed. Its
 * matches are served to the loopback-only guard:layout harness as an
 * in-memory `export` scale (the harness uses its own fake auth uid). Without
 * the variable, or with an unreadable file, the script exits 2 with
 * FIDELITY_EXPORT_MISSING — it never falls back to a synthetic dataset.
 *
 * Output (T-39.1-34-07): every file is written inside `--out` (created if
 * missing; any path resolving outside it is refused); nothing is deleted.
 * Per dataset (sparg0 = the owner's export ONLY; casual) and viewport:
 * app-<ds>-<w>.png (the timeline card), app-page-<ds>-<w>.png,
 * sketch-<ds>-<w>.png, sketch-page-<ds>-<w>.png and side-by-side-<ds>-<w>.png;
 * the probes app-readout-hover-1440.png and app-readout-keyboard-390.png; then
 * manifest.json. Exits non-zero on any wait timeout, a failed probe assertion
 * or any PNG under 2,048 bytes. ALWAYS shuts the browser and the Vite
 * server down (try/finally plus a hard timeout using guardLayout's
 * prompt-exit helper).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { matchRecordSchema } from '@smash-tracker/shared';
import { startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import { createHardTimeoutExit } from './guardLayout.mjs';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];
const HARD_TIMEOUT_MS = 6 * 60 * 1000;
const WAIT_TIMEOUT_MS = 30_000;
const MIN_PNG_BYTES = 2_048;
const APP_TIMELINE = '[data-slot="career-timeline-plot-area"]';
const APP_THIN_STRIP = '[data-slot="career-timeline-thin-strip"] [data-slot="form-strip-root"]';
const APP_READOUT = '[data-slot="career-timeline-readout"]';
/**
 * The two datasets: sparg0 is ALWAYS the owner's local export (the `export`
 * scale — never a synthetic stand-in); casual is guard:layout's `casual`
 * scale (41 games over three months) beside the sketch's casual dataset.
 */
const DATASETS = [
  { name: 'sparg0', routeId: 'trends-career', scale: 'export', sketchDs: 'sparg0', thin: false },
  { name: 'casual', routeId: 'trends-casual', scale: 'casual', sketchDs: 'casual', thin: true },
];
const SKETCH_TIMELINE = '#variant-c .c-timeline .plot svg';
const SKETCH_CARD = '#variant-c .c-timeline section.card';

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--out' || arg === '--sketch') {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    fail(2, `captureTimelineFidelity: unknown argument ${arg}`);
  }
  for (const key of ['out', 'sketch']) {
    if (!args[key] || !path.isAbsolute(args[key])) {
      fail(2, `captureTimelineFidelity: --${key} <absolute path> is required`);
    }
  }
  return args;
}

/**
 * Loads the export's matches exactly as production's read path serves them
 * (`RtdbService.listMatches`: `matchRecordSchema.safeParse` per record,
 * skip-on-failure — the raw RTDB export still carries storage shapes such as
 * a keyed `vodTimestamps` node that the API normalises on read), with ids
 * `export-<i>` assigned where absent. Nothing about the data is printed
 * beyond the kept / skipped counts.
 */
function loadExportScale() {
  const exportPath = process.env.TIMELINE_FIDELITY_EXPORT;
  if (!exportPath || !path.isAbsolute(exportPath)) {
    fail(2, 'FIDELITY_EXPORT_MISSING (TIMELINE_FIDELITY_EXPORT must name an absolute path)');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  } catch {
    fail(2, 'FIDELITY_EXPORT_MISSING (the export file is unreadable)');
  }
  if (!Array.isArray(parsed?.matches) || parsed.matches.length === 0) {
    fail(2, 'FIDELITY_EXPORT_MISSING (the export carries no matches)');
  }
  const matches = parsed.matches.flatMap((raw, i) => {
    const record = matchRecordSchema.safeParse(raw);
    return record.success ? [{ id: raw.id ?? `export-${i}`, ...record.data }] : [];
  });
  console.log(
    `EXPORT_MATCHES kept=${matches.length} skipped=${parsed.matches.length - matches.length}`,
  );
  return {
    matches,
    fighters: { primary: [], secondary: [] },
    aliases: {},
    opponentNotes: {},
    tournaments: [],
  };
}

function outputPath(outDir, name) {
  const target = path.resolve(outDir, name);
  if (!target.startsWith(outDir + path.sep)) {
    throw new Error(`refusing to write outside --out: ${name}`);
  }
  return target;
}

async function cardHandle(page) {
  const card = await page.evaluateHandle(() =>
    document.querySelector('[data-slot="career-timeline"]')?.closest('[data-slot="card"]'),
  );
  const cardElement = card.asElement();
  if (!cardElement) throw new Error('the career timeline card was not found');
  return cardElement;
}

/**
 * Probe 1 (sparg0, 1440): hover the centre of the 12th-newest month cell —
 * the one readout must name that cell's own W–L.
 */
async function probeHover({ page, outDir, written }) {
  const target = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('[data-slot="career-timeline-rate-cell"]'));
    const cell = cells[cells.length - 12];
    if (!cell) return null;
    const r = cell.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      record: `${cell.getAttribute('data-wins')}–${cell.getAttribute('data-losses')}`,
    };
  });
  if (!target) throw new Error('PROBE_HOVER_FAIL: fewer than 12 rate cells');
  await page.mouse.move(target.x, target.y);
  await page.waitForSelector(APP_READOUT, { timeout: WAIT_TIMEOUT_MS });
  const text = await page.$eval(APP_READOUT, (el) => el.textContent ?? '');
  if (!text.includes(target.record)) {
    throw new Error(`PROBE_HOVER_FAIL: the readout does not name the cell's ${target.record}`);
  }
  const name = 'app-readout-hover-1440.png';
  await (await cardHandle(page)).screenshot({ path: outputPath(outDir, name) });
  written.push(name);
  console.log(`PROBE_HOVER_OK record=${target.record}`);
}

/**
 * Probe 2 (sparg0, 390): focus the plot, End then ArrowLeft twice — the
 * readout is non-empty and the polite live region holds exactly its text.
 */
async function probeKeyboard({ page, outDir, written }) {
  await page.focus('[data-slot="career-timeline-plot"]');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForSelector(APP_READOUT, { timeout: WAIT_TIMEOUT_MS });
  const { readout, live } = await page.evaluate(() => ({
    readout: document.querySelector('[data-slot="career-timeline-readout"]')?.textContent ?? '',
    live: document.querySelector('[data-slot="career-timeline-live"]')?.textContent ?? '',
  }));
  if (!readout || readout !== live) {
    throw new Error('PROBE_KEYBOARD_FAIL: the readout is empty or differs from the live region');
  }
  const name = 'app-readout-keyboard-390.png';
  await (await cardHandle(page)).screenshot({ path: outputPath(outDir, name) });
  written.push(name);
  console.log('PROBE_KEYBOARD_OK');
}

async function captureApp({ browser, baseUrl, dataset, viewport, outDir, written, probe }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.setExtraHTTPHeaders({ 'x-guard-layout-scale': dataset.scale });
    await page.goto(`${baseUrl}/guard-layout.html?id=${dataset.routeId}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForSelector('[data-slot="career-timeline"]', { timeout: WAIT_TIMEOUT_MS });
    await page.waitForSelector(dataset.thin ? APP_THIN_STRIP : APP_TIMELINE, {
      timeout: WAIT_TIMEOUT_MS,
    });
    const cardName = `app-${dataset.name}-${viewport.width}.png`;
    await (await cardHandle(page)).screenshot({ path: outputPath(outDir, cardName) });
    written.push(cardName);
    const pageName = `app-page-${dataset.name}-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(outDir, pageName), fullPage: true });
    written.push(pageName);
    if (probe) await probe({ page, outDir, written });
    return cardName;
  } finally {
    await page.close();
  }
}

async function captureSketch({ browser, sketchUrl, dataset, viewport, outDir, written }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.goto(sketchUrl, { waitUntil: 'load' });
    await page.click('#tabs button[data-v="c"]');
    await page.click(`#ds button[data-ds="${dataset.sketchDs}"]`);
    await page.waitForSelector(SKETCH_TIMELINE, { timeout: WAIT_TIMEOUT_MS });
    const card = await page.$(SKETCH_CARD);
    if (!card) throw new Error('the sketch timeline card was not found');
    const cardName = `sketch-${dataset.name}-${viewport.width}.png`;
    await card.screenshot({ path: outputPath(outDir, cardName) });
    written.push(cardName);
    const pageName = `sketch-page-${dataset.name}-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(outDir, pageName), fullPage: true });
    written.push(pageName);
    return cardName;
  } finally {
    await page.close();
  }
}

async function composeSideBySide({
  browser,
  dataset,
  viewport,
  sketchName,
  appName,
  outDir,
  written,
}) {
  const dataUrl = (name) =>
    `data:image/png;base64,${fs.readFileSync(outputPath(outDir, name)).toString('base64')}`;
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#0b0b0d;color:#ddd;font:14px system-ui">
        <div style="display:flex;gap:24px;align-items:flex-start;padding:16px;width:max-content">
          <figure style="margin:0"><figcaption style="margin-bottom:8px">sketch 002-C</figcaption>
            <img src="${dataUrl(sketchName)}" /></figure>
          <figure style="margin:0"><figcaption style="margin-bottom:8px">implementation · ${dataset.name} · ${viewport.width}</figcaption>
            <img src="${dataUrl(appName)}" /></figure>
        </div></body></html>`,
      { waitUntil: 'load' },
    );
    const name = `side-by-side-${dataset.name}-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(outDir, name), fullPage: true });
    written.push(name);
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const sketchPath = path.resolve(args.sketch);
  if (!fs.existsSync(sketchPath)) fail(2, `captureTimelineFidelity: no sketch at ${sketchPath}`);
  const exportScale = loadExportScale();
  fs.mkdirSync(outDir, { recursive: true });

  const { server, baseUrl } = await startGuardLayoutHarnessServer({
    extraScales: { export: exportScale },
  });
  const browser = await puppeteer.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const forceExit = createHardTimeoutExit({
    browser,
    server,
    offListeners: () => {},
    printSummary: () => console.error(`captureTimelineFidelity exceeded ${HARD_TIMEOUT_MS}ms`),
  });
  const timer = setTimeout(() => void forceExit(), HARD_TIMEOUT_MS);

  const written = [];
  let exitCode = 0;
  try {
    for (const dataset of DATASETS) {
      for (const viewport of VIEWPORTS) {
        const probe =
          dataset.name === 'sparg0' && viewport.width === 1440
            ? probeHover
            : dataset.name === 'sparg0' && viewport.width === 390
              ? probeKeyboard
              : undefined;
        const appName = await captureApp({
          browser,
          baseUrl,
          dataset,
          viewport,
          outDir,
          written,
          probe,
        });
        const sketchName = await captureSketch({
          browser,
          sketchUrl: pathToFileURL(sketchPath).href,
          dataset,
          viewport,
          outDir,
          written,
        });
        await composeSideBySide({
          browser,
          dataset,
          viewport,
          sketchName,
          appName,
          outDir,
          written,
        });
        console.log(`CAPTURED dataset=${dataset.name} viewport=${viewport.name}`);
      }
    }
    const files = written.map((name) => ({
      name,
      bytes: fs.statSync(outputPath(outDir, name)).size,
    }));
    const small = files.filter((file) => file.bytes < MIN_PNG_BYTES);
    if (small.length > 0) {
      console.error(`PNG under ${MIN_PNG_BYTES} bytes: ${small.map((f) => f.name).join(', ')}`);
      exitCode = 1;
    }
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(
      outputPath(outDir, 'manifest.json'),
      `${JSON.stringify(
        { commit, sparg0Source: 'local export', files, viewports: VIEWPORTS.map((v) => v.name) },
        null,
        2,
      )}\n`,
    );
    console.log(`MANIFEST files=${files.length} commit=${commit.slice(0, 8)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  process.exit(exitCode);
}

void main();
