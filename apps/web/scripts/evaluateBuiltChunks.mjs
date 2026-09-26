/**
 * Plan 39.1-51: `pnpm --filter @smash-tracker/web run verify:built-chunks`.
 *
 * Rules out the PR #181 crash class (a built chunk that throws when a browser
 * evaluates it — the charts-vendor <-> TrendLine static cycle shipped
 * `TypeError: undefined is not a function` to production) in a REAL browser. jsdom
 * and vitest never evaluate built chunks, so this:
 * 1. builds the production bundle with the real vite.config.ts into a temp dir
 *    (fixed, non-secret dummy Firebase values in process.env and an empty `envDir`,
 *    so no .env file is read, copied or printed);
 * 2. writes a blank `__chunk-eval.html` and two deliberately broken control chunks
 *    into that TEMP output only (never the working tree);
 * 3. serves it with `vite preview` on loopback and, in headless Chrome (every
 *    non-loopback request aborted), imports: every eager chunk alone, every lazy
 *    (dynamic-entry) chunk alone, a real app boot, every lazy chunk after that boot,
 *    the lazy chunks in reverse order, every chunk of the build alone, and each
 *    control alone;
 * 4. prints CHUNK_EVAL / CHUNK_EVAL_ERROR / CHUNK_EVAL_CONTROL / CHUNK_GRAPH lines
 *    and CHUNK_EVAL_OK or CHUNK_EVAL_FAIL <reasons> (exit 0 / 1).
 *
 * The pure parts (closure, Tarjan SCC, scenario plan, controls, verdict) live in
 * `evaluateBuiltChunksCore.mjs` and are pinned by node:test. `--keep` keeps the temp
 * build and prints its path.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import puppeteer from 'puppeteer';
import { createHardTimeoutExit, createShutdownHandler } from './guardLayout.mjs';
import {
  buildControlChunks,
  computeEagerClosure,
  evaluateRun,
  findChunkCycles,
  planScenarios,
} from './evaluateBuiltChunksCore.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 30_000;
const BOOT_SETTLE_MS = 1_500;
const PROGRESS_EVERY = 25;
const MAX_CONSOLE_LINES = 20;
const ALONE_CONCURRENCY = 4;
const BLANK_PAGE = '__chunk-eval.html';

/**
 * Fixed, well-formed, NON-SECRET values so the boot needs no credential. The key is
 * shaped like a Firebase web key (`AIza` + 35 characters) and is not a real key.
 */
const DUMMY_BUILD_ENV = {
  VITE_FIREBASE_API_KEY: `AIza${'ChunkEvalDummyNotARealKey'.padEnd(35, '0')}`,
  VITE_FIREBASE_AUTH_DOMAIN: 'chunk-eval.invalid',
  VITE_FIREBASE_PROJECT_ID: 'chunk-eval-dummy',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
  VITE_FIREBASE_MEASUREMENT_ID: '',
};

const oneLine = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

