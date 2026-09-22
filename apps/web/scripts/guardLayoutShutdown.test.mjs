/**
 * WR-B03 (39.1-REVIEW.md): proves `guardLayout.mjs`'s exported
 * `createShutdownHandler` factory actually closes the headless Chromium
 * browser and the Vite dev server it launches — in order, exactly once,
 * even under a double signal — rather than leaving them orphaned when an
 * operator cancels a hung/long run with Ctrl-C (this repo has documented
 * zombie-CLI history — `enrichDemoAccounts.ts` — which is exactly the
 * failure class this test guards against for `guard:layout`'s own two
 * spawned processes).
 *
 * Plain Node test file, run directly via
 * `node --test apps/web/scripts/guardLayoutShutdown.test.mjs` — the same
 * invocation style `guardLayoutCore.test.mjs`/`guardPaletteCore.test.mjs`
 * already use.
 *
 * DELIBERATELY a unit test against FAKE browser/server objects (never a
 * real Puppeteer browser or a real Vite dev server, and never this test
 * process's own real `SIGINT`/`SIGTERM` listeners) — an earlier version of
 * this file spawned the real `guardLayout.mjs` script as a child process
 * and sent it real signals, but that approach turned out NOT to
 * discriminate a fixed vs. unfixed `guardLayout.mjs`: both Puppeteer's own
 * launcher (`@puppeteer/browsers`, `handleSIGINT`/`handleSIGTERM` default
 * `true`) and Vite's own dev server (`setupSIGTERMListener`) install their
 * OWN competing signal handlers that independently call `process.exit()`,
 * so the child process ends up exiting (and its port stops accepting
 * connections, since the OS reclaims sockets when the WHOLE process dies)
 * even with none of THIS script's own shutdown code present at all. The
 * only reliably assertable, deterministic property is that the handler
 * THIS script installs — `createShutdownHandler`'s returned closure —
 * closes both dependencies, in order, exactly once. `guardLayout.mjs`'s own
 * `main()` additionally disables Puppeteer's competing handling
 * (`handleSIGINT: false` etc.) and removes Vite's (`process.removeAllListeners`)
 * so this handler is the sole owner of the real process's shutdown — that
 * wiring is inspected directly below via a source-text assertion, since it
 * has no independently-observable runtime effect separate from the two
 * libraries' own (already faked-out, for this test) behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createShutdownHandler } from './guardLayout.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./guardLayout.mjs', import.meta.url));

function makeFakeCloseable(name, calls) {
  return {
    async close() {
      calls.push(name);
    },
  };
}

test('closes the browser then the server, in order, on a single signal', async () => {
  const calls = [];
  const browser = makeFakeCloseable('browser', calls);
  const server = makeFakeCloseable('server', calls);
  let offListenersCalled = false;
  let killedWith = null;

  const shutdown = createShutdownHandler({
    browser,
    server,
    offListeners: () => {
      offListenersCalled = true;
    },
    kill: (signal) => {
      killedWith = signal;
    },
  });

  await shutdown('SIGINT');

  assert.deepEqual(calls, ['browser', 'server'], 'expected browser closed before server');
  assert.equal(offListenersCalled, true, 'expected the signal listeners to be removed');
  assert.equal(killedWith, 'SIGINT', 'expected the signal to be re-raised after cleanup');
});

test('a second signal during (or after) cleanup is a no-op — never double-closes', async () => {
  const calls = [];
  const browser = makeFakeCloseable('browser', calls);
  const server = makeFakeCloseable('server', calls);
  let killCount = 0;

  const shutdown = createShutdownHandler({
    browser,
    server,
    offListeners: () => {},
    kill: () => {
      killCount += 1;
    },
  });

  // Two overlapping SIGINTs (e.g. an impatient double Ctrl-C) — the guard
  // must make the second one a complete no-op, not just a skipped `kill`.
  await Promise.all([shutdown('SIGINT'), shutdown('SIGINT')]);
  await shutdown('SIGTERM');

  assert.deepEqual(calls, ['browser', 'server'], 'expected exactly one close of each dependency');
  assert.equal(killCount, 1, 'expected exactly one re-raised signal');
});

test("a browser.close() rejection doesn't prevent the server from being closed", async () => {
  const calls = [];
  const server = makeFakeCloseable('server', calls);
  const browser = {
    async close() {
      calls.push('browser');
      throw new Error('simulated browser close failure');
    },
  };
  let killedWith = null;

  const shutdown = createShutdownHandler({
    browser,
    server,
    offListeners: () => {},
    kill: (signal) => {
      killedWith = signal;
    },
  });

  await shutdown('SIGTERM');

  assert.deepEqual(
    calls,
    ['browser', 'server'],
    'expected the server closed despite the browser close failing',
  );
  assert.equal(killedWith, 'SIGTERM');
});

test('guardLayout.mjs disables every competing signal handler (Puppeteer default handling, Vite own listener) before installing its own', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  // Puppeteer's own SIGINT/SIGTERM/SIGHUP auto-handling, disabled at launch.
  assert.match(source, /handleSIGINT:\s*false/);
  assert.match(source, /handleSIGTERM:\s*false/);
  assert.match(source, /handleSIGHUP:\s*false/);
  // Vite's own competing dev-server SIGTERM listener, stripped before this
  // script's own handler is registered.
  assert.match(source, /process\.removeAllListeners\(['"]SIGINT['"]\)/);
  assert.match(source, /process\.removeAllListeners\(['"]SIGTERM['"]\)/);
  // This script's own handler is registered for both signals.
  assert.match(source, /process\.on\(['"]SIGINT['"],\s*sigintHandler\)/);
  assert.match(source, /process\.on\(['"]SIGTERM['"],\s*sigtermHandler\)/);
});
