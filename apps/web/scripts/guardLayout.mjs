#!/usr/bin/env node
/**
 * UIX-01/UIX-03/UIX-06 browser-measured layout oracle (Phase 39.1 Plan 09).
 * Real Chrome, a route-capable dev-only harness (`guard-layout.html` →
 * `src/guardHarness/main.tsx` → `guardHarnessRoutes.tsx`), fixture data —
 * copies `apps/web/scripts/scl01BrowserBudget.mjs`'s shape exactly: starts
 * the harness server bound to the loopback address, launches Puppeteer, and
 * for each route in `LAYOUT_ORACLE_ROUTES` and each of the three viewports,
 * navigates to `guard-layout.html` with that route's id, evaluates UI-SPEC
 * §13.1's four conditions through `guardLayoutCore.mjs`, and collects every
 * violation it finds. ALWAYS shuts the browser and the server down (a hard
 * timeout plus a `try/finally` double shutdown), so this process can never
 * hang — this repo has a zombie-CLI history (`enrichDemoAccounts.ts`).
 *
 * USAGE:
 *   pnpm --filter @smash-tracker/web run guard:layout
 *
 * Plan 39.1-20 Task 3 added the eight real analytics routes to BOTH — the
 * route table in `guardHarnessRoutes.tsx` (so they can be mounted) and this
 * array (so they are measured), keeping the stretch fixture route too
 * (behind `VITE_GUARD_LAYOUT_STRETCH_FIXTURE`, plan 39.1-09's own env flag)
 * so its own failing case stays runnable.
 *
 * A route whose page-loaded marker never appears is reported as UNMEASURED
 * and makes the run exit non-zero — it is never scored as a clean pass
 * (T-39.1-09-06). A trailing `MEASURED_ROUTES=<n>` /
 * `UNMEASURED_ROUTES=<ids or NONE>` summary pair makes both numbers
 * recordable.
 */
import puppeteer from 'puppeteer';
import { startGuardLayoutHarnessServer } from './guardLayoutHarness.mjs';
import {
  evaluateStretch,
  evaluateScrollBudget,
  evaluateHorizontalOverflow,
  evaluateTruncation,
  evaluateCardContentOverflow,
  evaluateHeaderSqueeze,
  evaluateAxisTicks,
  evaluateAxisPresence,
  evaluateGridBalance,
  evaluateFamilyPresence,
  evaluatePickerAlignment,
  evaluateRowCohesion,
  evaluateRowTagLegibility,
  evaluateNestedScrollers,
  LAYOUT_ORACLE_VIEWPORTS,
  EXTRA_ORACLE_VIEWPORTS,
  NARROW_VIEWPORT_MAX_WIDTH_PX,
} from './guardLayoutCore.mjs';

/**
 * Mirrors `apps/web/src/guardHarness/guardHarnessRoutes.tsx`'s `id` and
 * `loadedMarker` fields by hand: this is a plain Node script with no JSX/TS
 * transform in front of it, so it cannot `import` the `.tsx` route table
 * directly. Plan 39.1-20 adds one entry here per real analytics route,
 * copied from the same route table entries it adds there.
 */
export const LAYOUT_ORACLE_ROUTES = [
  {
    id: 'stretched-card-fixture',
    loadedMarker: '[data-guard-loaded="stretched-card-fixture"]',
  },
  { id: 'dashboard', loadedMarker: '[data-slot="dashboard-body"]' },
  { id: 'fighter-analysis', loadedMarker: '[data-slot="fighter-hero-body"]' },
  {
    id: 'matchups',
    loadedMarker: '[data-slot="matchup-chart-body"]',
    // Plan 39.1-30: the only route opted into the four new oracle families
    // and the two extra viewports — every other route's measurement stays
    // byte-unchanged (three viewports, zero new checks).
    checks: [
      'content-overflow',
      'header-squeeze',
      'axis-ticks',
      'grid-balance',
      'picker-alignment',
      'row-cohesion',
    ],
    extraViewports: ['1024x768', '1280x800'],
    // Plan 39.1-32: evaluated ONLY at viewports up to NARROW_VIEWPORT_MAX_WIDTH_PX
    // wide (UI-SPEC §6.6 "below 640") — every other route's `narrowChecks` is
    // `undefined`, so `measureRouteAtViewport` requests none for them.
    narrowChecks: ['row-tag-legibility', 'nested-scroll'],
  },
  { id: 'match-data', loadedMarker: '[data-slot="match-data-rail"]' },
  { id: 'trends', loadedMarker: '[data-slot="trends-hero-body"]' },
  { id: 'opponents', loadedMarker: '[data-slot="opponents-body"]' },
  { id: 'opponent-hub', loadedMarker: '[data-slot="opponent-hub-body"]' },
  { id: 'stage-detail', loadedMarker: '[data-slot="stage-detail-body"]' },
];

