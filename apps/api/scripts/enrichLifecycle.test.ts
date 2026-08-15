import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runWithLifecycle } from './enrichLifecycle.js';

/**
 * 30.2 reliability gate: proves the guaranteed-termination contract — the
 * zombie-process defect class (an open handle keeping the event loop alive
 * after a terminal result) can no longer occur. In-process tests cover the
 * wrapper's state machine; CHILD-PROCESS tests prove the real thing: a
 * spawned run with an artificial open handle exits, with the right code,
 * within the bound — successful, injected-failure, hung-cleanup, and
 * signal-interrupted runs alike. No Firebase, no emulator, no network.
 */

const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const HARNESS = fileURLToPath(new URL('./enrichLifecycleHarness.ts', import.meta.url));

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function spawnHarness(
  mode: string,
  hardExitMs: number,
): { child: ChildProcess; outcome: Promise<ChildOutcome> } {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  const child = execFile(TSX_BIN, [HARNESS, mode, String(hardExitMs)], {
    // A hard ceiling well past every assertion bound, so a regression fails
    // the test rather than hanging the suite.
    timeout: 20_000,
  });
  child.stdout?.on('data', (chunk: string | Buffer) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderr += String(chunk);
  });
  const outcome = once(child, 'exit').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stdout,
    stderr,
    elapsedMs: Date.now() - startedAt,
  }));
  return { child, outcome };
}

describe('runWithLifecycle (in-process)', () => {
  interface FakeProc {
    exitCode: number | undefined;
    exited: number[];
    handlers: Map<string, () => void>;
  }

  function makeFakeProcess(): FakeProc & Pick<NodeJS.Process, 'exitCode' | 'exit' | 'on' | 'off'> {
    const fake = {
      exitCode: undefined as number | undefined,
      exited: [] as number[],
      handlers: new Map<string, () => void>(),
      exit: ((code?: number) => {
        fake.exited.push(code ?? 0);
      }) as never,
      on: ((event: string, handler: () => void) => {
        fake.handlers.set(event, handler);
        return fake;
      }) as never,
      off: ((event: string) => {
        fake.handlers.delete(event);
        return fake;
      }) as never,
    };
    return fake as never;
  }

  it('runs cleanup and returns the run exit code on success', async () => {
    const proc = makeFakeProcess();
    const order: string[] = [];
    const code = await runWithLifecycle({
      run: async () => {
        order.push('run');
        return 0;
      },
      cleanup: async () => {
        order.push('cleanup');
      },
      hardExitMs: 50,
      log: () => undefined,
      processHandle: proc,
    });
    expect(code).toBe(0);
    expect(order).toEqual(['run', 'cleanup']);
    expect(proc.exitCode).toBe(0);
  });

  it('runs cleanup and returns 1 when the run rejects', async () => {
    const proc = makeFakeProcess();
    let cleaned = false;
    const logged: string[] = [];
    const code = await runWithLifecycle({
      run: async () => {
        throw new Error('operator failure');
      },
      cleanup: async () => {
        cleaned = true;
      },
      hardExitMs: 50,
      log: (line) => logged.push(line),
      processHandle: proc,
    });
    expect(code).toBe(1);
    expect(cleaned).toBe(true);
    expect(logged.join('\n')).toContain('operator failure');
  });

  it('a termination signal interrupts a run that ignores its AbortSignal, still running cleanup', async () => {
    const proc = makeFakeProcess();
    let cleaned = false;
    const lifecycle = runWithLifecycle({
      run: () => new Promise<number>(() => undefined),
      cleanup: async () => {
        cleaned = true;
      },
      hardExitMs: 50,
      log: () => undefined,
      processHandle: proc,
    });
    proc.handlers.get('SIGINT')!();
    const code = await lifecycle;
    expect(code).toBe(130);
    expect(cleaned).toBe(true);
  });

  it('a failing cleanup turns a successful run into exit code 1', async () => {
    const proc = makeFakeProcess();
    const code = await runWithLifecycle({
      run: async () => 0,
      cleanup: async () => {
        throw new Error('cleanup failure');
      },
      hardExitMs: 50,
      log: () => undefined,
      processHandle: proc,
    });
    expect(code).toBe(1);
  });
});

describe('runWithLifecycle (child process — no open handles survive)', () => {
  it('a successful run with an open handle exits 0 naturally, well before the hard-exit deadline', async () => {
    const { outcome } = spawnHarness('success', 5_000);
    const result = await outcome;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('run-settled');
    expect(result.stdout).toContain('cleanup-complete');
    // Natural exit: the cleanup released the handle, so the process did not
    // need the 5s backstop. Generous bound for tsx startup.
    expect(result.elapsedMs).toBeLessThan(4_500);
  });

  it('an injected-failure run exits 1 naturally within the bound', async () => {
    const { outcome } = spawnHarness('failure', 5_000);
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(4_500);
  });

  it('a cleanup that never releases its handle is force-exited by the backstop at the deadline', async () => {
    const { outcome } = spawnHarness('hang-cleanup', 1_500);
    const result = await outcome;
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('cleanup-complete');
    expect(result.stderr + result.stdout).toContain('forcing exit');
    // The process outlived its natural-exit chance (the handle stayed open)
    // and was killed by the 1.5s backstop — proving the exit-within-bound
    // guarantee holds even when shutdown itself misbehaves.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it('SIGINT terminates a run that ignores its signal, with cleanup and exit code 130, within the bound', async () => {
    const { child, outcome } = spawnHarness('wait-signal', 5_000);
    // Give tsx time to boot the harness before signalling.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    child.kill('SIGINT');
    const result = await outcome;
    expect(result.code).toBe(130);
    expect(result.stdout).toContain('cleanup-complete');
    expect(result.elapsedMs).toBeLessThan(12_000);
  });
});
