import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard test locking in the fix for the flaky `INTERRUPTION: SIGINT ...
 * cleanup-complete` failures (quick 260920-tns, D-7): the four child-process
 * lifecycle test files must spawn the harness through ONE shared helper that
 * puts the signal on the harness process itself, never through the tsx CLI
 * shim (which relays signals to a grandchild on a 30 ms acknowledgement
 * budget before escalating to SIGKILL — see 260920-tns-CONTEXT.md).
 *
 * This is a content-read grep gate, mirroring
 * `apps/api/src/prep/phase13Integrity.test.ts`: every assertion below must be
 * independently falsifiable, and this whole file must be runnable — and
 * fail, for the expected reasons — against the pre-fix tree.
 */

const SCRIPTS_DIR = fileURLToPath(new URL('./', import.meta.url));
const HELPER_PATH = fileURLToPath(new URL('./lifecycleHarnessSpawn.ts', import.meta.url));

// Reading the helper source unguarded would throw at module load and hide
// every other assertion behind one ENOENT — the RED run must show each
// assertion failing for its own reason.
const helperSource = existsSync(HELPER_PATH) ? readFileSync(HELPER_PATH, 'utf-8') : '';

// This file's own name does not end in `Lifecycle.test.ts`, so the scan
// never picks up itself.
const lifecycleTestFiles = readdirSync(SCRIPTS_DIR)
  .filter((name) => name.endsWith('Lifecycle.test.ts'))
  .sort();

describe('lifecycle harness spawn guard (260920-tns D-7)', () => {
  it('the shared helper module exists and reads non-empty', () => {
    expect(helperSource.length).toBeGreaterThan(0);
  });

  it('the directory scan finds all four known lifecycle test files by name', () => {
    expect(lifecycleTestFiles).toContain('deriveTournamentRegistryLifecycle.test.ts');
    expect(lifecycleTestFiles).toContain('acctTopologyAuditLifecycle.test.ts');
    expect(lifecycleTestFiles).toContain('gate6AuditLifecycle.test.ts');
    expect(lifecycleTestFiles).toContain('enrichLifecycle.test.ts');
    expect(lifecycleTestFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('the helper spawns the Node binary directly, never the tsx executable shim', () => {
    expect(helperSource).toContain('process.execPath');
    expect(helperSource).toMatch(/'--import',\s*'tsx'/);
    expect(helperSource).not.toContain('node_modules/.bin');
  });

  it('the helper pins the child cwd and resolves its outcome on the stdio close event', () => {
    expect(helperSource).toContain('cwd:');
    expect(helperSource).toMatch(/child\.on\('close'/);
  });

  it.each(lifecycleTestFiles)(
    '%s calls the shared helper, not a local CLI-relay spawn',
    (fileName) => {
      const source = readFileSync(`${SCRIPTS_DIR}${fileName}`, 'utf-8');
      expect(source.length).toBeGreaterThan(0);
      expect(source).not.toContain('.bin/tsx');
      expect(source).not.toMatch(/once\(\s*child,\s*'exit'\s*\)/);
      expect(source).toContain('spawnLifecycleHarness');
    },
  );

  it('a harness spawned through the helper puts the signal on the harness process itself', async () => {
    // Imported lazily so a missing module fails only this one test in the
    // RED run, rather than every test in the file via a module-scope throw.
    const { spawnLifecycleHarness } = await import('./lifecycleHarnessSpawn.js');
    const harness = fileURLToPath(new URL('./enrichLifecycleHarness.ts', import.meta.url));
    const { child, outcome } = spawnLifecycleHarness({
      harness,
      mode: 'success',
      hardExitMs: 5_000,
    });
    expect(child.spawnfile).toBe(process.execPath);
    expect(child.spawnargs).toContain('--import');
    const result = await outcome;
    expect(result.code).toBe(0);
    expect(result.output).toContain('cleanup-complete');
    expect(result.stdout).toContain('cleanup-complete');
  });
});
