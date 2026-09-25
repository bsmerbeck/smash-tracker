#!/usr/bin/env node
/**
 * Plan 39.1-36: the design-review capture tool (dev-only, NOT imported by any
 * test). Renders guard:layout harness routes at 1440x900 and 390x844 inside
 * the harness's production-geometry app shell (256px sidebar + main gutter,
 * via the `shell=app` URL override — the audit's method note 2 measured
 * several routes ~280px wider than production without it) and writes a
 * full-page PNG per route x width plus a metrics.json the owner-review
 * INDEX.md tables cite. Reused by plans 39.1-37..39.
 *
 * USAGE (absolute --out path):
 *   pnpm --filter @smash-tracker/web run capture:design -- \
 *     --out /abs/dir [--routes fighter-analysis,trends,dashboard] \
 *     [--widths 1440,390] [--scale realistic|recent|career] [--no-shell]
 *
 * Output: `<out>/<scale>/live-<route>-<width>.png` and `<out>/<scale>/metrics.json`
 * (an array of per-route-per-width records: scroll metrics, every DeltaChip's
 * text / data-state / data-recent-games, `steadyOnSubFloor` — the count of
 * chips claiming steady/up/down on fewer than 3 recent games, a regression
 * tripwire over the hosts' real window sizes — the Fighter hero's distinct
 * period-dot radii, recharts x-tick texts and card titles with sizes).
 *
 * Datasets: `realistic` (guard:layout's default 300-game fixture), `career`
 * (plan 39.1-34's 8,400-game scale) or `recent` (below — defined HERE and
 * passed through the harness's `extraScales` option, so
 * `guardLayoutHarness.mjs` and guard:layout's defaults are untouched). The
 * scale is sent as the `x-guard-layout-scale` request header; an unknown
 * value exits non-zero rather than silently falling back.
 *
 * Exits non-zero if any route's loaded marker never appears (no PNG of an
 * unloaded page is written) or a PNG comes out empty. ALWAYS shuts the browser
 * and the Vite server down: try/finally, plus a hard timeout using
 * guard:layout's own prompt-exit helper (SIGKILL of the browser's process
 * group, bounded server close) — the repo's zombie-CLI history is the reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import { LAYOUT_ORACLE_ROUTES, createHardTimeoutExit } from './guardLayout.mjs';

const HARD_TIMEOUT_MS = 8 * 60 * 1000;
const WAIT_TIMEOUT_MS = 30_000;
const SETTLE_MS = 800;
const MIN_PNG_BYTES = 2_048;
const VIEWPORT_HEIGHTS = { 1440: 900, 390: 844 };
const DEFAULT_WIDTHS = [1440, 390];
/** The eight real analytics routes (the two synthetic fixtures and the timeline-only variants excluded). */
const DEFAULT_ROUTES = [
  'dashboard',
  'fighter-analysis',
  'matchups',
  'match-data',
  'trends',
  'opponents',
  'opponent-hub',
  'stage-detail',
];
const KNOWN_SCALES = new Set(['realistic', 'recent', 'career']);
/** Mirrors `DeltaChip`'s data-state values that assert a read. */
const DIRECTIONAL_STATES = new Set(['steady', 'up', 'down']);
/** `ABSTENTION_FLOOR_GAMES` — mirrored (a plain Node script cannot import the TS policy module's constant without a transform; the value is fixed by D-07). */
const FLOOR_GAMES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function fail(code, message) {
  console.error(`captureDesignScreens: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    out: null,
    routes: DEFAULT_ROUTES,
    widths: DEFAULT_WIDTHS,
    scale: 'realistic',
    shell: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(2, `${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--') continue;
    if (arg === '--out') args.out = next();
    else if (arg === '--routes') args.routes = next().split(',').filter(Boolean);
    else if (arg === '--widths') args.widths = next().split(',').filter(Boolean).map(Number);
    else if (arg === '--scale') args.scale = next();
    else if (arg === '--no-shell') args.shell = false;
    else fail(2, `unknown argument ${arg}`);
  }
  if (!args.out) fail(2, '--out <dir> is required');
  if (!path.isAbsolute(args.out)) fail(2, '--out must be an absolute path');
  if (!KNOWN_SCALES.has(args.scale)) {
    fail(2, `unknown --scale "${args.scale}" (known: ${[...KNOWN_SCALES].join(', ')})`);
  }
  for (const width of args.widths) {
    if (!VIEWPORT_HEIGHTS[width]) fail(2, `unsupported width ${width} (supported: 1440, 390)`);
  }
  const known = new Map(LAYOUT_ORACLE_ROUTES.map((route) => [route.id, route]));
  for (const id of args.routes) {
    if (!known.has(id)) fail(2, `unknown route "${id}"`);
  }
  args.routeEntries = args.routes.map((id) => known.get(id));
  return args;
}

/** Shifts every row's time so the LAST row sits at `endMs`; ids are untouched. */
function shiftToEnd(matches, endMs) {
  const last = matches.reduce((max, match) => Math.max(max, match.time), -Infinity);
  const delta = endMs - last;
  return matches.map((match) => ({ ...match, time: match.time + delta }));
}

/**
 * Plan 39.1-36: the `recent` scale — two-horizon content the stale
 * `realistic` fixture (every game in 2023) cannot show. Two seeded runs with
 * the realistic scale's mains (Fox 8, Falco 22), opponent characters [1, 10]
 * and stage [1], so every harness route still resolves (/opponents/synthopp15,
 * /stages/1):
 * - an older, sparse segment: ~420 games in sessions of 3-6 spaced 10 days
 *   apart (~30 months; monthly periods hold well under 50 games per main);
 * - a dense segment: 1,300 games in sessions of 18-30 spaced 26h apart
 *   (~2 months; monthly periods hold 150+ games per main), ending one day
 *   before the harness starts.
 * The Fighter hero's period series therefore shows more than one dot-size
 * step and the D-15 scoped last-30 / last-90 windows are non-empty.
 *
 * DELIBERATELY anchored to the wall clock (dev-only): this scale exists to
 * show what a CURRENT account looks like. The harness is excluded from the
 * production build (guardHarnessProductionBuild.guard.test.ts) and
 * guard:layout never selects this scale, so no oracle depends on the date.
 */
function buildRecentScale() {
  const common = {
    mainFighterIds: [8, 22],
    opponentFighterIds: [1, 10],
    stageIds: [1],
  };
  const denseRaw = generateSyntheticMatches({
    ...common,
    seed: 39_136_002,
    count: 1_300,
    startMs: 0,
    sessionSizeRange: [18, 30],
    sessionGapMs: 26 * HOUR_MS,
    winRate: 0.58,
  });
  const dense = shiftToEnd(denseRaw, Date.now() - DAY_MS);
  const denseStart = dense.reduce((min, match) => Math.min(min, match.time), Infinity);
  const olderRaw = generateSyntheticMatches({
    ...common,
    seed: 39_136_001,
    count: 420,
    startMs: 0,
    sessionSizeRange: [3, 6],
    sessionGapMs: 10 * DAY_MS,
    winRate: 0.52,
  });
  const older = shiftToEnd(olderRaw, denseStart - 7 * DAY_MS);
  const matches = [...older, ...dense].sort((a, b) =>
    a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    matches,
    fighters: { primary: [8, 22], secondary: [] },
    aliases: {},
    opponentNotes: {},
    tournaments: [],
  };
}

/** Runs inside the page: the per-capture metrics record. */
function collectMetrics(floorGames) {
  // A chip's host cell: its StatRow grid cell, else its ShareBar row, else its card.
  const hostCell = (chip) => {
    let node = chip;
    while (node && node.parentElement) {
      if (node.parentElement.getAttribute('data-slot') === 'stat-row') return node;
      node = node.parentElement;
    }
    return chip.closest('[data-slot="share-bar-row"], [data-slot="card"]');
  };
  const chips = [...document.querySelectorAll('[data-slot="delta-chip"]')].map((chip) => {
    const recentAttr = chip.getAttribute('data-recent-games');
    const rect = chip.getBoundingClientRect();
    const cell = hostCell(chip)?.getBoundingClientRect();
    return {
      text: (chip.textContent ?? '').trim(),
      state: chip.getAttribute('data-state'),
      recentGames: recentAttr === null ? null : Number(recentAttr),
      // px the chip extends past its host cell's right edge (0 = fits).
      overflowPx: cell ? Math.max(0, Math.round(rect.right - cell.right)) : null,
    };
  });
  const steadyOnSubFloor = chips.filter(
    (chip) =>
      ['steady', 'up', 'down'].includes(chip.state ?? '') &&
      chip.recentGames !== null &&
      chip.recentGames < floorGames,
  ).length;
  const heroTrend = document.querySelector('[data-slot="fighter-hero-trend"]');
  const dotRadii = heroTrend
    ? [...new Set([...heroTrend.querySelectorAll('svg circle')].map((c) => c.getAttribute('r')))]
        .filter((r) => r !== null)
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  const xTicks = [
    ...document.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value'),
  ].map((tick) => (tick.textContent ?? '').trim());
  const cards = [...document.querySelectorAll('[data-slot="card"]')].map((card) => {
    const rect = card.getBoundingClientRect();
    const title =
      card.querySelector('[data-slot="card-title"], h2, h3')?.textContent?.trim().slice(0, 60) ??
      '';
    return { title, width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    screens: Number((document.documentElement.scrollHeight / window.innerHeight).toFixed(2)),
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    chips,
    steadyOnSubFloor,
    dotRadii,
    xTicks,
    cards,
  };
}

/** Resolves once scrollHeight and every svg's width hold still across three 250ms samples (bounded). */
async function waitForStableLayout(page) {
  const sample = () =>
    page.evaluate(() =>
      JSON.stringify([
        document.documentElement.scrollHeight,
        ...[...document.querySelectorAll('svg')].map((svg) =>
          Math.round(svg.getBoundingClientRect().width),
        ),
      ]),
    );
  let previous = await sample();
  let stable = 0;
  for (let i = 0; i < 40 && stable < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = await sample();
    stable = next === previous ? stable + 1 : 0;
    previous = next;
  }
}

async function captureRoute({ browser, baseUrl, route, width, scale, shell, scaleDir }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
  try {
    await page.setViewport({ width, height: VIEWPORT_HEIGHTS[width], deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'x-guard-layout-scale': scale });
    const url = `${baseUrl}/guard-layout.html?id=${encodeURIComponent(route.id)}${shell ? '&shell=app' : ''}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: WAIT_TIMEOUT_MS });
    try {
      await page.waitForSelector(route.loadedMarker, { timeout: WAIT_TIMEOUT_MS });
    } catch {
      throw new Error(
        `route ${route.id} @${width}: loaded marker ${route.loadedMarker} never appeared`,
      );
    }
    await page.waitForNetworkIdle({ idleTime: 300, timeout: WAIT_TIMEOUT_MS }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // Metrics are read at the real viewport, BEFORE the resize below.
    const metrics = await page.evaluate(collectMetrics, FLOOR_GAMES);
    // A fullPage screenshot resizes the viewport mid-capture, and responsive
    // charts can re-measure to a transient width inside the shot (seen once
    // on the Trends career timeline). Pre-size the viewport to the page's
    // full height, wait until the layout is stable, then capture.
    await page.setViewport({
      width,
      height: Math.max(VIEWPORT_HEIGHTS[width], metrics.scrollHeight),
      deviceScaleFactor: 1,
    });
    await waitForStableLayout(page);
    const name = `live-${route.id}-${width}.png`;
    const file = path.join(scaleDir, name);
    await page.screenshot({ path: file, fullPage: true });
    if (fs.statSync(file).size < MIN_PNG_BYTES) {
      throw new Error(`${name} is under ${MIN_PNG_BYTES} bytes`);
    }
    return { route: route.id, width, scale, shell, png: name, errors, ...metrics };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scaleDir = path.join(args.out, args.scale);
  fs.mkdirSync(scaleDir, { recursive: true });

  const extraScales = args.scale === 'recent' ? { recent: buildRecentScale() } : {};
  const { server, baseUrl } = await startGuardLayoutHarnessServer({ extraScales });
  let browser;
  try {
    browser = await puppeteer.launch({
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
  const forceExit = createHardTimeoutExit({
    browser,
    server,
    offListeners: () => {},
    printSummary: () => console.error(`captureDesignScreens exceeded ${HARD_TIMEOUT_MS}ms`),
  });
  const timer = setTimeout(() => void forceExit(), HARD_TIMEOUT_MS);

  const records = [];
  let exitCode = 0;
  try {
    for (const route of args.routeEntries) {
      for (const width of args.widths) {
        const record = await captureRoute({
          browser,
          baseUrl,
          route,
          width,
          scale: args.scale,
          shell: args.shell,
          scaleDir,
        });
        records.push(record);
        console.log(
          `CAPTURED scale=${args.scale} route=${route.id} width=${width} screens=${record.screens} chips=${record.chips.length} steadyOnSubFloor=${record.steadyOnSubFloor} dotRadii=${record.dotRadii.join('/') || '-'}`,
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    clearTimeout(timer);
    fs.writeFileSync(path.join(scaleDir, 'metrics.json'), `${JSON.stringify(records, null, 2)}\n`);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  const directional = records.reduce((sum, record) => sum + record.steadyOnSubFloor, 0);
  console.log(
    `CAPTURE_DONE scale=${args.scale} captures=${records.length} steadyOnSubFloor=${directional} directionalStates=${[...DIRECTIONAL_STATES].join('/')}`,
  );
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
