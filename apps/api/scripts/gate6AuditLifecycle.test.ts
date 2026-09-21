import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESS_READY_MARKER } from './harnessReadyMarker.js';
import { spawnLifecycleHarness } from './lifecycleHarnessSpawn.js';

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

const HARNESS = fileURLToPath(new URL('./gate6AuditHarness.ts', import.meta.url));

describe('gate6Audit lifecycle (child process — a hung RTDB read cannot hang the gate)', () => {
  it('SUCCESS: an audit against a reachable database settles and exits well before the deadline', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'success',
      hardExitMs: 5_000,
    });
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
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'request-timeout',
      hardExitMs: 5_000,
    });
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
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'stall',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/\[watchdog\] no progress for \d+ms/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(6_500);
  });

  it('INTERRUPTION: SIGINT terminates an audit stuck on an unresponsive database, exit 130', async () => {
    const { child, outcome, waitFor } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'interrupt',
      hardExitMs: 5_000,
    });
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
