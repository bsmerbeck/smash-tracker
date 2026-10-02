#!/usr/bin/env node
/**
 * Quick 261002-leg: `measure:dashboard-hero` — the committed real-browser
 * acceptance oracle for the Dashboard hero spacing spec (DESIGN §6). It opens
 * guard:layout's `dashboard-app` route (the Dashboard inside the production
 * shell geometry: sidebar w-64, main p-6, the harness's realistic fixture) at
 * 1920 / 1440 / 1279 / 1024 / 390 and evaluates named checks against measured
 * rects and computed styles.
 *
 * USAGE:
 *   pnpm --filter @smash-tracker/web run measure:dashboard-hero
 *
 * Prints one `HERO_MEASUREMENT` line per viewport, one `HERO_CHECK ... PASS|FAIL`
 * line per check, and `HERO_RESULT PASS|FAIL failed=<n> unmeasured=<n>`.
 * Exits non-zero on any failed check or any viewport whose page never loaded
 * (UNMEASURED). The selectors it uses (page-grid, data-span cells, card slots,
 * card text) also exist in the pre-change layout, so against the old hero it
 * fails on VALUES instead of crashing — that is the oracle's failing control.
 * A hard timeout (5 min) and a try/finally always close the browser and the
 * harness server.
 */
import puppeteer from 'puppeteer';
import { startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import { createHardTimeoutExit } from './guardLayout.mjs';

const HARD_TIMEOUT_MS = 5 * 60 * 1000;
const LOAD_TIMEOUT_MS = 30_000;
const LOADED_MARKER = '[data-slot="dashboard-body"]';
const ROUTE_ID = 'dashboard-app';
const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1279x800', width: 1279, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
];
/** Tailwind `sm` and `lg`/`xl` breakpoints the spec's tiers are keyed on. */
const SM_PX = 640;
const LG_PX = 1024;
const XL_PX = 1280;
/** `gap-4`, the grid gap and the stack gap. */
const GAP_PX = 16;
const TOL = 1;
const EXPECTED_ROWS = 5;
const PLOT_DEFAULT_PX = 288;
const PLOT_COMPACT_PX = 160;
const STACK_BOTTOM_MAX_DELTA_PX = 32;
const PAIR_BOTTOM_MAX_DELTA_PX = 24;
const SPLIT_CONTENT_MIN_PX = 300;
const RATING_VALUE_ROW_MAX_PX = 34;
const HEADER_CONTENT_MAX_GAP_PX = 16.5;
const CAVEAT_TEXT = 'Ignores the source filter';

/**
 * Runs in the page: collects ONLY rects and computed styles, never decisions.
 * Cards are identified by content so the same function measures the old and
 * the new layout.
 */
