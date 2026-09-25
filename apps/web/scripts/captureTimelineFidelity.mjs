#!/usr/bin/env node
/**
 * Plan 39.1-34 (plan-check W2 — the owner's core complaint): sketch 002-C's
 * career timeline beside the implementation, on the owner's REAL data, at
 * 1440x900 and 390x844. Design fidelity is gated by a human-readable
 * difference table built from these PNGs, never asserted by layout checks
 * alone. Plan 39.1-35 extends this script (casual account, readout probes).
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
 * Per viewport: app-sparg0-<w>.png (the timeline card), app-page-sparg0-<w>.png,
 * sketch-sparg0-<w>.png, sketch-page-sparg0-<w>.png and
 * side-by-side-sparg0-<w>.png; then manifest.json. Exits non-zero on any wait
 * timeout or any PNG under 2,048 bytes. ALWAYS shuts the browser and the Vite
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
const HARD_TIMEOUT_MS = 4 * 60 * 1000;
const WAIT_TIMEOUT_MS = 30_000;
const MIN_PNG_BYTES = 2_048;
const APP_TIMELINE = '[data-slot="career-timeline-plot-area"]';
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

async function captureApp({ browser, baseUrl, viewport, outDir, written }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.setExtraHTTPHeaders({ 'x-guard-layout-scale': 'export' });
    await page.goto(`${baseUrl}/guard-layout.html?id=trends-career`, { waitUntil: 'networkidle0' });
    await page.waitForSelector(APP_TIMELINE, { timeout: WAIT_TIMEOUT_MS });
    const card = await page.evaluateHandle(() =>
      document.querySelector('[data-slot="career-timeline"]')?.closest('[data-slot="card"]'),
    );
    const cardElement = card.asElement();
    if (!cardElement) throw new Error('the career timeline card was not found');
    const cardName = `app-sparg0-${viewport.width}.png`;
    await cardElement.screenshot({ path: outputPath(outDir, cardName) });
    written.push(cardName);
    const pageName = `app-page-sparg0-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(outDir, pageName), fullPage: true });
    written.push(pageName);
    return cardName;
  } finally {
    await page.close();
  }
}

async function captureSketch({ browser, sketchUrl, viewport, outDir, written }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.goto(sketchUrl, { waitUntil: 'load' });
    await page.click('#tabs button[data-v="c"]');
    await page.click('#ds button[data-ds="sparg0"]');
    await page.waitForSelector(SKETCH_TIMELINE, { timeout: WAIT_TIMEOUT_MS });
    const card = await page.$(SKETCH_CARD);
    if (!card) throw new Error('the sketch timeline card was not found');
    const cardName = `sketch-sparg0-${viewport.width}.png`;
    await card.screenshot({ path: outputPath(outDir, cardName) });
    written.push(cardName);
    const pageName = `sketch-page-sparg0-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(outDir, pageName), fullPage: true });
    written.push(pageName);
    return cardName;
  } finally {
    await page.close();
  }
}

async function composeSideBySide({ browser, viewport, sketchName, appName, outDir, written }) {
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
          <figure style="margin:0"><figcaption style="margin-bottom:8px">implementation · sparg0 · ${viewport.width}</figcaption>
            <img src="${dataUrl(appName)}" /></figure>
        </div></body></html>`,
      { waitUntil: 'load' },
    );
    const name = `side-by-side-sparg0-${viewport.width}.png`;
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
    for (const viewport of VIEWPORTS) {
      const appName = await captureApp({ browser, baseUrl, viewport, outDir, written });
      const sketchName = await captureSketch({
        browser,
        sketchUrl: pathToFileURL(sketchPath).href,
        viewport,
        outDir,
        written,
      });
      await composeSideBySide({ browser, viewport, sketchName, appName, outDir, written });
      console.log(`CAPTURED viewport=${viewport.name}`);
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
