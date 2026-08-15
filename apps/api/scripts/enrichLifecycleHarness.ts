/**
 * 30.2 reliability gate: child-process harness for `enrichLifecycle.test.ts`.
 * NOT a production entry point and never part of the build output
 * (`tsconfig.build.json` excludes `scripts/`).
 *
 * Simulates the zombie-process defect class WITHOUT any Firebase or network:
 * an artificial open handle (an interval, standing in for the firebase-admin
 * RTDB connection that kept the real operator alive 80+ minutes after
 * death) plus a `runWithLifecycle`-wrapped body per mode:
 *
 * - `success`      resolves; cleanup releases the handle -> natural exit 0.
 * - `failure`      rejects; cleanup releases the handle -> natural exit 1.
 * - `hang-cleanup` rejects; cleanup DOES NOT release the handle -> the
 *                  unref'd hard-exit backstop must force exit at
 *                  `hardExitMs`.
 * - `wait-signal`  never settles; the parent sends SIGINT -> abort race +
 *                  cleanup -> exit 130 within the bound.
 *
 * stdout markers (`run-settled`, `cleanup-start`, `cleanup-complete`) let
 * the test distinguish a natural exit from a forced one.
 */
import { runWithLifecycle } from './enrichLifecycle.js';

const mode = process.argv[2] ?? 'success';
const hardExitMs = Number(process.argv[3] ?? '1500');

// The artificial open handle: without lifecycle management this alone makes
// the process immortal, exactly like the leaked RTDB connection did.
const openHandle = setInterval(() => undefined, 1_000);

void runWithLifecycle({
  hardExitMs,
  log: (line) => console.log(line),
  run: async () => {
    if (mode === 'wait-signal') {
      // Deliberately ignores its AbortSignal — proves a signal still
      // terminates the process through the race + backstop.
      await new Promise<never>(() => undefined);
    }
    console.log('run-settled');
    if (mode === 'failure' || mode === 'hang-cleanup') {
      throw new Error('injected run failure');
    }
    return 0;
  },
  cleanup: async () => {
    console.log('cleanup-start');
    if (mode !== 'hang-cleanup') {
      clearInterval(openHandle);
    }
    console.log('cleanup-complete');
  },
});