function collectInPage() {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };
  const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const body = document.querySelector('[data-slot="dashboard-body"]');
  const grid = body?.querySelector('[data-slot="page-grid"]') ?? null;
  const cells = grid
    ? Array.from(grid.children).filter((c) => c.getAttribute('data-span') === '3')
    : [];
  const heroCards = cells.flatMap((cell) =>
    Array.from(cell.querySelectorAll('[data-slot="card"]')),
  );
  const allCards = grid ? Array.from(grid.querySelectorAll('[data-slot="card"]')) : [];

  const pick = (cards, pred) => cards.find(pred) ?? null;
  const exactSpan = (card, label) =>
    Array.from(card.querySelectorAll('span')).some((s) => text(s) === label);
  const titled = (card, title) => {
    const t = card.querySelector('[data-slot="card-title"]');
    return t != null && text(t) === title;
  };
  const named = {
    overall: pick(
      heroCards,
      (c) =>
        text(c).includes('Overall Record') && !c.querySelector('[data-slot="fighter-record-tile"]'),
    ),
    rating: pick(heroCards, (c) => exactSpan(c, 'Rating')),
    form: pick(heroCards, (c) => c.querySelector('[aria-label^="Last"]') != null),
    fighter: pick(heroCards, (c) => c.querySelector('[data-slot="fighter-record-tile"]') != null),
    cvc: pick(heroCards, (c) => text(c).includes('Casual vs Competitive')),
    ovo: pick(heroCards, (c) => text(c).includes('Online vs Offline')),
    formCurve: pick(allCards, (c) => titled(c, 'Form Curve')),
    previous: pick(allCards, (c) => titled(c, 'Previous Matches')),
  };

  const cardInfo = (card) => {
    if (!card) return null;
    const cs = getComputedStyle(card);
    const header = card.querySelector(':scope > [data-slot="card-header"]');
    const content = card.querySelector(':scope > [data-slot="card-content"]');
    const contentStyle = content ? getComputedStyle(content) : null;
    const headerRect = rectOf(header);
    const contentRect = rectOf(content);
    return {
      rect: rectOf(card),
      paddingTop: parseFloat(cs.paddingTop),
      rowGap: parseFloat(cs.rowGap),
      headerToContent: headerRect && contentRect ? contentRect.t - headerRect.b : null,
      contentBoxWidth: contentRect
        ? contentRect.w -
          parseFloat(contentStyle.paddingLeft) -
          parseFloat(contentStyle.paddingRight)
        : null,
    };
  };

  const cellInfo = cells.map((cell) => ({
    rect: rectOf(cell),
    // The identity of each direct card, by which named card it is.
    cards: Array.from(cell.children)
      .filter((c) => c.getAttribute('data-slot') === 'card')
      .map((c) => ({
        id: Object.entries(named).find(([, v]) => v === c)?.[0] ?? 'other',
        rect: rectOf(c),
      })),
  }));

  const cvc = named.cvc;
  const ratingSpan = named.rating
    ? Array.from(named.rating.querySelectorAll('span')).find((s) => text(s).startsWith('±'))
    : null;
  const previousRows = named.previous
    ? named.previous.querySelectorAll('[data-slot="previous-match-row"]').length
    : 0;
  const showAll = named.previous
    ? Array.from(named.previous.querySelectorAll('button')).find((b) =>
        text(b).startsWith('Show all'),
      )
    : null;
  const canvas = named.formCurve?.querySelector('canvas') ?? null;

  const cardKeys = Object.keys(named);
  return {
    grid: rectOf(grid),
    gridColumnGap: grid ? parseFloat(getComputedStyle(grid).columnGap) : null,
    cells: cellInfo,
    cards: Object.fromEntries(cardKeys.map((k) => [k, cardInfo(named[k])])),
    ratingValueRowHeight: ratingSpan?.parentElement ? rectOf(ratingSpan.parentElement).h : null,
    previousRows,
    showAllText: showAll ? text(showAll) : null,
    plotHeight: canvas?.parentElement ? rectOf(canvas.parentElement).h : null,
    caveatShown: cvc ? text(cvc).includes('Ignores the source filter') : null,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
}

/** The ordered ids the DESIGN names for the two stacks. */
const STACK_ORDER = [
  ['overall', 'rating'],
  ['form', 'fighter'],
];
const SINGLE_COLUMN_ORDER = [
  'overall',
  'rating',
  'form',
  'fighter',
  'cvc',
  'ovo',
  'formCurve',
  'previous',
];
const HERO_CARD_IDS = ['overall', 'rating', 'form', 'fighter', 'cvc', 'ovo'];
const DENSE_CARD_IDS = [...HERO_CARD_IDS, 'formCurve', 'previous'];

const near = (a, b, tol = TOL) => a != null && b != null && Math.abs(a - b) <= tol;
const f = (n) => (n == null ? 'null' : Number(n).toFixed(1));

