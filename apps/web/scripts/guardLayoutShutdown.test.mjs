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
import { createShutdownHandler, createHardTimeoutExit } from './guardLayout.mjs';

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

/**
 * WR-10 (39.1-REVIEW.md): the HARD-TIMEOUT exit path. Puppeteer launches
 * Chrome `detached` on POSIX (its own process-group leader), so SIGKILLing
 * only the leader pid can orphan its helpers (crashpad, zygote); and an
 * unbounded `await server.close()` can hang the very exit the timeout
 * exists to force. Fakes only — no real browser, server or process exit.
 */
function makeTimeoutFixture({ serverClose, groupKillThrows = false, closeTimeoutMs = 50 } = {}) {
  const events = [];
  const browserProcess = {
    pid: 4242,
    kill(signal) {
      events.push(['leader-kill', signal]);
    },
  };
  const browser = {
    process: () => browserProcess,
    async close() {
      events.push(['browser-close']);
    },
  };
  const server = {
    close:
      serverClose ??
      (async () => {
        events.push(['server-close']);
      }),
  };
  const forceExit = createHardTimeoutExit({
    browser,
    server,
    offListeners: () => events.push(['off-listeners']),
    printSummary: () => events.push(['summary']),
    exit: (code) => events.push(['exit', code]),
    kill: (pid, signal) => {
      events.push(['group-kill', pid, signal]);
      if (groupKillThrows) {
        throw new Error('ESRCH / unsupported negative pid');
      }
    },
    serverCloseTimeoutMs: closeTimeoutMs,
  });
  return { events, forceExit };
}

test('WR-10: the hard-timeout exit SIGKILLs the browser\'s whole process group (negative pid), not only its leader', async () => {
  const { events, forceExit } = makeTimeoutFixture();
  await forceExit();
  assert.deepEqual(
    events.find(([kind]) => kind === 'group-kill'),
    ['group-kill', -4242, 'SIGKILL'],
  );
  assert.equal(
    events.some(([kind]) => kind === 'leader-kill'),
    false,
    'the group kill already covers the leader',
  );
  assert.deepEqual(events[events.length - 1], ['exit', 1]);
});

test('WR-10: where a process-group kill is unsupported it falls back to SIGKILLing the leader', async () => {
  const { events, forceExit } = makeTimeoutFixture({ groupKillThrows: true });
  await forceExit();
  assert.deepEqual(events.find(([kind]) => kind === 'leader-kill'), ['leader-kill', 'SIGKILL']);
  assert.deepEqual(events[events.length - 1], ['exit', 1]);
});

test('WR-10: a server.close() that never settles cannot hang the exit — it is bounded and the process still exits 1 promptly', async () => {
  const { events, forceExit } = makeTimeoutFixture({
    serverClose: () => new Promise(() => {}),
    closeTimeoutMs: 50,
  });
  const started = Date.now();
  await forceExit();
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 1_000, `expected a prompt exit, took ${elapsedMs}ms`);
  assert.deepEqual(
    events.map(([kind]) => kind),
    ['off-listeners', 'group-kill', 'summary', 'exit'],
  );
  assert.deepEqual(events[events.length - 1], ['exit', 1]);
});

test('WR-10: firing the hard-timeout exit twice kills and exits once', async () => {
  const { events, forceExit } = makeTimeoutFixture();
  await Promise.all([forceExit(), forceExit()]);
  assert.equal(events.filter(([kind]) => kind === 'exit').length, 1);
  assert.equal(events.filter(([kind]) => kind === 'group-kill').length, 1);
});
