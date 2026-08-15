/**
 * 30.2 reliability gate (owner corrective directive, Gate 1): the guaranteed-
 * termination wrapper for the enrichment operator. The production defect
 * this closes: `enrichDemoAccounts.ts` printed its error, set
 * `process.exitCode` — and then sat forever, because the open firebase-admin
 * RTDB connection kept the event loop alive; the process looked "running"
 * 80+ minutes after death.
 *
 * The wrapper guarantees, structurally:
 * - `cleanup` (the Firebase lifecycle: `database.goOffline()` + awaited
 *   `app.delete()`) runs in a `finally`, on success, on error, and on
 *   SIGINT/SIGTERM.
 * - a signal ALWAYS interrupts the run — the run promise is raced against
 *   the abort, so a run that ignores its `AbortSignal` still cannot block
 *   shutdown.
 * - the process exits within `hardExitMs` (default 10s) of a terminal
 *   result or interruption: an UNREF'd backstop timer is armed the moment
 *   the run settles; a drained event loop exits naturally first, and a
 *   loop something is still holding open is force-exited when the timer
 *   fires.
 *
 * Pure of Firebase and of the operator itself — everything is injected, so
 * a child-process harness can drive it with fake work and fake handles.
 */

export interface RunWithLifecycleOptions {
  /** The operator body. Receives the shutdown signal; SHOULD honour it, but termination does not depend on it doing so. Resolves to the process exit code. */
  run: (signal: AbortSignal) => Promise<number>;
  /** Closes external connections. Always invoked exactly once, success or failure or signal. A hang here is covered by the hard-exit backstop. */
  cleanup: () => Promise<void>;
  /** Hard-exit deadline after a terminal result or interruption. Default 10_000. */
  hardExitMs?: number;
  log?: (line: string) => void;
  /** Injected for tests; defaults to the real `process`. */
  processHandle?: Pick<NodeJS.Process, 'exitCode' | 'exit' | 'on' | 'off'>;
}

export const DEFAULT_HARD_EXIT_MS = 10_000;

const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Resolves the exit code the process should carry; never throws. */
export async function runWithLifecycle(options: RunWithLifecycleOptions): Promise<number> {
  const proc = options.processHandle ?? process;
  const hardExitMs = options.hardExitMs ?? DEFAULT_HARD_EXIT_MS;
  const log = options.log ?? ((line: string) => console.error(line));

  const controller = new AbortController();
  let exitCode = 0;

  // A signal must interrupt the run even when the run never checks its
  // signal — this promise loses the race below the moment abort fires.
  let onAborted: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAborted = () => reject(new Error('interrupted by termination signal'));
  });

  const signalHandlers = TERMINATION_SIGNALS.map((signalName) => {
    const handler = () => {
      log(`received ${signalName}; aborting work and shutting down`);
      exitCode = 130;
      controller.abort(new Error(`terminated by ${signalName}`));
      onAborted?.();
    };
    proc.on(signalName, handler);
    return { signalName, handler };
  });

  try {
    exitCode = await Promise.race([options.run(controller.signal), aborted]);
  } catch (error) {
    if (exitCode === 0) {
      exitCode = 1;
    }
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    for (const { signalName, handler } of signalHandlers) {
      proc.off(signalName, handler);
    }

    // The backstop: armed BEFORE cleanup is awaited, unref'd so a cleanly
    // drained loop exits naturally first. If cleanup (or any stray handle)
    // keeps the loop alive past the deadline, this fires and the process
    // exits with the recorded code — the exit-within-10s guarantee.
    const hardExit = setTimeout(() => {
      log(
        `shutdown did not release the event loop within ${hardExitMs}ms of the terminal result; forcing exit ${exitCode}`,
      );
      proc.exit(exitCode);
    }, hardExitMs);
    hardExit.unref();

    try {
      await options.cleanup();
    } catch (cleanupError) {
      log(
        `cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
      if (exitCode === 0) {
        exitCode = 1;
      }
    }
  }

  proc.exitCode = exitCode;
  return exitCode;
}
