#!/usr/bin/env node
/**
 * SCL-01 browser-budget measurement (Phase 36 Plan 06, Task 3B) —
 * `filter-change-to-paint-8k` and `heap-delta-50k`. Real Chrome, real
 * `MatchupsPage`, real shared engine, SYNTHETIC data at the stated scale —
 * never the real sparg0 account (that arm is already recorded separately,
 * see `apps/api/scripts/sparg0RealDataReadout.ts`). Needs no credentials:
 * starts a Vite dev server bound to 127.0.0.1 with a harness-only fixture
 * plugin, launches Puppeteer against it, measures, and ALWAYS shuts both
 * down (try/finally + a hard timeout) so this process can never hang —
 * this repo has a zombie-CLI history (`enrichDemoAccounts.ts`).
 *
 * USAGE:
 *   pnpm --filter @smash-tracker/web run budget:browser
 *
 * Reads targets from `packages/shared/src/evidence/budgets.ts` via
 * `scl01BrowserBudgetCore.mjs`; never edits them (D-19). Exits non-zero
 * when either measured budget MISSes.
 */
import { createServer as createViteServer } from 'vite';
import puppeteer from 'puppeteer';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '@smash-tracker/shared/testUtils';
import { BUDGET_SAMPLE_ITERATIONS } from '@smash-tracker/shared';
import { createPerfFixturePlugin } from './perfFixturePlugin.mjs';
import {
  buildFilterChangeToPaintResult,
  buildHeapDeltaResult,
  bytesToMb,
} from './scl01BrowserBudgetCore.mjs';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE_CONFIG_PATH = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const FIGHTER_A_ID = 8; // Fox — a DEFAULT_MAIN_FIGHTER_IDS entry, guaranteed heavy coverage in the fixture
const FIGHTER_B_ID = 22; // Falco — likewise
const FIGHTER_A_NAME = 'Fox';
const FIGHTER_B_NAME = 'Falco';
const HEAP_SAMPLE_COUNT = 5;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

function withHardTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms hard timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startHarnessServer(scales) {
  const server = await createViteServer({
    root: WEB_ROOT,
    configFile: VITE_CONFIG_PATH,
    // 'development' — the harness measures a Vite DEV server, matching this
    // task's explicit spec ("starts Vite programmatically"), not a
    // minified production bundle. The protocol/readout state this plainly.
    mode: 'development',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [
      createPerfFixturePlugin({
        scales,
        initialScale: '8k',
        fighterSelection: { primary: [FIGHTER_A_ID, FIGHTER_B_ID], secondary: [] },
      }),
    ],
    define: {
      // Fake, syntactically-valid Firebase Web SDK config so
      // `getFirebaseAuth()` (called unconditionally by lib/api.ts's
      // `getAuthHeader()` on every request) does not throw. The harness's
      // fake AuthContext value is a SEPARATE substitution (see
      // `fakeAuthContextValue.ts`) — this define exists only so an
      // unrelated, real SDK call doesn't crash; no sign-in is ever
      // attempted, so no network call to a real Firebase project happens.
      'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify('scl01-harness-fake-key'),
      'import.meta.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify('scl01-harness.example.invalid'),
      'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify('scl01-harness-fake-project'),
      'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify('1:0:web:0000000000000000000000'),
      // Empty string (never left `undefined`, which falls back to
      // `http://localhost:3001`): keeps every `/api/**` request relative,
      // so it lands on THIS SAME Vite dev server origin — the one origin
      // the fixture plugin above actually answers. Mirrors production's
      // own same-origin Hosting-rewrite behavior (see `getApiBaseUrl`'s
      // doc comment in `lib/api.ts`).
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    throw new Error('perf harness Vite server did not bind a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function setScale(baseUrl, scale) {
  const response = await fetch(`${baseUrl}/api/__perf-harness__/set-scale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale }),
  });
  if (!response.ok) {
    throw new Error(`set-scale(${scale}) failed: ${response.status} ${await response.text()}`);
  }
}

async function waitForFighterPickerReady(page) {
  await page.waitForSelector('button[aria-label="Select your fighter"]', { timeout: 30_000 });
}

/** One-time setup: open the opponent picker and pick the first (most-faced) entry, so every card on the page is active for every later fighter switch. */
async function selectFirstOpponent(page) {
  await page.click('button[aria-label="Select opponent fighter"]');
  await page.waitForSelector('[role="option"]', { timeout: 10_000 });
  await page.evaluate(() => {
    const first = document.querySelector('[role="option"]');
    if (!first) {
      throw new Error('no opponent option rendered');
    }
    first.click();
  });
  // Radix closes the popover asynchronously; give it a moment before the next open.
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 0, {
    timeout: 10_000,
  });
}

/**
 * One timed fighter switch: opens the "You" picker (untimed — this is UI
 * navigation, not the filter-change input), then — INSIDE the browser, no
 * CDP round trip in the timed window — marks `performance.now()` at the
 * instant the target option's native `.click()` is dispatched, waits (via
 * MutationObserver) for the trigger's own displayed text to reflect the
 * new fighter, then a double-`requestAnimationFrame` to guarantee a real
 * paint has happened, and returns the elapsed milliseconds.
 */
async function timedFighterSwitch(page, targetName) {
  await page.click('button[aria-label="Select your fighter"]');
  await page.waitForSelector('[role="option"]', { timeout: 10_000 });

  const elapsedMs = await page.evaluate((name) => {
    return new Promise((resolve, reject) => {
      const items = Array.from(document.querySelectorAll('[role="option"]'));
      const target = items.find((el) => el.textContent && el.textContent.includes(name));
      const trigger = document.querySelector('button[aria-label="Select your fighter"]');
      if (!target || !trigger) {
        reject(new Error(`could not find option/trigger for ${name}`));
        return;
      }
      const observer = new MutationObserver(() => {
        if (trigger.textContent && trigger.textContent.includes(name)) {
          observer.disconnect();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve(performance.now() - start);
            });
          });
        }
      });
      observer.observe(trigger, { subtree: true, characterData: true, childList: true });
      const start = performance.now();
      target.click();
    });
  }, targetName);

  // Radix closes the popover asynchronously after a selection; wait for it
  // to fully leave the DOM before the NEXT iteration reopens the trigger —
  // without this, a click during the close transition intermittently
  // misses or reopens a stale popover (observed as flaky `[role="option"]`
  // timeouts across repeated iterations).
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 0, {
    timeout: 10_000,
  });

  return elapsedMs;
}

async function measureFilterChangeToPaint(browser, baseUrl) {
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/perf-harness.html`, { waitUntil: 'networkidle0' });
    await waitForFighterPickerReady(page);
    await selectFirstOpponent(page);

    const samplesMs = [];
    let current = FIGHTER_A_ID;
    for (let i = 0; i < BUDGET_SAMPLE_ITERATIONS; i += 1) {
      const targetId = current === FIGHTER_A_ID ? FIGHTER_B_ID : FIGHTER_A_ID;
      const targetName = targetId === FIGHTER_A_ID ? FIGHTER_A_NAME : FIGHTER_B_NAME;
      const ms = await timedFighterSwitch(page, targetName);
      samplesMs.push(ms);
      current = targetId;
    }
    return samplesMs;
  } finally {
    await page.close();
  }
}

/** Forces a GC then reads JSHeapUsedSize via CDP `page.metrics()`. */
async function measureHeapBytes(page) {
  const client = await page.createCDPSession();
  await client.send('HeapProfiler.enable');
  await client.send('HeapProfiler.collectGarbage');
  await client.detach();
  const metrics = await page.metrics();
  return metrics.JSHeapUsedSize ?? 0;
}

/**
 * One heap-delta sample: a FRESH browser context (per this task's explicit
 * requirement), BEFORE = the harness loaded against an EMPTY (0-match)
 * fixture and fully settled, AFTER = the SAME page reloaded against the
 * 50k fixture and fully settled. Base app/React overhead is present in
 * BOTH snapshots and cancels out in the subtraction, isolating the memory
 * cost specifically attributable to the 50k dataset + its derived
 * evidence-engine structures.
 */
async function measureOneHeapDeltaSample(browser, baseUrl) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await setScale(baseUrl, 'empty');
    await page.goto(`${baseUrl}/perf-harness.html`, { waitUntil: 'networkidle0' });
    const beforeBytes = await measureHeapBytes(page);

    await setScale(baseUrl, '50k');
    await page.reload({ waitUntil: 'networkidle0' });
    // Let the 50k fixture's fetch + engine recompute fully settle before sampling.
    await waitForFighterPickerReady(page);
    const afterBytes = await measureHeapBytes(page);

    return bytesToMb(Math.max(0, afterBytes - beforeBytes));
  } finally {
    await context.close();
  }
}

async function measureHeapDelta(browser, baseUrl) {
  const samplesMb = [];
  for (let i = 0; i < HEAP_SAMPLE_COUNT; i += 1) {
    samplesMb.push(await measureOneHeapDeltaSample(browser, baseUrl));
  }
  return samplesMb;
}

function machineContextLine(chromeVersion) {
  const cpus = os.cpus();
  return `SCL-01-BROWSER machine cpu="${cpus[0]?.model ?? 'unknown'}" cores=${cpus.length} node=${process.version} chrome="${chromeVersion}" headless=true`;
}

async function main() {
  const eightK = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS).map((m, i) => ({
    id: `harness-8k-${i}`,
    ...m,
  }));
  const fiftyK = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS).map((m, i) => ({
    id: `harness-50k-${i}`,
    ...m,
  }));

  const { server, baseUrl } = await startHarnessServer({ '8k': eightK, empty: [], '50k': fiftyK });
  // prerender.mjs's own launch pattern — no special args needed in this repo's environments.
  const browser = await puppeteer.launch();

  let exitCode = 0;
  try {
    await withHardTimeout(
      (async () => {
        const chromeVersion = await browser.version();
        console.log(machineContextLine(chromeVersion));

        const paintSamplesMs = await measureFilterChangeToPaint(browser, baseUrl);
        const paintResult = buildFilterChangeToPaintResult(paintSamplesMs);
        console.log(paintResult.line);
        console.log(
          `SCL-01-BROWSER filter-change-to-paint-8k samples=${JSON.stringify(paintSamplesMs)}`,
        );
        if (paintResult.verdict === 'MISS') {
          exitCode = 1;
        }

        const heapSamplesMb = await measureHeapDelta(browser, baseUrl);
        const heapResult = buildHeapDeltaResult(heapSamplesMb);
        console.log(heapResult.line);
        console.log(`SCL-01-BROWSER heap-delta-50k samples=${JSON.stringify(heapSamplesMb)}`);
        if (heapResult.verdict === 'MISS') {
          exitCode = 1;
        }
      })(),
      HARD_TIMEOUT_MS,
      'scl01BrowserBudget',
    );
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  process.exit(exitCode);
}

void main();
