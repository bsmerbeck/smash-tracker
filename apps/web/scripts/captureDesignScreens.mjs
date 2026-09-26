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
 *     [--widths 1440,390] [--scale realistic|recent|career|gsp] [--no-shell]
 *
 * Output: `<out>/<scale>/live-<route>-<width>.png` and `<out>/<scale>/metrics.json`
 * (an array of per-route-per-width records: scroll metrics, every DeltaChip's
 * text / data-state / data-recent-games, `steadyOnSubFloor` — the count of
 * chips claiming steady/up/down on fewer than 3 recent games, a regression
 * tripwire over the hosts' real window sizes — the Fighter hero's distinct
 * period-dot radii, recharts x-tick texts and card titles with sizes).
 *
 * Datasets: `realistic` (guard:layout's default 300-game fixture), `career`
 * (plan 39.1-34's 8,400-game scale), `recent` (plan 39.1-36's two-horizon
 * scale — one definition, `guardLayoutHarness.mjs`'s `buildRecentScale`,
 * since plan 39.1-39 also measures it in guard:layout) or the capture-only
 * `gsp` scale (below, passed through the harness's `extraScales`). The
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
import {
  buildRealisticScale,
  buildRecentScale,
  startGuardLayoutHarnessServer,
} from './guardLayoutHarness.mjs';
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
/**
 * Plan 39.1-39 (OWNER DECISION 2026-09-25, DD-11 extended to GSP): routes this
 * tool can screenshot that guard:layout never measures. Mirrors the harness
 * route table's capture-only `gsp` entry (`guardHarnessRoutes.tsx`).
 */
const CAPTURE_ONLY_ROUTES = [{ id: 'gsp', loadedMarker: '[data-slot="gsp-body"]' }];
const KNOWN_SCALES = new Set(['realistic', 'recent', 'career', 'gsp']);
/** Mirrors `DeltaChip`'s data-state values that assert a read. */
const DIRECTIONAL_STATES = new Set(['steady', 'up', 'down']);
/** `ABSTENTION_FLOOR_GAMES` — mirrored (a plain Node script cannot import the TS policy module's constant without a transform; the value is fixed by D-07). */
const FLOOR_GAMES = 3;

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
  const known = new Map(
    [...LAYOUT_ORACLE_ROUTES, ...CAPTURE_ONLY_ROUTES].map((route) => [route.id, route]),
  );
  for (const id of args.routes) {
    if (!known.has(id)) fail(2, `unknown route "${id}"`);
  }
  args.routeEntries = args.routes.map((id) => known.get(id));
  return args;
}

/** A small seeded PRNG (mulberry32) — the `gsp` scale's walk is identical on every run. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plan 39.1-39: the capture-only `gsp` scale — the realistic scale's games
 * (guard:layout's own 300-game fixture, one definition) with a deterministic
 * `gsp` value on every game of the harness mains (a seeded walk between 9 and
 * 11 million per fighter: a win climbs 40-140k, a loss drops 30-120k), two
 * calibration readings per main and gsp settings with an Elite threshold,
 * so GspCurve, GspVsGlicko and GainsAnalysis all render data.
 */
function buildGspScale() {
  const base = buildRealisticScale();
  const random = seededRandom(39_139_001);
  const mains = base.fighters.primary;
  const level = new Map(mains.map((id) => [id, 9_600_000]));
  const clamp = (value) => Math.min(11_000_000, Math.max(9_000_000, value));
  const matches = [...base.matches]
    .sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : 1))
    .map((match) => {
      if (!level.has(match.fighter_id)) return match;
      const step = match.win ? 40_000 + random() * 100_000 : -(30_000 + random() * 90_000);
      const next = Math.round(clamp(level.get(match.fighter_id) + step));
      level.set(match.fighter_id, next);
      return { ...match, gsp: next };
    });
  const byFighter = mains.map((id) => matches.filter((m) => m.fighter_id === id));
  const gspReadings = byFighter.flatMap((games, index) =>
    [0.33, 0.66].map((at, n) => {
      const anchor = games[Math.floor(games.length * at)];
      return {
        id: `gsp-reading-${mains[index]}-${n}`,
        fighter_id: mains[index],
        gsp: Math.round(clamp((anchor?.gsp ?? 9_800_000) + 150_000)),
        time: (anchor?.time ?? 0) + 60_000,
      };
    }),
  );
  const lastTime = matches.reduce((max, match) => Math.max(max, match.time), 0);
  return {
    ...base,
    matches,
    gspReadings,
    gspSettings: { eliteThreshold: 10_400_000, updatedAt: lastTime },
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
  // Plan 39.1-37 [Rule 1]: Recharts 3 portals tick TEXT into a sibling
  // `.recharts-xAxis-tick-labels` layer (not inside `.recharts-xAxis`), so the
  // old descendant selector matched nothing and every capture recorded [].
  const xTicks = [
    ...document.querySelectorAll(
      '.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value, .recharts-xAxis .recharts-cartesian-axis-tick-value',
    ),
  ].map((tick) => (tick.textContent ?? '').trim());
  // Plan 39.1-37: off-domain sub-floor dots drawn at the domain edge
  // (owner decision 2026-09-25), counted per edge.
  const pinnedDots = {
    top: document.querySelectorAll('[data-slot="trend-period-dot"][data-pinned="top"]').length,
    bottom: document.querySelectorAll('[data-slot="trend-period-dot"][data-pinned="bottom"]')
      .length,
  };
  // Plan 39.1-38: each StatRow's rendered column count (distinct child lefts
  // within 2px, zero-width children ignored), its fixed-columns / lead-span
  // flags and whether its first figure spans the whole row.
  const statRows = [...document.querySelectorAll('[data-slot="stat-row"]')].map((row) => {
    const rowRect = row.getBoundingClientRect();
    const kids = [...row.children]
      .map((child) => child.getBoundingClientRect())
      .filter((r) => r.width > 0);
    const lefts = [];
    for (const r of kids) if (!lefts.some((l) => Math.abs(l - r.left) <= 2)) lefts.push(r.left);
    return {
      figures: kids.length,
      columns: lefts.length,
      fixedColumns: row.hasAttribute('data-fixed-columns'),
      leadSpan: row.hasAttribute('data-lead-span'),
      firstSpansRow: kids.length > 1 && kids[0].width >= rowRect.width - 2,
    };
  });
  // Plan 39.1-38: where content starts — the top of the page shell's first
  // child after its filter row (null when no page shell renders).
  const shell = document.querySelector('[data-slot="page-shell"]');
  const filterRowEl = shell?.querySelector(':scope > [data-slot="page-filter-row"]') ?? null;
  const firstContent = shell
    ? ([...shell.children].find((child) => child !== filterRowEl) ?? null)
    : null;
  const firstContentTop = firstContent
    ? Math.round(firstContent.getBoundingClientRect().top + window.scrollY)
    : null;
  const filterRowHeight = filterRowEl
    ? Math.round(filterRowEl.getBoundingClientRect().height)
    : null;
  const cards = [...document.querySelectorAll('[data-slot="card"]')].map((card) => {
    const rect = card.getBoundingClientRect();
    const title =
      card.querySelector('[data-slot="card-title"], h2, h3')?.textContent?.trim().slice(0, 60) ??
      '';
    return { title, width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  // Plan 39.1-39: the GSP page's chart.js canvases (capture-only `gsp` route).
  const gspCanvases = document.querySelectorAll('[data-slot="gsp-body"] canvas').length;
  return {
    gspCanvases,
    statRows,
    firstContentTop,
    filterRowHeight,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    screens: Number((document.documentElement.scrollHeight / window.innerHeight).toFixed(2)),
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    chips,
    steadyOnSubFloor,
    dotRadii,
    pinnedDots,
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
    // Plan 39.1-38 [Rule 1]: `fullPage: true` still runs Puppeteer's own
    // beyond-viewport capture, which re-emulates the device metrics INSIDE the
    // shot — the Trends career timeline's ResponsiveContainer re-measured to a
    // transient ~140px width there in 2 of 4 batch runs, while live sampling
    // of the same sequence read 1094px throughout. The viewport already spans
    // the page, so capture it as-is: no resize happens during the shot.
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({
      path: file,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height: Math.max(VIEWPORT_HEIGHTS[width], fullHeight) },
    });
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

  // `recent` is registered by the harness itself (plan 39.1-39 moved its one
  // definition there); only the capture-only `gsp` scale is passed in.
  const extraScales = args.scale === 'gsp' ? { gsp: buildGspScale() } : {};
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
          `CAPTURED scale=${args.scale} route=${route.id} width=${width} screens=${record.screens} chips=${record.chips.length} steadyOnSubFloor=${record.steadyOnSubFloor} dotRadii=${record.dotRadii.join('/') || '-'} gspCanvases=${record.gspCanvases}`,
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
