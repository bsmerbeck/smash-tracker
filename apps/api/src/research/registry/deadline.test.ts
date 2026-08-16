import { describe, expect, it } from 'vitest';
import {
  RegistryOperationAbortedError,
  RegistryOperationTimeoutError,
  withRegistryDeadline,
} from './deadline.js';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('withRegistryDeadline', () => {
  it('passes a resolved value straight through', async () => {
    await expect(
      withRegistryDeadline('read', async () => 7, { requestTimeoutMs: 500 }),
    ).resolves.toBe(7);
  });

  it('propagates the operation error unchanged', async () => {
    await expect(
      withRegistryDeadline('read', () => Promise.reject(new Error('connect ECONNREFUSED')), {
        requestTimeoutMs: 500,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('rejects a hung operation at the request timeout, naming the operation', async () => {
    const startedAt = Date.now();
    await expect(
      withRegistryDeadline('read tournamentEntries/u', never, { requestTimeoutMs: 60 }),
    ).rejects.toBeInstanceOf(RegistryOperationTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('rejects when the shutdown signal fires mid-flight', async () => {
    const controller = new AbortController();
    const pending = withRegistryDeadline('read', never, { signal: controller.signal });
    controller.abort(new Error('terminated by SIGINT'));
    await expect(pending).rejects.toBeInstanceOf(RegistryOperationAbortedError);
    await expect(pending).rejects.toThrow(/terminated by SIGINT/);
  });

  it('refuses to even START an operation once the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('watchdog'));
    let started = false;
    await expect(
      withRegistryDeadline(
        'read',
        async () => {
          started = true;
          return 1;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(RegistryOperationAbortedError);
    expect(started).toBe(false);
  });

  it('imposes no timeout when the bound is omitted or zero', async () => {
    await expect(withRegistryDeadline('read', async () => 'ok')).resolves.toBe('ok');
    await expect(
      withRegistryDeadline('read', async () => 'ok', { requestTimeoutMs: 0 }),
    ).resolves.toBe('ok');
  });

  it('does not surface a late operation rejection as an unhandled rejection', async () => {
    // The losing side of the race still rejects, moments after the deadline.
    let rejectLate: ((error: Error) => void) | null = null;
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    await expect(
      withRegistryDeadline('read', () => late, { requestTimeoutMs: 30 }),
    ).rejects.toBeInstanceOf(RegistryOperationTimeoutError);
    rejectLate!(new Error('late network failure'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
