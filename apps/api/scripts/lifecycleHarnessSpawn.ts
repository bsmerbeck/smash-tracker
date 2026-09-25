import { execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The SHARED SPAWN HELPER for every child-process lifecycle test (quick
 * 260920-tns). Same reasoning as `harnessReadyMarker.ts`: a module the tests
 * can import without starting anything, so a single fix location replaces
 * four copy-pasted spawn functions.
 *
 * WHY THIS EXISTS. The lifecycle tests used to run each harness through the
 * tsx command-line launcher rather than executing the harness script
 * directly. That launcher does not run the target script itself — it spawns
 * a separate child process and, on receiving a signal, waits a short
 * acknowledgement window for that child to confirm it received the relayed
 * signal before escalating to a forceful kill. Under load, that window can
 * lapse before the harness has even been scheduled, so the harness gets
 * force-killed mid-shutdown — before it can print its own completion
 * marker — while the launcher itself still reports the expected signal exit
 * code. That is why the exit-code assertion passed while only the
 * completion-marker assertion caught the flake: the interruption tests were
 * proving the launcher's relay behaved correctly, not the harness's own
 * shutdown path. Spawning the harness directly puts the signal where the
 * test actually means to put it — on the harness process itself.
 */

/** The `apps/api` package root. Pinning `cwd` here (matching where vitest
 * already runs) is what lets the bare `tsx` loader specifier below resolve
 * without needing an absolute filesystem path to a locally installed
 * executable. */
const API_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** A hard ceiling well past every assertion bound in any lifecycle test, so
 * a regression fails the test rather than hanging the suite. */
const DEFAULT_CEILING_MS = 25_000;

export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export interface SpawnedHarness {
  child: ChildProcess;
  outcome: Promise<ChildOutcome>;
  /**
   * Resolves when the child has printed `marker`, rejects if it exits first.
   *
   * This replaces the fixed sleep the interruption tests used to race against
   * child startup with. A sleep encodes a GUESS about how long the harness
   * needs to compile and boot; that guess is wrong exactly when the machine
   * is busy — i.e. when the file runs inside the full targeted group rather
   * than alone — and the failure mode is a SIGINT delivered before the
   * lifecycle handlers exist. Waiting for the child's own readiness statement
   * removes the guess instead of padding it, which is why the fix is not
   * "raise the timeout".
   */
  waitFor: (marker: string) => Promise<void>;
}

export interface SpawnLifecycleHarnessOptions {
  harness: string;
  mode: string;
  hardExitMs: number;
  ceilingMs?: number;
}

export function spawnLifecycleHarness({
  harness,
  mode,
  hardExitMs,
  ceilingMs = DEFAULT_CEILING_MS,
}: SpawnLifecycleHarnessOptions): SpawnedHarness {
  const startedAt = Date.now();
  let output = '';
  let stdout = '';
  let stderr = '';
  const listeners = new Set<() => void>();

  const child = execFile(process.execPath, ['--import', 'tsx', harness, mode, String(hardExitMs)], {
    cwd: API_ROOT,
    timeout: ceilingMs,
  });

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  child.stdout?.on('data', (chunk: string | Buffer) => {
    const text = String(chunk);
    stdout += text;
    output += text;
    notify();
  });
  child.stderr?.on('data', (chunk: string | Buffer) => {
    const text = String(chunk);
    stderr += text;
    output += text;
    notify();
  });

  interface ExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
    elapsedMs: number;
  }
  let exitInfo: ExitInfo | undefined;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, elapsedMs: Date.now() - startedAt };
  });

  const outcome = new Promise<ChildOutcome>((resolve, reject) => {
    child.on('close', (code, signal) => {
      const settled = exitInfo ?? { code, signal, elapsedMs: Date.now() - startedAt };
      resolve({ ...settled, output, stdout, stderr });
    });
    child.on('error', reject);
  });

  const waitFor = (marker: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (output.includes(marker)) {
          listeners.delete(check);
          resolve();
        }
      };
      listeners.add(check);
      // A child that dies before announcing itself must fail the wait rather
      // than hang it until the suite timeout.
      outcome.then(
        (result) => {
          listeners.delete(check);
          if (result.output.includes(marker)) {
            resolve();
            return;
          }
          reject(
            new Error(
              `child exited (code ${result.code}, signal ${result.signal}) before printing "${marker}"\n${result.output}`,
            ),
          );
        },
        (error: unknown) => {
          listeners.delete(check);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
      check();
    });

  return { child, outcome, waitFor };
}