/** Turns one viewport's raw measurements into named checks. Pure. */
function evaluateChecks(width, m) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  const cells = m.cells;
  const four = cells.length === 4;
  add('hero-cells', four, `cells=${cells.length}`);

  const orderDetail = cells
    .slice(0, 2)
    .map((c) => c.cards.map((x) => x.id).join('+'))
    .join(' | ');
  add(
    'stack-order',
    four &&
      STACK_ORDER.every(
        (want, i) =>
          cells[i].cards.length === want.length && cells[i].cards.every((c, j) => c.id === want[j]),
      ),
    `stacks=${orderDetail || 'none'}`,
  );

  const gaps = [0, 1].map((i) => {
    const c = cells[i]?.cards;
    return c && c.length === 2 ? c[1].rect.t - c[0].rect.b : null;
  });
  add(
    'stack-gap',
    gaps.every((g) => near(g, GAP_PX)),
    `gaps=${gaps.map(f).join(',')}`,
  );

  const wantPad = width >= SM_PX ? 20 : 16;
  const pads = DENSE_CARD_IDS.map((id) => [id, m.cards[id]?.paddingTop ?? null]);
  add(
    'card-padding',
    pads.every(([, p]) => p === wantPad),
    `want=${wantPad} got=${pads.map(([id, p]) => `${id}:${f(p)}`).join(' ')}`,
  );

  const rowGaps = DENSE_CARD_IDS.map((id) => [id, m.cards[id]?.rowGap ?? null]);
  const h2c = DENSE_CARD_IDS.map((id) => [id, m.cards[id]?.headerToContent]).filter(
    ([, v]) => v != null,
  );
  add(
    'card-gap',
    rowGaps.every(([, g]) => g === GAP_PX) && h2c.every(([, v]) => v <= HEADER_CONTENT_MAX_GAP_PX),
    `rowGap=${rowGaps.map(([id, g]) => `${id}:${f(g)}`).join(' ')} header->content=${h2c.map(([id, v]) => `${id}:${f(v)}`).join(' ') || 'none'}`,
  );

  add(
    'rating-one-line',
    m.ratingValueRowHeight != null && m.ratingValueRowHeight <= RATING_VALUE_ROW_MAX_PX,
    `valueRowHeight=${f(m.ratingValueRowHeight)} max=${RATING_VALUE_ROW_MAX_PX}`,
  );
  add(
    'pm-rows',
    m.previousRows === EXPECTED_ROWS && m.showAllText != null,
    `rows=${m.previousRows} showAll=${m.showAllText ?? 'none'}`,
  );
  add(
    'no-hscroll',
    m.scrollWidth <= m.innerWidth,
    `scrollWidth=${m.scrollWidth} inner=${m.innerWidth}`,
  );
  add('caveat-absent', m.caveatShown === false, `caveatShown=${m.caveatShown}`);

  const plotWant = width >= SM_PX ? PLOT_DEFAULT_PX : PLOT_COMPACT_PX;
  add('plot-height', near(m.plotHeight, plotWant), `want=${plotWant} got=${f(m.plotHeight)}`);

  if (width >= XL_PX) {
    const [a, b, c, d] = cells;
    const oneRow =
      four &&
      [b, c, d].every((x) => near(x.rect.t, a.rect.t)) &&
      a.rect.l < b.rect.l &&
      b.rect.l < c.rect.l &&
      c.rect.l < d.rect.l &&
      near(d.rect.r, m.grid?.r);
    add(
      'hero-one-row',
      oneRow,
      four
        ? `tops=${cells.map((x) => f(x.rect.t)).join(',')} lefts=${cells.map((x) => f(x.rect.l)).join(',')} cell3.right=${f(d.rect.r)} grid.right=${f(m.grid?.r)}`
        : 'needs four cells',
    );
    add(
      'stack-bottoms',
      four && Math.abs(a.rect.b - b.rect.b) <= STACK_BOTTOM_MAX_DELTA_PX,
      four
        ? `delta=${f(Math.abs(a.rect.b - b.rect.b))} max=${STACK_BOTTOM_MAX_DELTA_PX}`
        : 'needs four cells',
    );
    add(
      'split-tiles-shorter',
      four && [c, d].every((x) => x.rect.h < a.rect.h && x.rect.h < b.rect.h),
      four
        ? `stacks=${f(a.rect.h)},${f(b.rect.h)} splits=${f(c.rect.h)},${f(d.rect.h)}`
        : 'needs four cells',
    );
    const fc = m.cards.formCurve?.rect;
    const pm = m.cards.previous?.rect;
    add(
      'pair-bottoms',
      fc != null && pm != null && Math.abs(fc.b - pm.b) <= PAIR_BOTTOM_MAX_DELTA_PX,
      fc && pm
        ? `delta=${f(Math.abs(fc.b - pm.b))} max=${PAIR_BOTTOM_MAX_DELTA_PX}`
        : 'missing pair',
    );
  } else if (width >= LG_PX) {
    const [a, b, c, d] = cells;
    const half = m.grid ? (m.grid.w - GAP_PX) / 2 : null;
    const twoByTwo =
      four &&
      near(a.rect.t, b.rect.t) &&
      near(c.rect.t, d.rect.t) &&
      c.rect.t > a.rect.b &&
      cells.every((x) => near(x.rect.w, half)) &&
      near(a.rect.l, m.grid.l) &&
      near(c.rect.l, m.grid.l) &&
      near(b.rect.r, m.grid.r) &&
      near(d.rect.r, m.grid.r);
    add(
      'hero-2x2',
      twoByTwo,
      four
        ? `half=${f(half)} widths=${cells.map((x) => f(x.rect.w)).join(',')} row1.top=${f(a.rect.t)},${f(b.rect.t)} row2.top=${f(c.rect.t)},${f(d.rect.t)} row1.bottom=${f(a.rect.b)}`
        : 'needs four cells',
    );
    const widths = ['cvc', 'ovo'].map((id) => m.cards[id]?.contentBoxWidth ?? null);
    add(
      'split-tile-width',
      widths.every((w) => w != null && w >= SPLIT_CONTENT_MIN_PX),
      `contentBox=${widths.map(f).join(',')} min=${SPLIT_CONTENT_MIN_PX}`,
    );
  } else {
    const rects = SINGLE_COLUMN_ORDER.map((id) => [id, m.cards[id]?.rect ?? null]);
    const present = rects.every(([, r]) => r != null);
    const sameLeft = present && rects.every(([, r]) => near(r.l, rects[0][1].l));
    const increasing = present && rects.every(([, r], i) => i === 0 || r.t > rects[i - 1][1].t);
    add(
      'single-column',
      sameLeft && increasing,
      present
        ? `lefts=${rects.map(([, r]) => f(r.l)).join(',')} tops=${rects.map(([, r]) => f(r.t)).join(',')}`
        : `missing=${rects
            .filter(([, r]) => r == null)
            .map(([id]) => id)
            .join(',')}`,
    );
  }
  return checks;
}

