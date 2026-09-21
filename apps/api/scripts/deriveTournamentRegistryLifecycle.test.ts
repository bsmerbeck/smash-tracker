import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESS_READY_MARKER } from './harnessReadyMarker.js';
import { spawnLifecycleHarness } from './lifecycleHarnessSpawn.js';

/**
 * Phase 30.3 registry-operator hardening: the TERMINATION MATRIX for
 * `deriveTournamentRegistry.ts`.
 *
 * The enrichment operator earned its lifecycle hardening from a production
 * defect — an open firebase-admin RTDB connection kept the process alive 80+
 * minutes after it had already failed. The registry operator now composes
 * the same `runWithLifecycle` wrapper, and these CHILD-PROCESS tests are the
 * proof for THIS operator specifically: a spawned run that holds an
 * artificial open handle still exits, with the right code, within the bound,
 * after every terminal condition the owner directive names —
 *
 *   success · schema failure · network failure · timeout (stall) ·
 *   per-request timeout · interruption (SIGINT) · hung shutdown
 *
 * No Firebase, no emulator, no network: the harness injects a
 * `FakeDatabase` or a deliberately broken stand-in. See
 * `deriveTournamentRegistryHarness.ts`.
 */

const HARNESS = fileURLToPath(new URL('./deriveTournamentRegistryHarness.ts', import.meta.url));

describe('deriveTournamentRegistry lifecycle (child process — no open handles survive)', () => {
  it('SUCCESS: a completed dry-run exits 0 naturally, well before the hard-exit deadline', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'success',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(0);
    expect(result.output).toContain('operator-settled 0');
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(4_500);
  });

  it('SCHEMA FAILURE: an invalid manifest exits 1 after cleanup, within the bound', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'schema-failure',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toContain('cleanup-complete');
    expect(result.output).toMatch(/formatVersion|Unrecognized key/);
    expect(result.elapsedMs).toBeLessThan(4_500);
  });

  it('NETWORK FAILURE: an unreachable database exits 1 with a receipt, within the bound', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'network-failure',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toContain('ECONNREFUSED');
    expect(result.output).toMatch(/\[receipt\] hbox: status=failed/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(4_500);
  });

  it('TIMEOUT (stall): the no-progress watchdog aborts a hung run and exits 1', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'stall',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/\[watchdog\] no progress for \d+ms/);
    // The heartbeat kept reporting while nothing progressed — the operator
    // was never silent about being stuck.
    expect(result.output).toMatch(/\[heartbeat\] account=hbox stage=read-source/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(6_500);
  });

  it('REQUEST TIMEOUT: a hung RTDB read is cut off at --request-timeout-ms and exits 1', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'request-timeout',
      hardExitMs: 5_000,
    });
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/exceeded its 600ms request timeout/);
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(6_500);
  });

  it('INTERRUPTION: SIGINT terminates a run stuck on an unresponsive database, exit 130', async () => {
    const { child, outcome, waitFor } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'interrupt',
      hardExitMs: 5_000,
    });
    // Wait for the child's OWN statement that it has reached the hung read —
    // never a fixed sleep. See `SpawnedHarness.waitFor`.
    await waitFor(HARNESS_READY_MARKER);
    child.kill('SIGINT');
    const result = await outcome;
    expect(result.code).toBe(130);
    expect(result.output).toContain('received SIGINT');
    expect(result.output).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(12_000);
  });

  it('HARD-EXIT BACKSTOP: a shutdown that never releases its handle is force-exited at the deadline', async () => {
    const { outcome } = spawnLifecycleHarness({
      harness: HARNESS,
      mode: 'hang-cleanup',
      hardExitMs: 1_500,
    });
    const result = await outcome;
    // A successful run whose cleanup leaked the handle: the process outlived
    // its natural-exit chance and the unref'd backstop killed it on time,
    // carrying the run's own exit code. This is the anti-zombie guarantee.
    expect(result.code).toBe(0);
    expect(result.output).toContain('operator-settled 0');
    expect(result.output).toContain('forcing exit');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(result.elapsedMs).toBeLessThan(10_000);
  });
});
