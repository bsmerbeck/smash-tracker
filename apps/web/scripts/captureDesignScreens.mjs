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
 * Output: `<out>/<scale>/live-<route>-<width>.png`, `<out>/<scale>/rail-metrics.json`
 * (plan 39.1-40: `{ route, width, readsRail, row3 }` per capture that renders the
 * Trends reads rail) and `<out>/<scale>/metrics.json`
 * (an array of per-route-per-width records: scroll metrics, every DeltaChip's
 * text / data-state / data-recent-games, `steadyOnSubFloor` — the count of
 * chips claiming steady/up/down on fewer than 3 recent games, a regression
 * tripwire over the hosts' real window sizes — the Fighter hero's distinct
 * period-dot radii, recharts x-tick texts and card titles with sizes).
 *
 * Datasets: `realistic` (guard:layout's default 300-game fixture), `career`
 * (plan 39.1-34's 8,400-game scale), `recent` (plan 39.1-36's two-horizon
 * scale — one definition, `guardLayoutHarness.mjs`'s `buildRecentScale`,
 * since plan 39.1-39 also measures it in guard:layout) or the `gsp` scale
 * (plan 39.1-49 moved its one definition into the harness too). The
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
import { startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import { LAYOUT_ORACLE_ROUTES, createHardTimeoutExit } from './guardLayout.mjs';
import { runRoutePrepare } from './guardLayoutCore.mjs';

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
 * Routes this tool can screenshot that guard:layout never measures. Plan
 * 39.1-49 made `gsp` a guard:layout route (OOS-9), so none remain; the list
 * stays as the extension point.
 */
const CAPTURE_ONLY_ROUTES = [];
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
  return {
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

/**
 * Plan 39.1-40 (design-audit row 2.6, D-14, UI-SPEC §6.1): runs inside the
 * page — the Trends reads rail's card composition and the row-3 balance,
 * or null when the page has no reads rail. Layout reads only.
 * - readsRail: cards (data-card-kind regular / unlocks-next), fallback (the
 *   engine's synthetic fallback card), templates (data-template-id in DOM
 *   order), kinds (every card's data-card-kind) and marks (per evidence-mark
 *   hook inside the rail).
 * - row3: the height of the reads rail's direct page-grid cell (centre) and
 *   of the grid's other direct children whose top sits within 2px of it
 *   (left / right by x), with minRatio = min over pairs of smaller / larger;
 *   null when no sibling shares the top (the phone single column).
 */
function collectRailMetrics() {
  const rail = document.querySelector('[data-slot="trends-reads-rail"]');
  if (!rail) return null;
  const cardEls = [...rail.querySelectorAll('[data-slot="insight-rail-card"]')];
  const kinds = cardEls.map((el) => el.getAttribute('data-card-kind'));
  const readsRail = {
    cards: kinds.filter((kind) => kind === 'regular' || kind === 'unlocks-next').length,
    fallback:
      rail.querySelectorAll('[data-rail-fallback="true"]').length +
      rail.querySelectorAll('[data-slot="insight-rail-card"][data-card-kind="fallback"]').length,
    templates: [...rail.querySelectorAll('[data-slot="trends-read-card"][data-template-id]')].map(
      (el) => el.getAttribute('data-template-id'),
    ),
    kinds,
    marks: {
      dumbbell: rail.querySelectorAll('[data-slot="comparison-bars-dumbbell"]').length,
      recordBar: rail.querySelectorAll('[data-slot="record-bar"]').length,
      setStrip: rail.querySelectorAll('[data-slot="set-strip"]').length,
      sessionBuckets: rail.querySelectorAll('[data-slot="trends-session-buckets"]').length,
    },
  };
  let cell = rail;
  while (cell.parentElement && cell.parentElement.getAttribute('data-slot') !== 'page-grid') {
    cell = cell.parentElement;
  }
  const grid = cell.parentElement;
  let row3 = null;
  if (grid) {
    const centreRect = cell.getBoundingClientRect();
    const siblings = [...grid.children]
      .filter((child) => child !== cell)
      .map((child) => child.getBoundingClientRect())
      .filter((r) => r.height > 0 && Math.abs(r.top - centreRect.top) <= 2);
    if (siblings.length > 0) {
      const left = siblings.filter((r) => r.left < centreRect.left).map((r) => r.height);
      const right = siblings.filter((r) => r.left > centreRect.left).map((r) => r.height);
      const heights = [centreRect.height, ...siblings.map((r) => r.height)];
      let minRatio = 1;
      for (let i = 0; i < heights.length; i += 1) {
        for (let j = i + 1; j < heights.length; j += 1) {
          const ratio = Math.min(heights[i], heights[j]) / Math.max(heights[i], heights[j]);
          minRatio = Math.min(minRatio, ratio);
        }
      }
      row3 = {
        left: left.length > 0 ? Math.round(left[0]) : null,
        centre: Math.round(centreRect.height),
        right: right.length > 0 ? Math.round(right[0]) : null,
        minRatio: Number(minRatio.toFixed(3)),
      };
    }
  }
  return { readsRail, row3 };
}

/** Routes whose event trend's hover tooltip is recorded (plan 39.1-39, UI-SPEC §10.2). */
const EVENT_TOOLTIP_ROUTES = new Set(['stage-detail', 'opponent-hub']);

/**
 * Plan 39.1-39: hovers the middle point of the page's event trend (AFTER the
 * screenshot, so the PNG never shows a tooltip) and records what the one
 * shared tooltip prints — the INDEX's 'event tooltip label' rows quote it.
 */
async function readEventTooltip(page) {
  const target = await page.evaluate(() => {
    const dots = [...document.querySelectorAll('[data-slot="card"] .recharts-line-dots')];
    const group = dots[0];
    if (!group || group.children.length === 0) return null;
    const dot = group.children[Math.floor(group.children.length / 2)];
    const rect = dot.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      points: group.children.length,
    };
  });
  if (!target) return null;
  await page.mouse.move(target.x, target.y);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const text = await page.evaluate(
    () =>
      document
        .querySelector('.recharts-tooltip-wrapper')
        ?.textContent?.trim()
        .replace(/\s+/g, ' ') ?? '',
  );
  return { points: target.points, text };
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
    // Plan 39.1-49: a route that needs input first (Scout) is driven exactly
    // as guard:layout drives it.
    await runRoutePrepare(page, route.prepare ?? [], { timeoutMs: WAIT_TIMEOUT_MS });
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
    // Plan 39.1-40: the reads-rail composition + row-3 balance, same moment.
    const railMetrics = await page.evaluate(collectRailMetrics);
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
    const eventTooltip = EVENT_TOOLTIP_ROUTES.has(route.id) ? await readEventTooltip(page) : null;
    return {
      route: route.id,
      width,
      scale,
      shell,
      png: name,
      errors,
      ...metrics,
      eventTooltip,
      railMetrics,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scaleDir = path.join(args.out, args.scale);
  fs.mkdirSync(scaleDir, { recursive: true });

  // `recent` (plan 39.1-39) and `gsp` (plan 39.1-49) are registered by the
  // harness itself — one definition each, shared with guard:layout.
  const { server, baseUrl } = await startGuardLayoutHarnessServer();
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
          `CAPTURED scale=${args.scale} route=${route.id} width=${width} screens=${record.screens} chips=${record.chips.length} steadyOnSubFloor=${record.steadyOnSubFloor} dotRadii=${record.dotRadii.join('/') || '-'}${record.eventTooltip ? ` trendPoints=${record.eventTooltip.points} tooltip="${record.eventTooltip.text}"` : ''}`,
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    clearTimeout(timer);
    // Plan 39.1-40: railMetrics goes to its own file, so plan 36's
    // metrics.json schema is untouched.
    const railRecords = records
      .filter((record) => record.railMetrics)
      .map((record) => ({
        route: record.route,
        width: record.width,
        readsRail: record.railMetrics.readsRail,
        row3: record.railMetrics.row3,
      }));
    fs.writeFileSync(
      path.join(scaleDir, 'metrics.json'),
      `${JSON.stringify(
        records.map((record) => {
          const rest = { ...record };
          delete rest.railMetrics;
          return rest;
        }),
        null,
        2,
      )}\n`,
    );
    if (railRecords.length > 0) {
      fs.writeFileSync(
        path.join(scaleDir, 'rail-metrics.json'),
        `${JSON.stringify(railRecords, null, 2)}\n`,
      );
    }
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