function measurementLine(viewport, m) {
  const cell = (c, i) => `c${i}=${f(c.rect.l)}/${f(c.rect.t)}/${f(c.rect.w)}/${f(c.rect.h)}`;
  const cardHeights = Object.entries(m.cards)
    .map(([id, c]) => `${id}=${f(c?.rect?.h)}`)
    .join(' ');
  const gaps = [0, 1]
    .map((i) => {
      const c = m.cells[i]?.cards;
      return c && c.length === 2 ? f(c[1].rect.t - c[0].rect.b) : 'n/a';
    })
    .join(',');
  const fc = m.cards.formCurve?.rect;
  const pm = m.cards.previous?.rect;
  return `HERO_MEASUREMENT viewport=${viewport.name} grid.w=${f(m.grid?.w)} ${m.cells.map(cell).join(' ')} cardHeights[${cardHeights}] stackGap=${gaps} plot=${f(m.plotHeight)} formCurve.bottom=${f(fc?.b)} previous.bottom=${f(pm?.b)} rows=${m.previousRows}`;
}

async function measureViewport(browser, baseUrl, viewport) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/guard-layout.html?id=${ROUTE_ID}`, { waitUntil: 'networkidle0' });
    try {
      await page.waitForSelector(LOADED_MARKER, { timeout: LOAD_TIMEOUT_MS });
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector(
            '[data-slot="dashboard-body"] [data-slot="page-grid"] canvas',
          );
          return canvas != null && canvas.clientHeight > 0;
        },
        { timeout: LOAD_TIMEOUT_MS },
      );
    } catch {
      return {
        unmeasured: `loaded marker or Form Curve plot never appeared in ${LOAD_TIMEOUT_MS}ms`,
      };
    }
    await page.evaluate(() => document.fonts.ready);
    // Let chart.js finish its resize pass before reading plot geometry.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { measurement: await page.evaluate(collectInPage) };
  } finally {
    await page.close();
  }
}

async function main() {
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
    printSummary: () => console.error(`measureDashboardHero exceeded ${HARD_TIMEOUT_MS}ms`),
  });
  const timer = setTimeout(() => void forceExit(), HARD_TIMEOUT_MS);

  let failed = 0;
  let unmeasured = 0;
  try {
    for (const viewport of VIEWPORTS) {
      const result = await measureViewport(browser, baseUrl, viewport);
      if (result.unmeasured) {
        unmeasured += 1;
        console.log(`HERO_UNMEASURED viewport=${viewport.name} reason=${result.unmeasured}`);
        continue;
      }
      console.log(measurementLine(viewport, result.measurement));
      for (const check of evaluateChecks(viewport.width, result.measurement)) {
        if (!check.pass) failed += 1;
        console.log(
          `HERO_CHECK viewport=${viewport.name} id=${check.id} ${check.pass ? 'PASS' : 'FAIL'} ${check.detail}`,
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    unmeasured += 1;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  const ok = failed === 0 && unmeasured === 0;
  console.log(`HERO_RESULT ${ok ? 'PASS' : 'FAIL'} failed=${failed} unmeasured=${unmeasured}`);
  process.exit(ok ? 0 : 1);
}

void main();
