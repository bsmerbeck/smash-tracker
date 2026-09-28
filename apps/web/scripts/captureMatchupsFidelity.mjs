#!/usr/bin/env node
/**
 * Plan 39.1-41 Task 2: `capture:matchups-fidelity` — sketch 003 (variant A,
 * plus variant C's rivalry ledger card) beside the implemented Matchups page,
 * on the sketch's OWN data (the harness `sketch003` scale, guard:layout's
 * `matchups-sketch-thin` / `-deep` routes), at 1440x900 and 390x844. The
 * owner's evidence for brief section 6's fidelity protocol; every Matchups
 * sketch-003 plan (39.1-41 … 48) runs it.
 *
 * USAGE:
 *   pnpm --filter @smash-tracker/web run capture:matchups-fidelity -- \
 *     --out <abs dir> --sketch <abs index.html> [--label <name>] [--require-regions]
 *
 * Writes into `<out>/<label>/` (default label: the short commit hash) and
 * refuses any path outside `--out`:
 * - full pages `app-<ds>-<w>.png`, `sketch-<ds>-<w>.png`, the ledger crop
 *   `sketch-ledger-<ds>-<w>.png`, region crops `<side>-<region>-<ds>-<w>.png`;
 * - composites `side-by-side-<ds>-<w>.png` and
 *   `side-by-side-<region>-<ds>-<w>.png` (By opponent vs the ledger crop);
 * - `metrics.json`, `metrics-compare.json`, `manifest.json`.
 * Exits non-zero on a wait timeout, a missing sketch, any PNG under 2 048
 * bytes, app-side horizontal overflow, or (with --require-regions) a missing
 * app region. A hard timeout (10 min) and a try/finally always close the
 * browser and the harness server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import { createHardTimeoutExit } from './guardLayout.mjs';

const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_TIMEOUT_MS = 30_000;
const MIN_PNG_BYTES = 2_048;
const SCALE = 'sketch003';
const DATASETS = ['thin', 'deep'];
const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];
const APP_LOADED_MARKER = '[data-slot="matchup-chart-body"]';
const SKETCH_READY = '#variant-a .strip';
const SKETCH_LEDGER = '#variant-c section[aria-label="Rivalry ledger"]';
/** The sketch's own chrome, hidden so only the designed page is captured. */
const SKETCH_CHROME_CSS =
  '.sk-bar, .sk-tools, #footnote, details.note { display: none !important; } body { padding-top: 0 !important; }';

/**
 * The page regions compared side by side: the sketch's variant-A section
 * (by aria-label) and the app's data-slot. `matchupOrPlayer` is conditional
 * on the app (the engine may hide it) — never listed as missing.
 */
const REGIONS = [
  { id: 'hero', sketch: 'Pairing hero, evidence board', app: 'pairing-hero' },
  { id: 'byOpponent', sketch: 'By opponent', app: 'pairing-opponents' },
  { id: 'insights', sketch: 'Matchup Insights', app: 'matchup-insights' },
  { id: 'matchupOrPlayer', sketch: 'Matchup or player', app: 'matchup-or-player', optional: true },
  { id: 'advisor', sketch: 'Counterpick Advisor', app: 'counterpick-advisor' },
  { id: 'stages', sketch: 'Stage breakdown', app: 'stage-breakdown' },
  { id: 'matrix', sketch: 'Matchup matrix', app: 'matchup-matrix' },
  { id: 'results', sketch: 'Matchup results', app: 'matchup-results' },
  /**
   * The period trend (element M2) — a region inside the hero: the sketch's
   * trend section (drawn, or its locked inset) and the app's plot (drawn) or
   * locked inset. The app's `trend-line-period` root is layout-neutral
   * (`display: contents`), so the crop is its drawn content.
   */
  {
    id: 'trend',
    sketchSelector:
      '#variant-a section[aria-label="Pairing hero, evidence board"] > .sect:has(> .trend), #variant-a section[aria-label="Pairing hero, evidence board"] > .sect:has(> .inset .meter)',
    appSelector:
      '[data-slot="matchup-chart-body"] .recharts-responsive-container, [data-slot="matchup-chart-body"] [data-slot="trend-line-period-locked"]',
  },
];