async function main() {
  const keep = process.argv.includes('--keep');
  Object.assign(process.env, DUMMY_BUILD_ENV);

  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chunk-eval-'));
  // An EMPTY env dir: Vite then reads no .env file at all, whatever the checkout holds;
  // the VITE_* values above reach the build from process.env.
  const envDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chunk-eval-env-'));
  const removeOutDir = () => {
    fs.rmSync(envDir, { recursive: true, force: true });
    if (!keep) fs.rmSync(outDir, { recursive: true, force: true });
    else console.log(`CHUNK_EVAL_KEEP ${outDir}`);
  };

  let server = null;
  let browser = null;
  let exitCode;
  try {
    const result = await build({
      root: WEB_ROOT,
      configFile: path.join(WEB_ROOT, 'vite.config.ts'),
      mode: 'production',
      envDir,
      logLevel: 'warn',
      build: { outDir, emptyOutDir: true },
    });
    const single = Array.isArray(result) ? result[0] : result;
    const chunks = single.output
      .filter((o) => o.type === 'chunk')
      .map(({ fileName, isEntry, isDynamicEntry, imports, dynamicImports }) => ({
        type: 'chunk',
        fileName,
        isEntry,
        isDynamicEntry,
        imports,
        dynamicImports,
      }));
    const entries = chunks.filter((c) => c.isEntry);
    if (entries.length !== 1) throw new Error(`expected one entry chunk, found ${entries.length}`);
    const entryFileName = entries[0].fileName;

    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const modulepreload = (indexHtml.match(/rel="modulepreload"/g) ?? []).length;
    const eager = computeEagerClosure(chunks);
    const plan = planScenarios(chunks);
    const sccs = findChunkCycles(chunks);
    for (const scc of sccs) console.log(`CHUNK_GRAPH_CYCLE ${scc.join(' ')}`);

    const controls = buildControlChunks({ entryFileName });
    for (const control of controls) {
      for (const file of control.files) {
        fs.writeFileSync(path.join(outDir, file.fileName), file.source);
      }
    }
    const controlSccs = findChunkCycles([
      ...chunks,
      ...controls.flatMap((c) => c.records.map((r) => ({ type: 'chunk', ...r }))),
    ]);
    fs.writeFileSync(
      path.join(outDir, BLANK_PAGE),
      '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>\n',
    );

    server = await preview({
      root: WEB_ROOT,
      configFile: path.join(WEB_ROOT, 'vite.config.ts'),
      envDir,
      logLevel: 'warn',
      build: { outDir },
      preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    });
    const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!origin) throw new Error('vite preview did not report a local URL');

    browser = await puppeteer.launch({ handleSIGINT: false, handleSIGTERM: false });

    const offListeners = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
    const onSignal = createShutdownHandler({ browser, server, offListeners });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const forceExit = createHardTimeoutExit({
      browser,
      server,
      offListeners,
      printSummary: () => {
        console.log('CHUNK_EVAL_FAIL hard-timeout');
        removeOutDir();
      },
    });
    const hardTimer = setTimeout(() => void forceExit(), HARD_TIMEOUT_MS);
    hardTimer.unref();

    const totalPages =
      plan['eager-alone'].length +
      plan['lazy-alone'].length +
      2 +
      plan['every-chunk-alone'].length +
      controls.length;
    let donePages = 0;
    const pageDone = () => {
      donePages += 1;
      if (donePages % PROGRESS_EVERY === 0 || donePages === totalPages) {
        console.log(`CHUNK_EVAL_PROGRESS done=${donePages}/${totalPages}`);
      }
    };
    let consoleLines = 0;

    /** A fresh page: loopback-only network, error capture, console errors echoed (never counted). */
    async function openPage(scenario) {
      const page = await browser.newPage();
      const errors = [];
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:')) return void request.continue();
        let requestOrigin = '';
        try {
          requestOrigin = new URL(url).origin;
        } catch {
          // Unparseable URL: abort below.
        }
        if (requestOrigin === origin) void request.continue();
        else void request.abort();
      });
      page.on('pageerror', (err) => errors.push(err?.stack || err?.message || String(err)));
      page.on('console', (msg) => {
        if (msg.type() !== 'error' || consoleLines >= MAX_CONSOLE_LINES) return;
        consoleLines += 1;
        console.log(`CHUNK_EVAL_CONSOLE scenario=${scenario} text=${oneLine(msg.text())}`);
      });
      await page.evaluateOnNewDocument(() => {
        window.__chunkEvalRejections = [];
        window.addEventListener('unhandledrejection', (event) => {
          const reason = event.reason;
          window.__chunkEvalRejections.push(
            String((reason && (reason.stack || reason.message)) || reason),
          );
        });
      });
      return { page, errors };
    }

    /** Pending page errors and unhandled rejections, drained. */
    async function drain(handle) {
      const rejections = await handle.page
        .evaluate(() => window.__chunkEvalRejections.splice(0))
        .catch(() => []);
      return [...handle.errors.splice(0), ...rejections];
    }

    async function importChunk(handle, fileName) {
      const url = `${origin}/${fileName}`;
      const failure = await Promise.race([
        handle.page.evaluate(async (u) => {
          try {
            await import(u);
            return null;
          } catch (error) {
            return String((error && (error.stack || error.message)) || error);
          }
        }, url),
        new Promise((resolve) =>
          setTimeout(
            () => resolve(`import timed out after ${IMPORT_TIMEOUT_MS} ms`),
            IMPORT_TIMEOUT_MS,
          ),
        ),
      ]);
      // Let a same-tick async throw reach pageerror / unhandledrejection.
      await handle.page.evaluate(() => new Promise((r) => setTimeout(r, 0))).catch(() => {});
      const errors = await drain(handle);
      return failure ? [failure, ...errors] : errors;
    }

    const results = [];
    function record(scenario, chunk, errorList) {
      for (const error of errorList) {
        console.log(`CHUNK_EVAL_ERROR scenario=${scenario} chunk=${chunk} error=${oneLine(error)}`);
      }
      return errorList.length;
    }

    /** Each chunk alone in its own blank page (a small pool). */
    async function aloneScenario(name, fileNames) {
      let errors = 0;
      let imports = 0;
      const queue = [...fileNames];
      async function worker() {
        while (queue.length > 0) {
          const fileName = queue.shift();
          const handle = await openPage(name);
          try {
            await handle.page.goto(`${origin}/${BLANK_PAGE}`, { waitUntil: 'load' });
            imports += 1;
            errors += record(name, fileName, await importChunk(handle, fileName));
          } finally {
            await handle.page.close().catch(() => {});
            pageDone();
          }
        }
      }
      await Promise.all(Array.from({ length: ALONE_CONCURRENCY }, worker));
      const line = { name, pages: fileNames.length, imports, errors };
      results.push(line);
      console.log(
        `CHUNK_EVAL scenario=${name} pages=${line.pages} imports=${imports} errors=${errors}`,
      );
    }

    /** Several chunks imported in order in one page. */
    async function sequenceIn(handle, name, fileNames) {
      let errors = 0;
      let imports = 0;
      for (const fileName of fileNames) {
        imports += 1;
        errors += record(name, fileName, await importChunk(handle, fileName));
      }
      return { imports, errors };
    }

    await aloneScenario('eager-alone', plan['eager-alone']);
    await aloneScenario('lazy-alone', plan['lazy-alone']);

    // A real app boot, then every lazy chunk in that booted page.
    let bootRendered = false;
    {
      const handle = await openPage('boot');
      try {
        await handle.page.goto(`${origin}/`, { waitUntil: 'load' });
        await handle.page
          .waitForFunction(() => (document.querySelector('#root')?.children.length ?? 0) > 0, {
            timeout: 30_000,
          })
          .catch(() => {});
        await handle.page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
        await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
        bootRendered = await handle.page.evaluate(
          () => (document.querySelector('#root')?.children.length ?? 0) > 0,
        );
        const bootErrors = record('boot', entryFileName, await drain(handle));
        results.push({ name: 'boot', pages: 1, imports: 1, errors: bootErrors });
        console.log(`CHUNK_EVAL scenario=boot pages=1 imports=1 errors=${bootErrors}`);
        const after = await sequenceIn(handle, 'all-after-boot', plan['all-after-boot']);
        results.push({ name: 'all-after-boot', pages: 1, ...after });
        console.log(
          `CHUNK_EVAL scenario=all-after-boot pages=1 imports=${after.imports} errors=${after.errors}`,
        );
      } finally {
        await handle.page.close().catch(() => {});
        pageDone();
      }
    }

    {
      const handle = await openPage('lazy-reverse');
      try {
        await handle.page.goto(`${origin}/${BLANK_PAGE}`, { waitUntil: 'load' });
        const reverse = await sequenceIn(handle, 'lazy-reverse', plan['lazy-reverse']);
        results.push({ name: 'lazy-reverse', pages: 1, ...reverse });
        console.log(
          `CHUNK_EVAL scenario=lazy-reverse pages=1 imports=${reverse.imports} errors=${reverse.errors}`,
        );
      } finally {
        await handle.page.close().catch(() => {});
        pageDone();
      }
    }

    await aloneScenario('every-chunk-alone', plan['every-chunk-alone']);

    const controlResults = [];
    for (const control of controls) {
      const handle = await openPage(`control-${control.name}`);
      try {
        await handle.page.goto(`${origin}/${BLANK_PAGE}`, { waitUntil: 'load' });
        const errors = await importChunk(handle, control.importTarget);
        const caught = errors.length > 0;
        controlResults.push({ name: control.name, caught });
        console.log(
          `CHUNK_EVAL_CONTROL name=${control.name} caught=${caught} error=${oneLine(errors[0] ?? 'none')}`,
        );
      } finally {
        await handle.page.close().catch(() => {});
        pageDone();
      }
    }

    console.log(
      `CHUNK_GRAPH chunks=${chunks.length} eager=${eager.size} dynamicEntries=${plan['lazy-alone'].length} sccs=${sccs.length} controlSccs=${controlSccs.length} modulepreload=${modulepreload}`,
    );
    const verdict = evaluateRun({
      scenarios: results,
      controls: controlResults,
      sccs: sccs.length,
      controlSccs: controlSccs.length,
      bootRendered,
      modulepreload,
    });
    console.log(verdict.ok ? 'CHUNK_EVAL_OK' : `CHUNK_EVAL_FAIL ${verdict.reasons.join(' ')}`);
    exitCode = verdict.ok ? 0 : 1;
    clearTimeout(hardTimer);
    offListeners();
  } catch (error) {
    console.log(`CHUNK_EVAL_FAIL crashed ${oneLine(error?.stack || error)}`);
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    removeOutDir();
  }
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
