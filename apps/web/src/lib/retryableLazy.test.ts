import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_STAMP_KEY, RELOAD_COOLDOWN_MS, loadWithRetry } from './retryableLazy';

/**
 * jsdom has a real sessionStorage; each test starts with no reload stamp so
 * the cooldown-gated reload budget is deterministic.
 */
beforeEach(() => {
  window.sessionStorage.removeItem(CHUNK_RELOAD_STAMP_KEY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadWithRetry', () => {
  it('resolves on first success without touching the reload stamp', async () => {
    const reload = vi.fn();
    const result = await loadWithRetry(() => Promise.resolve('module'), { reload });
    expect(result).toBe('module');
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STAMP_KEY)).toBeNull();
  });

  it('retries a rejected factory and resolves on a later attempt', async () => {
    const reload = vi.fn();
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('net down'))
      .mockResolvedValueOnce('recovered');
    const result = await loadWithRetry(factory, { reload, backoffBaseMs: 1 });
    expect(result).toBe('recovered');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('abandons a hung attempt after the per-attempt timeout and retries', async () => {
    const reload = vi.fn();
    const factory = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValueOnce('after hang');
    const result = await loadWithRetry(factory, {
      reload,
      timeoutMs: 20,
      backoffBaseMs: 1,
    });
    expect(result).toBe('after hang');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reloads and stamps the cooldown when every attempt fails, then never resolves', async () => {
    const reload = vi.fn();
    const factory = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('chunk 404'));
    const pending = loadWithRetry(factory, {
      reload,
      maxRetries: 1,
      backoffBaseMs: 1,
    });
    // The promise intentionally never settles while the page reloads — race
    // it against a short timer instead of awaiting it.
    const raced = await Promise.race([
      pending.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 50)),
    ]);
    expect(raced).toBe('still pending');
    expect(reload).toHaveBeenCalledTimes(1);
    const stamp = Number(window.sessionStorage.getItem(CHUNK_RELOAD_STAMP_KEY));
    expect(stamp).toBeGreaterThan(0);
  });

  it('throws instead of reloading while the cooldown from a recent reload is active', async () => {
    // Regression lock for the review-confirmed infinite-reload loop: a
    // boot-time "clear the flag" re-armed a boolean guard on every cycle.
    // The stamp survives the reload and stays authoritative for the
    // cooldown window regardless of any later successful loads.
    window.sessionStorage.setItem(CHUNK_RELOAD_STAMP_KEY, String(Date.now() - 1_000));
    const reload = vi.fn();
    const factory = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('chunk 404'));
    await expect(
      loadWithRetry(factory, { reload, maxRetries: 1, backoffBaseMs: 1 }),
    ).rejects.toThrow('chunk 404');
    expect(reload).not.toHaveBeenCalled();
  });

  it('allows another recovery reload once the cooldown has expired', async () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_STAMP_KEY,
      String(Date.now() - RELOAD_COOLDOWN_MS - 1_000),
    );
    const reload = vi.fn();
    const factory = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('chunk 404'));
    const pending = loadWithRetry(factory, { reload, maxRetries: 0 });
    await Promise.race([
      pending.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a successful load does not erase an active cooldown stamp', async () => {
    // The stamp must outlive interleaved successes: MainLayout loading fine
    // right before a broken page chunk fails is exactly the sequence that
    // defeated the old clear-on-success boolean.
    const stamp = String(Date.now() - 1_000);
    window.sessionStorage.setItem(CHUNK_RELOAD_STAMP_KEY, stamp);
    await loadWithRetry(() => Promise.resolve('ok'), { reload: vi.fn() });
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STAMP_KEY)).toBe(stamp);
  });
});