function sketchRegionSelector(region) {
  return region.sketchSelector ?? `#variant-a section[aria-label="${region.sketch}"]`;
}

function appRegionSelector(region) {
  return region.appSelector ?? `[data-slot="${region.app}"]`;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { requireRegions: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--require-regions') {
      args.requireRegions = true;
      continue;
    }
    if (arg === '--out' || arg === '--sketch' || arg === '--label') {
      const value = argv[i + 1];
      if (value === undefined) fail(2, `captureMatchupsFidelity: ${arg} needs a value`);
      args[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    fail(2, `captureMatchupsFidelity: unknown argument ${arg}`);
  }
  for (const key of ['out', 'sketch']) {
    if (!args[key] || !path.isAbsolute(args[key])) {
      fail(2, `captureMatchupsFidelity: --${key} <absolute path> is required`);
    }
  }
  if (args.label !== undefined && !/^[A-Za-z0-9._-]+$/.test(args.label)) {
    fail(2, 'captureMatchupsFidelity: --label may hold only letters, digits, ".", "_" and "-"');
  }
  return args;
}

/** Resolves `name` inside `dir` and refuses anything that would land outside `root` (T-39.1-41-03). */
function outputPath(root, dir, name) {
  const target = path.resolve(dir, name);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside --out: ${name}`);
  }
  return target;
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/**
 * Runs in the page (no closures over module scope). `side` is 'app' or
 * 'sketch'; `regions` is `[{ id, selector }]`. Reads only rects, text and
 * attributes.
 */
function collectFidelityMetrics(side, regions) {
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top + window.scrollY),
      left: Math.round(r.left + window.scrollX),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };
  const visible = (el) => {
    if (el.hidden || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const text = (el) => (el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null);

  const present = regions
    .map((region) => ({ region, el: document.querySelector(region.selector) }))
    .filter((entry) => entry.el && visible(entry.el))
    .map(({ region, el }) => ({ id: region.id, ...rectOf(el) }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  let strip;
  let trend;
  let rows;
  if (side === 'app') {
    const events = Array.from(document.querySelectorAll('[data-slot="form-strip-event"]')).filter(
      visible,
    );
    strip = {
      shownEvents: events.length,
      // Plan 39.1-42: every shown event carries its own label row (the plan-33
      // caption is gone) and the foot's first item states what is drawn.
      labels: Array.from(document.querySelectorAll('[data-slot="form-strip-event-label"]'))
        .filter(visible)
        .map(text),
      foot: text(document.querySelector('[data-slot="form-strip-foot"] > :first-child')),
    };
    const root = document.querySelector('[data-slot="trend-line-period"]');
    trend = root
      ? {
          state: root.getAttribute('data-state'),
          dotDiameters: [
            ...new Set(
              Array.from(root.querySelectorAll('[data-slot="trend-period-dot"]')).map((dot) =>
                Math.round(2 * Number(dot.getAttribute('r') ?? '0')),
              ),
            ),
          ].sort((a, b) => a - b),
          valueLabels: Array.from(root.querySelectorAll('[data-slot="trend-period-value-label"]'))
            .map(text)
            .sort(),
          yTicks: Array.from(root.querySelectorAll('.recharts-yAxis-tick-labels text')).map(text),
        }
      : { state: 'none', dotDiameters: [], valueLabels: [], yTicks: [] };
    const tags = Array.from(document.querySelectorAll('[data-slot="pairing-opponent-tag"]')).filter(
      visible,
    );
    rows = {
      count: tags.length,
      tags: tags.map((tag) => {
        const row = tag.closest('li') ?? tag.parentElement;
        return {
          text: text(tag),
          tagWidth: Math.round(tag.getBoundingClientRect().width),
          rowWidth: Math.round(row.getBoundingClientRect().width),
        };
      }),
    };
  } else {
    const board = document.querySelector('#variant-a');
    const events = board
      ? Array.from(board.querySelectorAll('.strip .strip-ev')).filter(visible)
      : [];
    strip = {
      shownEvents: events.length,
      labels: events.map((ev) => text(ev.querySelector('.strip-label'))),
      foot: text(board?.querySelector('[data-strip-note]') ?? null),
    };
    const plot = board?.querySelector('.trend') ?? null;
    trend = plot
      ? {
          state: 'drawn',
          dotDiameters: [
            ...new Set(
              Array.from(plot.querySelectorAll('.pt')).map((pt) =>
                Math.round(pt.getBoundingClientRect().width),
              ),
            ),
          ].sort((a, b) => a - b),
          valueLabels: Array.from(plot.querySelectorAll('.val')).map(text).sort(),
          yTicks: Array.from(plot.querySelectorAll('.ytick')).map(text),
        }
      : {
          state: board?.querySelector('.meter') ? 'locked' : 'none',
          dotDiameters: [],
          valueLabels: [],
          yTicks: [],
        };
    const tagEls = Array.from(
      document.querySelectorAll(
        '#variant-a section[aria-label="By opponent"] .opp-row .tag, #variant-c section[aria-label="Rivalry ledger"] .led-row .tag',
      ),
    ).filter(visible);
    rows = {
      count: tagEls.length,
      tags: tagEls.map((tag) => {
        const row = tag.closest('button') ?? tag.parentElement;
        return {
          text: text(tag),
          tagWidth: Math.round(tag.getBoundingClientRect().width),
          rowWidth: Math.round(row.getBoundingClientRect().width),
        };
      }),
    };
  }

  return {
    pageHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    heightRatio:
      Math.round((document.documentElement.scrollHeight / window.innerHeight) * 1000) / 1000,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    regions: present,
    strip,
    trend,
    rows,
  };
}

/**
 * Screenshots the first element matching `selector`, re-querying it on each
 * attempt: a Recharts ResponsiveContainer may re-render (and replace its node)
 * when an element screenshot scrolls it into view. Returns false when nothing
 * matches.
 */
async function screenshotSelector(page, selector, file) {
  for (let attempt = 1; ; attempt++) {
    const handle = await page.$(selector);
    if (!handle) return false;
    try {
      await handle.screenshot({ path: file });
      return true;
    } catch (error) {
      if (attempt >= 3 || !/detached/i.test(String(error?.message))) throw error;
      await settle(page);
    }
  }
}

async function captureApp({ browser, baseUrl, ds, viewport, dirs, written }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.setExtraHTTPHeaders({ 'x-guard-layout-scale': SCALE });
    await page.goto(`${baseUrl}/guard-layout.html?id=matchups-sketch-${ds}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForSelector(APP_LOADED_MARKER, { timeout: WAIT_TIMEOUT_MS });
    await settle(page);
    const full = `app-${ds}-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(dirs.root, dirs.run, full), fullPage: true });
    written.push(full);
    const present = [];
    const missing = [];
    for (const region of REGIONS) {
      const name = `app-${region.id}-${ds}-${viewport.width}.png`;
      const shot = await screenshotSelector(
        page,
        appRegionSelector(region),
        outputPath(dirs.root, dirs.run, name),
      );
      if (!shot) {
        if (!region.optional) missing.push(region.id);
        continue;
      }
      written.push(name);
      present.push(region.id);
    }
    const metrics = await page.evaluate(
      collectFidelityMetrics,
      'app',
      REGIONS.map((region) => ({ id: region.id, selector: appRegionSelector(region) })),
    );
    return { full, present, missing, metrics };
  } finally {
    await page.close();
  }
}

async function openSketch(browser, sketchUrl, hash, viewport, readySelector) {
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height });
  await page.goto(`${sketchUrl}#${hash}`, { waitUntil: 'load' });
  await page.addStyleTag({ content: SKETCH_CHROME_CSS });
  await page.waitForSelector(readySelector, { timeout: WAIT_TIMEOUT_MS });
  await settle(page);
  return page;
}

async function captureSketch({ browser, sketchUrl, ds, viewport, dirs, written }) {
  const page = await openSketch(
    browser,
    sketchUrl,
    `v=a&ds=${ds}&hz=last30`,
    viewport,
    SKETCH_READY,
  );
  let full;
  const present = [];
  let metrics;
  try {
    full = `sketch-${ds}-${viewport.width}.png`;
    await page.screenshot({ path: outputPath(dirs.root, dirs.run, full), fullPage: true });
    written.push(full);
    for (const region of REGIONS) {
      const name = `sketch-${region.id}-${ds}-${viewport.width}.png`;
      const shot = await screenshotSelector(
        page,
        sketchRegionSelector(region),
        outputPath(dirs.root, dirs.run, name),
      );
      if (!shot) continue;
      written.push(name);
      present.push(region.id);
    }
    metrics = await page.evaluate(
      collectFidelityMetrics,
      'sketch',
      REGIONS.map((region) => ({ id: region.id, selector: sketchRegionSelector(region) })),
    );
  } finally {
    await page.close();
  }

  const ledgerPage = await openSketch(browser, sketchUrl, `v=c&ds=${ds}`, viewport, SKETCH_LEDGER);
  let ledger;
  try {
    ledger = `sketch-ledger-${ds}-${viewport.width}.png`;
    if (
      !(await screenshotSelector(
        ledgerPage,
        SKETCH_LEDGER,
        outputPath(dirs.root, dirs.run, ledger),
      ))
    ) {
      throw new Error(`the sketch ledger card was not found (${ds} ${viewport.name})`);
    }
    written.push(ledger);
    const ledgerRows = await ledgerPage.evaluate(collectFidelityMetrics, 'sketch', []);
    metrics.ledgerRows = ledgerRows.rows;
  } finally {
    await ledgerPage.close();
  }
  return { full, ledger, present, metrics };
}

async function composeSideBySide({ browser, dirs, left, right, leftCaption, rightCaption, name }) {
  const dataUrl = (file) =>
    `data:image/png;base64,${fs.readFileSync(outputPath(dirs.root, dirs.run, file)).toString('base64')}`;
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#0b0b0d;color:#ddd;font:14px system-ui">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;padding:16px;width:max-content">
          <figure style="margin:0;width:var(--w)"><figcaption style="margin-bottom:8px">${leftCaption}</figcaption>
            <img id="l" src="${dataUrl(left)}" style="display:block;width:100%" /></figure>
          <figure style="margin:0;width:var(--w)"><figcaption style="margin-bottom:8px">${rightCaption}</figcaption>
            <img id="r" src="${dataUrl(right)}" style="display:block;width:100%" /></figure>
        </div></body></html>`,
      { waitUntil: 'load' },
    );
    // Equal width: both images drawn at the wider one's natural width.
    await page.evaluate(() => {
      const width = Math.max(
        document.getElementById('l').naturalWidth,
        document.getElementById('r').naturalWidth,
      );
      document.body.style.setProperty('--w', `${width}px`);
    });
    await page.screenshot({ path: outputPath(dirs.root, dirs.run, name), fullPage: true });
    return name;
  } finally {
    await page.close();
  }
}

function compareMetrics(sketch, app) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const pair = (s, a) => ({ sketch: s, app: a, equal: same(s, a) });
  return {
    heightRatio: pair(sketch.heightRatio, app.heightRatio),
    pageHeight: pair(sketch.pageHeight, app.pageHeight),
    horizontalOverflow: pair(sketch.horizontalOverflow, app.horizontalOverflow),
    regionOrder: pair(
      sketch.regions.map((r) => r.id),
      app.regions.map((r) => r.id),
    ),
    stripShownEvents: pair(sketch.strip.shownEvents, app.strip.shownEvents),
    stripLabels: pair(sketch.strip.labels, app.strip.labels),
    stripFoot: pair(sketch.strip.foot, app.strip.foot),
    trendState: pair(sketch.trend.state, app.trend.state),
    trendDotDiameters: pair(sketch.trend.dotDiameters, app.trend.dotDiameters),
    trendValueLabels: pair(sketch.trend.valueLabels, app.trend.valueLabels),
    trendYTicks: pair(sketch.trend.yTicks, app.trend.yTicks),
    byOpponentRows: pair(sketch.rows.count, app.rows.count),
    ledgerRows: pair(sketch.ledgerRows?.count ?? null, app.rows.count),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.out);
  const sketchPath = path.resolve(args.sketch);
  if (!fs.existsSync(sketchPath)) fail(2, `captureMatchupsFidelity: no sketch at ${sketchPath}`);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const label = args.label ?? commit;
  const run = path.resolve(root, label);
  if (!run.startsWith(root + path.sep)) fail(2, 'captureMatchupsFidelity: --label escapes --out');
  fs.mkdirSync(run, { recursive: true });
  const dirs = { root, run };
  const sketchUrl = pathToFileURL(sketchPath).href;

  const { server, baseUrl } = await startGuardLayoutHarnessServer();
  const browser = await puppeteer.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const forceExit = createHardTimeoutExit({
    browser,
    server,
    offListeners: () => {},
    printSummary: () => console.error(`captureMatchupsFidelity exceeded ${HARD_TIMEOUT_MS}ms`),
  });
  const timer = setTimeout(() => void forceExit(), HARD_TIMEOUT_MS);

  const written = [];
  const missingAppRegions = [];
  const metrics = {};
  const compare = {};
  let exitCode = 0;
  try {
    for (const ds of DATASETS) {
      for (const viewport of VIEWPORTS) {
        const key = `${ds}-${viewport.width}`;
        const app = await captureApp({ browser, baseUrl, ds, viewport, dirs, written });
        const sketch = await captureSketch({ browser, sketchUrl, ds, viewport, dirs, written });
        for (const region of app.missing) {
          missingAppRegions.push({ dataset: ds, width: viewport.width, region });
        }
        if (app.metrics.horizontalOverflow) {
          console.error(`APP_HORIZONTAL_OVERFLOW dataset=${ds} viewport=${viewport.name}`);
          exitCode = 1;
        }
        written.push(
          await composeSideBySide({
            browser,
            dirs,
            left: sketch.full,
            right: app.full,
            leftCaption: `sketch 003 · A · ${ds} · ${viewport.width}`,
            rightCaption: `implementation · ${commit} · ${ds} · ${viewport.width}`,
            name: `side-by-side-${key}.png`,
          }),
        );
        for (const region of REGIONS) {
          if (!app.present.includes(region.id)) continue;
          const sketchCrop =
            region.id === 'byOpponent'
              ? sketch.ledger
              : sketch.present.includes(region.id)
                ? `sketch-${region.id}-${key}.png`
                : null;
          if (!sketchCrop) continue;
          written.push(
            await composeSideBySide({
              browser,
              dirs,
              left: sketchCrop,
              right: `app-${region.id}-${key}.png`,
              leftCaption: `sketch 003 · ${region.id === 'byOpponent' ? 'C ledger' : 'A'} · ${ds} · ${viewport.width}`,
              rightCaption: `implementation · ${commit} · ${region.id} · ${ds} · ${viewport.width}`,
              name: `side-by-side-${region.id}-${key}.png`,
            }),
          );
        }
        metrics[key] = { sketch: sketch.metrics, app: app.metrics };
        compare[key] = compareMetrics(sketch.metrics, app.metrics);
        console.log(
          `CAPTURED dataset=${ds} viewport=${viewport.name} appRegions=${app.present.join(',') || 'none'} missingAppRegions=${app.missing.join(',') || 'none'}`,
        );
      }
    }

    const files = written.map((name) => ({
      name,
      bytes: fs.statSync(outputPath(root, run, name)).size,
    }));
    const small = files.filter((file) => file.bytes < MIN_PNG_BYTES);
    if (small.length > 0) {
      console.error(`PNG under ${MIN_PNG_BYTES} bytes: ${small.map((f) => f.name).join(', ')}`);
      exitCode = 1;
    }
    if (args.requireRegions && missingAppRegions.length > 0) {
      console.error(
        `MISSING_APP_REGIONS ${missingAppRegions.map((m) => `${m.region}/${m.dataset}/${m.width}`).join(',')}`,
      );
      exitCode = 1;
    }
    fs.writeFileSync(
      outputPath(root, run, 'metrics.json'),
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
    fs.writeFileSync(
      outputPath(root, run, 'metrics-compare.json'),
      `${JSON.stringify(compare, null, 2)}\n`,
    );
    fs.writeFileSync(
      outputPath(root, run, 'manifest.json'),
      `${JSON.stringify(
        { commit, date: new Date().toISOString(), label, files, missingAppRegions },
        null,
        2,
      )}\n`,
    );
    console.log(
      `MANIFEST files=${files.length} commit=${commit} label=${label} missingAppRegions=${missingAppRegions.length}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    exitCode = 1;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  process.exit(exitCode);
}

void main();
