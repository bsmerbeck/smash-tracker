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
  LAYOUT_ORACLE_VIEWPORTS,
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
  { id: 'matchups', loadedMarker: '[data-slot="matchup-chart-body"]' },
  { id: 'match-data', loadedMarker: '[data-slot="match-data-rail"]' },
  { id: 'trends', loadedMarker: '[data-slot="trends-hero-body"]' },
  { id: 'opponents', loadedMarker: '[data-slot="opponents-body"]' },
  { id: 'opponent-hub', loadedMarker: '[data-slot="opponent-hub-body"]' },
  { id: 'stage-detail', loadedMarker: '[data-slot="stage-detail-body"]' },
];

const HARD_TIMEOUT_MS = Number(process.env.GUARD_LAYOUT_HARD_TIMEOUT_MS) || 5 * 60 * 1000;
const ROUTE_LOAD_TIMEOUT_MS = 15_000;

function withHardTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms hard timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs entirely inside the browser context — no closures over outer scope. */
function collectPageMeasurements() {
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

  return {
    cards,
    truncationElements,
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

    const measurements = await page.evaluate(collectPageMeasurements);

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

  try {
    await withHardTimeout(
      (async () => {
        for (const route of LAYOUT_ORACLE_ROUTES) {
          for (const viewport of LAYOUT_ORACLE_VIEWPORTS) {
            const result = await measureRouteAtViewport(browser, baseUrl, route, viewport);
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
      })(),
      HARD_TIMEOUT_MS,
      'guardLayout',
    );
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    exitCode = 1;
  } finally {
    // Normal completion: unregister the signal handlers ABOVE actually
    // closing browser/server — a signal arriving in the narrow window
    // during this shutdown would otherwise race a second close against the
    // one already in flight (both `.close()` calls below are already
    // idempotent via `.catch(() => {})`, but there is no reason to leave
    // the listeners live past this point).
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
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
