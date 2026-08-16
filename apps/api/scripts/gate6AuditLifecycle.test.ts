import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESS_READY_MARKER } from './harnessReadyMarker.js';

/**
 * Owner/Codex hard gate #4 (B6): PROMPT TERMINATION for `gate6Audit.ts`.
 *
 * The defect: the audit had no per-request deadline, no heartbeat, no
 * no-progress watchdog and no abort handling, and `runWithLifecycle` arms its
 * hard-exit backstop only AFTER the run settles. One hung RTDB read therefore
 * hung the gate forever — silently, with the process looking alive. The
 * backstop could not help, because it was waiting on a result that would never
 * arrive.
 *
 * These are child-process tests for exactly that: a spawned audit that holds an
 * artificial open handle and whose database never answers must still reach a
 * terminal result and exit, by each of the three bounds independently
 * (per-request deadline, stall watchdog, SIGINT). No Firebase, no emulator, no
 * network — see `gate6AuditHarness.ts`.
 */

const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const HARNESS = fileURLToPath(new URL('./gate6AuditHarness.ts', import.meta.url));

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  elapsedMs: number;
}

interface SpawnedHarness {
  child: ChildProcess;
  outcome: Promise<ChildOutcome>;
  /** Resolves when the child prints `marker`; rejects if it exits first. See B10. */
  waitFor: (marker: string) => Promise<void>;
}

function spawnHarness(mode: string, hardExitMs: number): SpawnedHarness {
  const startedAt = Date.now();
  let output = '';
  const listeners = new Set<() => void>();
  const child = execFile(TSX_BIN, [HARNESS, mode, String(hardExitMs)], {
    // A hard ceiling well past every assertion bound, so a regression fails
    // the test rather than hanging the suite.
    timeout: 25_000,
  });
  const collect = (chunk: string | Buffer): void => {
    output += String(chunk);
    for (const notify of listeners) {
      notify();
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const outcome = once(child, 'exit').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    output,
    elapsedMs: Date.now() - startedAt,
  }));

  const waitFor = (marker: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (output.includes(marker)) {
          listeners.delete(check);
          resolve();
        }
      };
      listeners.add(check);
      void outcome.then((result) => {
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
      });
      check();
    });

  return { child, outcome, waitFor };
}

describe('gate6Audit lifecycle (child process — a hung RTDB read cannot hang the gate)', () => {
  it('SUCCESS: an audit against a reachable database settles and exits well before the deadline', async () => {
    const { outcome } = spawnHarness('success', 5_000);
    const result = await outcome;
    // The empty fixture cannot satisfy the expectation table, so the ORACLE
    // fails — which is the correct verdict and, for this test, proof that the
    // audit ran to a terminal result rather than hanging.
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/audit-settled 1 findings=\d+/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(4_500);
  });

  it('REQUEST TIMEOUT: a hung RTDB read is cut off at the per-operation deadline and exits 1', async () => {
    const { outcome } = spawnHarness('request-timeout', 5_000);
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/exceeded its 600ms request timeout/);
    // The heartbeat kept reporting while nothing progressed — the audit was
    // never silent about being stuck.
    expect(result.output).toMatch(/\[heartbeat\] gate6 reads=\d+/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(6_500);
  });

  it('STALL: the no-progress watchdog aborts an audit whose reads never answer', async () => {
    const { outcome } = spawnHarness('stall', 5_000);
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/\[watchdog\] no progress for \d+ms/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(6_500);
  });

  it('INTERRUPTION: SIGINT terminates an audit stuck on an unresponsive database, exit 130', async () => {
    const { child, outcome, waitFor } = spawnHarness('interrupt', 5_000);
    // Wait for the child's OWN statement that it has reached the hung read —
    // never a fixed sleep (B10).
    await waitFor(HARNESS_READY_MARKER);
    child.kill('SIGINT');
    const result = await outcome;
    expect(result.code).toBe(130);
    expect(result.output).toContain('received SIGINT');
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(12_000);
  });
});