const HARD_TIMEOUT_MS = Number(process.env.GUARD_LAYOUT_HARD_TIMEOUT_MS) || 5 * 60 * 1000;
const ROUTE_LOAD_TIMEOUT_MS = 15_000;

/**
 * `onTimeout` (plan 39.1-30 first_fix) is fired the instant the hard timeout
 * elapses, NOT awaited by this function — it is a fire-and-forget prompt-exit
 * hook (`main()`'s `forceExitOnTimeout`, below). `Promise.race` has no way to
 * cancel the losing `promise`: the measurement loop keeps running in the
 * background after this function's caller sees the rejection. Without
 * `onTimeout`, the ONLY cleanup left is the caller's own `finally` block
 * asking `browser.close()` to gracefully wait on the exact CDP connection an
 * orphaned `page.evaluate()` is still using — that wait was measured taking
 * minutes, defeating the whole point of a hard timeout.
 */
function withHardTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) void onTimeout();
      reject(new Error(`${label} exceeded its ${ms}ms hard timeout`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs entirely inside the browser context — no closures over outer scope.
 * `checks` (plan 39.1-30) is the requesting route's opted-in family list
 * (`[]` for every route except `matchups`); the four new measurement
 * categories below are only collected — at real DOM/CSS-computation cost —
 * for a route that actually asked for them.
 */
function collectPageMeasurements(checks) {
  const wantContentOverflow = checks.includes('content-overflow');
  const wantHeaderSqueeze = checks.includes('header-squeeze');
  const wantAxisTicks = checks.includes('axis-ticks');
  const wantGridBalance = checks.includes('grid-balance');
  const wantPickerAlignment = checks.includes('picker-alignment');
  const wantRowCohesion = checks.includes('row-cohesion');
  const wantRowTagLegibility = checks.includes('row-tag-legibility');
  const wantNestedScroll = checks.includes('nested-scroll');

  function describeElement(el) {
    if (el.getAttribute('data-testid')) {
      return `[data-testid="${el.getAttribute('data-testid')}"]`;
    }
    if (el.id) {
      return `#${el.id}`;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let selector = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblingsOfType = Array.from(node.parentElement.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblingsOfType.length > 1) {
          selector += `:nth-of-type(${siblingsOfType.indexOf(node) + 1})`;
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  const cards = Array.from(document.querySelectorAll('[data-slot="card"]')).map((card) => {
    const rect = card.getBoundingClientRect();
    const style = window.getComputedStyle(card);
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const lastChild = card.lastElementChild;
    const lastChildRect = lastChild ? lastChild.getBoundingClientRect() : rect;
    return {
      selectorPath: describeElement(card),
      height: rect.height,
      top: rect.top,
      lastChildBottom: lastChildRect.bottom,
      paddingBottom,
    };
  });

  const truncationElements = Array.from(document.querySelectorAll('[data-truncate-guard]')).map(
    (el) => ({
      selectorPath: describeElement(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      hasTitle: Boolean(el.getAttribute('title')),
    }),
  );

  // -------------------------------------------------------------------
  // Plan 39.1-30: the four new measurement categories, collected only for
  // a requesting route's opted-in families (see `wantX` flags above).
  // -------------------------------------------------------------------

  // Perf (plan 39.1-30 first_fix): a naive walk called `getComputedStyle`
  // TWICE per visited descendant (once for visibility, once for overflow-x).
  // `getComputedStyle` forces a style recalculation; on a chart-heavy page
  // (Recharts renders hundreds of SVG nodes) doubling that cost per node is
  // the difference between a route finishing in seconds and one blowing the
  // 300s hard timeout. One style object per element, reused by both checks.
  function isVisuallyHiddenFromStyle(style, rect, el) {
    if (style.position === 'fixed') return true;
    if (rect.width === 0 || rect.height === 0) return true;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return true;
    if ((el.offsetWidth <= 1 && el.offsetHeight <= 1) || style.visibility === 'hidden') return true;
    return false;
  }

  const overflowCards = [];
  if (wantContentOverflow) {
    for (const cardEl of document.querySelectorAll('[data-slot="card"]')) {
      const rect = cardEl.getBoundingClientRect();
      const cardStyle = window.getComputedStyle(cardEl);
      const borderLeft = parseFloat(cardStyle.borderLeftWidth) || 0;
      const borderRight = parseFloat(cardStyle.borderRightWidth) || 0;
      const innerLeft = rect.left + borderLeft;
      const innerRight = rect.right - borderRight;

      const offenders = [];
      const stack = Array.from(cardEl.children);
      while (stack.length > 0) {
        const el = stack.shift();
        const isSvg = el.tagName === 'svg';
        const style = window.getComputedStyle(el);
        const overflowContainer = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
        const elRect = el.getBoundingClientRect();
        if (!isVisuallyHiddenFromStyle(style, elRect, el)) {
          if (elRect.left < innerLeft - 1 || elRect.right > innerRight + 1) {
            offenders.push({
              selectorPath: describeElement(el),
              left: elRect.left,
              right: elRect.right,
            });
          }
        }
        // Never descend into SVG internals, and never past an
        // overflow/scroll/clip container's own boundary (UI-SPEC §6.5: a
        // horizontal scroll/clip container is the one enumerated
        // content-overflow exemption).
        if (!isSvg && !overflowContainer) {
          for (const child of el.children) stack.push(child);
        }
      }
      overflowCards.push({ selectorPath: describeElement(cardEl), innerLeft, innerRight, offenders });
    }
  }

  const headers = [];
  if (wantHeaderSqueeze) {
    for (const headerEl of document.querySelectorAll('[data-slot="card-header"]')) {
      const style = window.getComputedStyle(headerEl);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const contentWidth = headerEl.clientWidth - paddingLeft - paddingRight;
      const parts = [];
      for (const role of ['card-title', 'card-description']) {
        for (const partEl of headerEl.querySelectorAll(`[data-slot="${role}"]`)) {
          const partRect = partEl.getBoundingClientRect();
          const partStyle = window.getComputedStyle(partEl);
          let lineHeight = parseFloat(partStyle.lineHeight);
          if (!Number.isFinite(lineHeight)) {
            lineHeight = (parseFloat(partStyle.fontSize) || 14) * 1.2;
          }
          parts.push({
            role: role === 'card-title' ? 'title' : 'description',
            width: partRect.width,
            height: partRect.height,
            lineHeight,
          });
        }
      }
      if (parts.length > 0) {
        headers.push({ selectorPath: describeElement(headerEl), contentWidth, parts });
      }
    }
  }

  const axisSurfaces = [];
  if (wantAxisTicks) {
    for (const surfaceEl of document.querySelectorAll('svg.recharts-surface')) {
      const rect = surfaceEl.getBoundingClientRect();

      function tickRects(containerSelector) {
        const out = [];
        const container = surfaceEl.querySelector(containerSelector);
        if (!container) return out;
        for (const g of container.querySelectorAll('.recharts-cartesian-axis-tick-label')) {
          const r = g.getBoundingClientRect();
          out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, text: g.textContent ?? '' });
        }
        return out;
      }

      const xTicks = tickRects('.recharts-xAxis-tick-labels');
      const yTicks = tickRects('.recharts-yAxis-tick-labels');

      const valueLabels = Array.from(
        surfaceEl.querySelectorAll('[data-slot="trend-period-value-label"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, text: el.textContent ?? '' };
      });

      const dots = Array.from(surfaceEl.querySelectorAll('[data-slot="trend-period-dot"]')).map(
        (el) => {
          const r = el.getBoundingClientRect();
          return { selectorPath: describeElement(el), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        },
      );

      function axisLineRect(axisSelector) {
        const line = surfaceEl.querySelector(`${axisSelector} .recharts-cartesian-axis-line`);
        if (!line) return null;
        const r = line.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }

      axisSurfaces.push({
        selectorPath: describeElement(surfaceEl),
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        xTicks,
        yTicks,
        valueLabels,
        dots,
        xAxisLine: axisLineRect('.recharts-xAxis'),
        yAxisLine: axisLineRect('.recharts-yAxis'),
      });
    }
  }

  const grids = [];
  if (wantGridBalance) {
    // Perf (plan 39.1-30 first_fix): the naive form called `getComputedStyle`
    // — a forced style recalculation — for EVERY element in the document,
    // including every SVG internal a chart renders (paths, tick <text>
    // nodes, grid lines) and every table row. This codebase's CSS grid
    // containers are ALWAYS Tailwind-classed (`grid`, `grid-cols-12`,
    // `lg:grid`, …), so a cheap className substring check — no style/layout
    // read — first narrows thousands of candidates down to the handful that
    // could possibly be a grid container before paying for the real style
    // read. SVG elements' `className` is an `SVGAnimatedString`, not a
    // plain string (no `.includes`); the `typeof` guard skips them, which is
    // correct — no SVG internal is ever a CSS grid container here.
    const gridClassCandidates = [];
    for (const el of document.querySelectorAll('*')) {
      const cls = el.className;
      if (typeof cls === 'string' && cls.includes('grid')) {
        gridClassCandidates.push(el);
      }
    }
    for (const gridEl of gridClassCandidates) {
      const display = window.getComputedStyle(gridEl).display;
      if (display !== 'grid' && display !== 'inline-grid') continue;
      const cardBearingChildren = Array.from(gridEl.children).filter(
        (child) => child.matches('[data-slot="card"]') || child.querySelector('[data-slot="card"]'),
      );
      if (cardBearingChildren.length < 2) continue;
      const rowGapPx = parseFloat(window.getComputedStyle(gridEl).rowGap) || 0;
      const items = cardBearingChildren.map((child) => {
        const r = child.getBoundingClientRect();
        return { selectorPath: describeElement(child), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      grids.push({ selectorPath: describeElement(gridEl), rowGapPx, items });
    }
  }

  // -------------------------------------------------------------------
  // Plan 39.1-32: the four mobile gap-closure measurement categories,
  // collected only for a requesting route's opted-in families.
  // -------------------------------------------------------------------

  const pickers = [];
  if (wantPickerAlignment) {
    for (const pickerEl of document.querySelectorAll('[data-slot="matchup-pairing-picker"]')) {
      const controls = Array.from(
        pickerEl.querySelectorAll('[data-slot="select-trigger"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      const labels = Array.from(
        pickerEl.querySelectorAll('[data-slot="matchup-pairing-label"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      const vsEls = pickerEl.querySelectorAll('[data-slot="matchup-pairing-vs"]');
      // Structure drift (not exactly 2 controls / 2 labels / 1 vs) is left
      // OUT of `pickers` on purpose — `evaluateFamilyPresence` then reports
      // `picker-alignment-unmeasured` rather than the evaluator indexing
      // into a missing array slot.
      if (controls.length === 2 && labels.length === 2 && vsEls.length === 1) {
        const vsRect = vsEls[0].getBoundingClientRect();
        pickers.push({
          selectorPath: describeElement(pickerEl),
          controls,
          labels,
          vs: { left: vsRect.left, right: vsRect.right, top: vsRect.top, bottom: vsRect.bottom },
        });
      }
    }
  }

  const rowCohesionRows = [];
  if (wantRowCohesion) {
    for (const rowEl of document.querySelectorAll('[data-fixed-columns]')) {
      const items = Array.from(rowEl.children).map((child) => {
        const r = child.getBoundingClientRect();
        return {
          selectorPath: describeElement(child),
          top: r.top,
          scrollWidth: child.scrollWidth,
          clientWidth: child.clientWidth,
        };
      });
      rowCohesionRows.push({ selectorPath: describeElement(rowEl), items });
    }
  }

  const rowTags = [];
  if (wantRowTagLegibility) {
    for (const tagEl of document.querySelectorAll('[data-slot="pairing-opponent-tag"]')) {
      const li = tagEl.closest('li');
      let rowContentWidth = tagEl.clientWidth;
      if (li) {
        const liStyle = window.getComputedStyle(li);
        const paddingLeft = parseFloat(liStyle.paddingLeft) || 0;
        const paddingRight = parseFloat(liStyle.paddingRight) || 0;
        rowContentWidth = li.clientWidth - paddingLeft - paddingRight;
      }
      rowTags.push({
        selectorPath: describeElement(tagEl),
        text: tagEl.textContent ?? '',
        scrollWidth: tagEl.scrollWidth,
        clientWidth: tagEl.clientWidth,
        rowContentWidth,
      });
    }
  }

  const nestedScrollers = [];
  if (wantNestedScroll) {
    // Layout reads (scrollHeight/clientHeight) first — cheap; `getComputedStyle`
    // (a forced style recalculation) only for the few candidates that already
    // scroll taller than their box, mirroring the grid-balance perf lesson
    // above (plan 39.1-30 first_fix).
    for (const el of document.body.getElementsByTagName('*')) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const overflowY = window.getComputedStyle(el).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          nestedScrollers.push({
            selectorPath: describeElement(el),
            overflowY,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
      }
    }
  }
  // Non-vacuity presence list (plan 39.1-32): the page's terminus list roots
  // — a missing results list is nested-scroll-unmeasured, never a silent
  // zero-violation pass.
  const nestedScrollPresenceList = wantNestedScroll
    ? Array.from(document.querySelectorAll('[data-total-rows]'))
    : [];

  return {
    cards,
    truncationElements,
    overflowCards,
    headers,
    axisSurfaces,
    grids,
    pickers,
    rowCohesionRows,
    rowTags,
    nestedScrollers,
    nestedScrollPresenceList: nestedScrollPresenceList.length,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  };
}

async function measureRouteAtViewport(browser, baseUrl, route, viewport) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/guard-layout.html?id=${encodeURIComponent(route.id)}`, {
      waitUntil: 'networkidle0',
    });

    try {
      await page.waitForSelector(route.loadedMarker, { timeout: ROUTE_LOAD_TIMEOUT_MS });
    } catch {
      return {
        unmeasured: true,
        reason: `page-loaded marker "${route.loadedMarker}" never appeared within ${ROUTE_LOAD_TIMEOUT_MS}ms`,
      };
    }

    // Plan 39.1-32: a route's `narrowChecks` (row-tag-legibility, nested-scroll)
    // are requested ONLY at viewports up to NARROW_VIEWPORT_MAX_WIDTH_PX wide
    // (UI-SPEC §6.6 "below 640") — every other route's `narrowChecks` is
    // `undefined`, so this adds nothing for them at any viewport.
    const checks = [
      ...(route.checks ?? []),
      ...(viewport.width <= NARROW_VIEWPORT_MAX_WIDTH_PX ? (route.narrowChecks ?? []) : []),
    ];
    const measurements = await page.evaluate(collectPageMeasurements, checks);

    const violations = [
      ...evaluateStretch(measurements.cards),
      ...evaluateScrollBudget({
        scrollHeight: measurements.scrollHeight,
        innerHeight: measurements.innerHeight,
        viewportName: viewport.name,
      }),
      ...evaluateHorizontalOverflow({
        scrollWidth: measurements.scrollWidth,
        innerWidth: measurements.innerWidth,
      }),
      ...evaluateTruncation(measurements.truncationElements),
    ];

    // Plan 39.1-30: the four new families, only for a route's opted-in
    // checks — each requested family also runs its own non-vacuity presence
    // check (a selector/structure drift must fail loudly, never silently
    // report zero violations).
    if (checks.includes('content-overflow')) {
      violations.push(...evaluateCardContentOverflow(measurements.overflowCards));
      violations.push(...evaluateFamilyPresence('content-overflow', measurements.overflowCards));
    }
    if (checks.includes('header-squeeze')) {
      violations.push(...evaluateHeaderSqueeze(measurements.headers));
      violations.push(...evaluateFamilyPresence('header-squeeze', measurements.headers));
    }
    if (checks.includes('axis-ticks')) {
      violations.push(...evaluateAxisTicks(measurements.axisSurfaces));
      violations.push(...evaluateAxisPresence(measurements.axisSurfaces));
    }
    if (checks.includes('grid-balance')) {
      violations.push(...evaluateGridBalance(measurements.grids));
      violations.push(...evaluateFamilyPresence('grid-balance', measurements.grids));
    }
    // Plan 39.1-32: the four mobile gap-closure families, same opt-in
    // discipline (requested + presence check together).
    if (checks.includes('picker-alignment')) {
      violations.push(...evaluatePickerAlignment(measurements.pickers));
      violations.push(...evaluateFamilyPresence('picker-alignment', measurements.pickers));
    }
    if (checks.includes('row-cohesion')) {
      violations.push(...evaluateRowCohesion(measurements.rowCohesionRows));
      violations.push(...evaluateFamilyPresence('row-cohesion', measurements.rowCohesionRows));
    }
    if (checks.includes('row-tag-legibility')) {
      violations.push(...evaluateRowTagLegibility(measurements.rowTags));
      violations.push(...evaluateFamilyPresence('row-tag-legibility', measurements.rowTags));
    }
    if (checks.includes('nested-scroll')) {
      violations.push(...evaluateNestedScrollers(measurements.nestedScrollers));
      violations.push(
        ...evaluateFamilyPresence(
          'nested-scroll',
          Array.from({ length: measurements.nestedScrollPresenceList }),
        ),
      );
    }

    // Plan 39.1-20 Task 3: recorded regardless of pass/fail — the plan's own
    // output contract requires the measured maximum card stretch and the
    // measured scroll-height ratio for EVERY route at EVERY viewport, not
    // only the routes that were over budget.
    const maxStretchPx = measurements.cards.reduce((max, card) => {
      const contentHeight = card.lastChildBottom - card.top + card.paddingBottom;
      return Math.max(max, card.height - contentHeight);
    }, 0);
    const scrollRatio = measurements.scrollHeight / measurements.innerHeight;

    return { unmeasured: false, violations, maxStretchPx, scrollRatio };
  } finally {
    await page.close();
  }
}

/**
 * WR-B03 (39.1-REVIEW.md): the `try/catch/finally` below only unwinds on
 * normal completion, a thrown error, or the hard timeout — none of that
 * runs on `SIGINT`/`SIGTERM`, because Node's default behaviour for those
 * signals is to terminate immediately without ever reaching the `finally`
 * block. A developer/CI job cancelling a hung `pnpm guard:layout` with
 * Ctrl-C left an orphaned headless Chromium process and an orphaned Vite
 * dev server bound to a loopback port — this repo has a zombie-CLI history
 * (`enrichDemoAccounts.ts`) the hard timeout above already guards against
 * for hangs; this guards the OTHER half, operator cancellation.
 *
 * A FACTORY, not a bare function with module-level mutable state — each
 * call returns a fresh closure with its own `shuttingDown` guard and its
 * own injected `kill`/`offListeners`, so `guardLayoutShutdown.test.mjs` can
 * unit-test the exact shutdown ORDERING (browser closed, then server, then
 * listeners removed, then the signal re-raised — and a second signal during
 * cleanup is a no-op) against fake browser/server/process objects, with no
 * real Puppeteer, no real Vite server, and no interaction with this actual
 * process's real signal listeners.
 */
export function createShutdownHandler({
  browser,
  server,
  offListeners,
  kill = (signal) => process.kill(process.pid, signal),
}) {
  let shuttingDown = false;
  return async function shutdownOnSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    offListeners();
    // `signal` is re-raised via `kill` (rather than a bare `process.exit`)
    // so the exit reflects the conventional 128+signal code AND so a second
    // Ctrl-C during cleanup can't re-enter this handler (the listeners are
    // already removed above).
    kill(signal);
  };
}

async function main() {
  const { server, baseUrl } = await startGuardLayoutHarnessServer();
  // WR-B03 (39.1-REVIEW.md): Puppeteer's own launcher (`@puppeteer/browsers`)
  // defaults `handleSIGINT`/`handleSIGTERM`/`handleSIGHUP` to `true` — it
  // registers ITS OWN signal handler that kills the browser and then calls
  // `process.exit(130)` directly on SIGINT, with no knowledge of the Vite
  // server at all. Disabled here so it never competes with this script's
  // own handler below.
  const browser = await puppeteer.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  // Vite's OWN dev server ALSO installs a competing SIGTERM listener
  // (`setupSIGTERMListener` in its `createServer`), which gracefully closes
  // ONLY the Vite server and calls `process.exit()` — with no knowledge of
  // the Puppeteer browser. Left in place alongside this script's own
  // handler below, the two would race: whichever `process.exit`/`kill` call
  // resolves first wins, and Puppeteer's browser process (launched
  // `detached`, so it does NOT die automatically with its parent) could be
  // left running if Vite's handler wins that race. Removed here so this
  // script's own `createShutdownHandler` handler is the SOLE owner of the
  // whole shutdown (browser AND server, in order) on any signal — there is
  // no reason for either dependency's own signal handling to run instead.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  // Diagnostic line — useful when debugging the harness by hand; never
  // parsed by any CI workflow (this repo has none) or `pnpm guard:layout`
  // consumer.
  console.log(`HARNESS_BASE_URL=${baseUrl}`);

  const shutdownOnSignal = createShutdownHandler({
    browser,
    server,
    offListeners: () => {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
    },
  });
  const sigintHandler = () => void shutdownOnSignal('SIGINT');
  const sigtermHandler = () => void shutdownOnSignal('SIGTERM');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  let exitCode = 0;
  let measuredCount = 0;
  const unmeasuredIds = new Set();

  // Plan 39.1-30 first_fix: the hard timeout must exit PROMPTLY. `Promise.race`
  // cannot cancel the losing side — once the timeout branch rejects, the
  // measurement loop below keeps running unawaited in the background. The
  // original code's ONLY cleanup was the `finally` block's graceful
  // `browser.close()`, which itself waits on the SAME CDP connection the
  // orphaned `page.evaluate()` is still using — measured taking ~16 minutes
  // wall-clock to actually exit. `forceExitOnTimeout` is fired the instant
  // the timer elapses (see `withHardTimeout`'s `onTimeout` hook): it
  // SIGKILLs the browser process directly (no graceful CDP round trip, so it
  // cannot be blocked by an in-flight orphaned evaluate), closes the server,
  // prints the same summary lines the normal path prints, and calls
  // `process.exit(1)` itself — never returning control to the `try/catch`
  // below, whose own cleanup would otherwise still be racing the orphaned
  // loop.
  let hardTimedOut = false;
  const forceExitOnTimeout = async () => {
    hardTimedOut = true;
    console.error(`guardLayout exceeded its ${HARD_TIMEOUT_MS}ms hard timeout — force-exiting`);
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    const browserProcess = browser.process();
    if (browserProcess) {
      browserProcess.kill('SIGKILL');
    } else {
      await browser.close().catch(() => {});
    }
    await server.close().catch(() => {});
    console.log(`MEASURED_ROUTES=${measuredCount}`);
    console.log(
      `UNMEASURED_ROUTES=${unmeasuredIds.size > 0 ? [...unmeasuredIds].join(',') : 'NONE'}`,
    );
    process.exit(1);
  };

  try {
    await withHardTimeout(
      (async () => {
        for (const route of LAYOUT_ORACLE_ROUTES) {
          if (hardTimedOut) break;
          // Plan 39.1-30: a route's own `extraViewports` (keys of
          // `EXTRA_ORACLE_VIEWPORTS`) are measured IN ADDITION TO the three
          // standard viewports — every other route's viewport set is
          // unchanged (`extraViewports` is `undefined` for them).
          const routeViewports = [
            ...LAYOUT_ORACLE_VIEWPORTS,
            ...(route.extraViewports ?? []).map((key) => EXTRA_ORACLE_VIEWPORTS[key]),
          ];
          for (const viewport of routeViewports) {
            if (hardTimedOut) break;
            const result = await measureRouteAtViewport(browser, baseUrl, route, viewport);
            if (hardTimedOut) break;
            if (result.unmeasured) {
              console.log(
                `UNMEASURED route=${route.id} viewport=${viewport.name} reason="${result.reason}"`,
              );
              unmeasuredIds.add(route.id);
              exitCode = 1;
              continue;
            }
            measuredCount += 1;
            console.log(
              `MEASUREMENT route=${route.id} viewport=${viewport.name} maxStretchPx=${result.maxStretchPx.toFixed(1)} scrollRatio=${result.scrollRatio.toFixed(3)}`,
            );
            for (const violation of result.violations) {
              console.log(
                `VIOLATION route=${route.id} viewport=${viewport.name} type=${violation.type} selector=${violation.selectorPath ?? 'n/a'} detail=${JSON.stringify(violation)}`,
              );
              exitCode = 1;
            }
          }
        }
      })().catch((error) => {
        // Swallow errors from the ABANDONED loop after a hard timeout — the
        // browser process is already SIGKILLed by `forceExitOnTimeout`, so
        // an in-flight `page.evaluate()`/`browser.newPage()` throws almost
        // immediately ("Protocol error", "Target closed"). That rejection
        // has nothing left to report to — `forceExitOnTimeout` already
        // printed the summary and is calling `process.exit(1)`. Re-throwing
        // here would surface as an actual unhandled rejection.
        if (hardTimedOut) return;
        throw error;
      }),
      HARD_TIMEOUT_MS,
      'guardLayout',
      forceExitOnTimeout,
    );
  } catch (error) {
    if (hardTimedOut) {
      // `forceExitOnTimeout` already printed the summary and is calling
      // `process.exit(1)` — do not race it with a second summary/exit.
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    exitCode = 1;
  } finally {
    if (!hardTimedOut) {
      // Normal completion: unregister the signal handlers ABOVE actually
      // closing browser/server — a signal arriving in the narrow window
      // during this shutdown would otherwise race a second close against
      // the one already in flight (both `.close()` calls below are already
      // idempotent via `.catch(() => {})`, but there is no reason to leave
      // the listeners live past this point).
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  if (hardTimedOut) {
    // `forceExitOnTimeout` owns the exit in this path.
    return;
  }

  console.log(`MEASURED_ROUTES=${measuredCount}`);
  console.log(
    `UNMEASURED_ROUTES=${unmeasuredIds.size > 0 ? [...unmeasuredIds].join(',') : 'NONE'}`,
  );

  process.exit(exitCode);
}

// Only auto-run when this file is executed directly (`node guardLayout.mjs` /
// `pnpm guard:layout`) — NOT when imported as a module, e.g. by
// `guardLayoutShutdown.test.mjs`'s unit tests against `createShutdownHandler`
// above. Without this guard, importing this file for that ONE named export
// would also launch a real Puppeteer browser, a real Vite dev server, and
// the full route-measurement sweep as an unwanted side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
