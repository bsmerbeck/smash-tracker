import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESS_READY_MARKER } from './harnessReadyMarker.js';
import { spawnLifecycleHarness } from './lifecycleHarnessSpawn.js';

/**
 * Codex hard gate at `fb9a3930` (P1): PROMPT TERMINATION for
 * `acctTopologyAudit.ts`.
 *
 * The defect: the first revision issued sequential RTDB `.get()` calls with no
 * request deadline, no heartbeat, no watchdog, no signal handling and no
 * hard-exit backstop, and only called `goOffline()` after every read resolved.
 * One stalled read hung it forever — the failure class that left
 * `enrichDemoAccounts.ts` looking alive 80+ minutes after death.
 *
 * These are child-process tests for exactly that: a spawned audit holding an
 * artificial open handle, whose database never answers, must still reach a
 * terminal result and exit — by each bound independently (per-read deadline,
 * stall watchdog, SIGINT) — plus the success, failure and thrown-read paths.
 * No Firebase, no emulator, no network — see `acctTopologyAuditHarness.ts`.
 */

const HARNESS = fileURLToPath(new URL('./acctTopologyAuditHarness.ts', import.meta.url));

describe('acctTopologyAudit lifecycle (child process — a hung RTDB read cannot hang the audit)', () => {
  it('SUCCESS: a clean corpus (all four sources archived) settles and exits 0', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'success',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/audit-settled findings=0 ok=true/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it('FINDING: a still-visible source tenant exits 1 promptly, cleanup still runs', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'finding',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/audit-settled findings=1 ok=false/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it('THROWN READ: a rejecting read exits 1 and still runs cleanup', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'throw',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toContain('harness: simulated read failure');
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it('REQUEST TIMEOUT: a hung read is cut off at the per-read deadline and exits 1', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'request-timeout',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/600ms request timeout/);
    // The heartbeat kept reporting while nothing progressed — never silent.
    expect(result.output).toMatch(/\[heartbeat\] acct-topology reads=\d+/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(10_000);
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
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it('INTERRUPTION: SIGINT terminates an audit stuck on an unresponsive database, exit 130', async () => {
    const { child, outcome, waitFor } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'interrupt',
      hardExitMs: 5_000,
    });
    // Wait for the child's OWN statement that it reached the hung read — never
    // a fixed sleep.
    await waitFor(HARNESS_READY_MARKER);
    child.kill('SIGINT');
    const result = await outcome;
    expect(result.code).toBe(130);
    expect(result.output).toContain('received SIGINT');
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(15_000);
  });
});
