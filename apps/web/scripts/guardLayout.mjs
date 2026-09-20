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
 * In THIS plan `LAYOUT_ORACLE_ROUTES` contains ONLY the harness's own
 * stretch fixture route, mirroring the single entry in
 * `guardHarnessRoutes.tsx`. Plan 39.1-20 adds the real analytics routes to
 * BOTH — the route table (so they can be mounted) and this array (so they
 * are measured).
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

    return { unmeasured: false, violations };
  } finally {
    await page.close();
  }
}

async function main() {
  const { server, baseUrl } = await startGuardLayoutHarnessServer();
  const browser = await puppeteer.launch();

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
              console.log(`UNMEASURED route=${route.id} viewport=${viewport.name} reason="${result.reason}"`);
              unmeasuredIds.add(route.id);
              exitCode = 1;
              continue;
            }
            measuredCount += 1;
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
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  console.log(`MEASURED_ROUTES=${measuredCount}`);
  console.log(
    `UNMEASURED_ROUTES=${unmeasuredIds.size > 0 ? [...unmeasuredIds].join(',') : 'NONE'}`,
  );

  process.exit(exitCode);
}

void main();
