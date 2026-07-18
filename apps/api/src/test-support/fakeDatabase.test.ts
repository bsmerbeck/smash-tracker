import { describe, expect, it, vi } from 'vitest';
import { FakeDatabase } from './fakeDatabase.js';

/**
 * Review CR-01: `FakeDatabase.transaction` must emulate real RTDB's
 * null-local-cache first run. A listener-less server process's SDK cache is
 * ALWAYS empty, so the update function's first invocation receives `null`
 * even when server data exists — and returning `undefined` at that point
 * aborts PERMANENTLY (there is no retry with server data). The previous
 * fake ran the update function directly against the in-memory tree, which
 * let update functions that abort on a null node pass every test while
 * 404ing on every call in production.
 */
describe('FakeDatabase.transaction — null-local-cache first-run emulation', () => {
  it('invokes the update function with null FIRST even when data exists, then retries with the real value', async () => {
    const database = new FakeDatabase();
    database.seed('node', { a: 1 });

    const runs: unknown[] = [];
    const result = await database.ref('node').transaction((current) => {
      runs.push(current);
      if (current === null) {
        return current; // force the server-verified retry
      }
      return { ...(current as Record<string, unknown>), b: 2 };
    });

    expect(runs).toEqual([null, { a: 1 }]);
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toEqual({ a: 1, b: 2 });
    expect(database.dump().node).toEqual({ a: 1, b: 2 });
  });

  it('REGRESSION: returning undefined on the null first run aborts permanently — NO retry with server data', async () => {
    const database = new FakeDatabase();
    database.seed('node', { a: 1 });

    const updateFn = vi.fn((current: unknown) => {
      // The buggy pattern CR-01 flagged: "nothing here locally" -> abort.
      if (current === null) {
        return undefined;
      }
      return { touched: true };
    });
    const result = await database.ref('node').transaction(updateFn);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(result.committed).toBe(false);
    // The stored data is untouched — the abort never saw it.
    expect(database.dump().node).toEqual({ a: 1 });
  });

  it('commits the first run directly when the node is truly empty (local null matches server null)', async () => {
    const database = new FakeDatabase();

    const updateFn = vi.fn((current: unknown) => (current === null ? { seeded: true } : current));
    const result = await database.ref('node').transaction(updateFn);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(result.committed).toBe(true);
    expect(database.dump().node).toEqual({ seeded: true });
  });

  it('aborts (committed: false) when the RETRY run returns undefined', async () => {
    const database = new FakeDatabase();
    database.seed('node', 'existing');

    const result = await database.ref('node').transaction((current) => {
      if (current === null) {
        return current;
      }
      return undefined; // verified against real data -> abort
    });

    expect(result.committed).toBe(false);
    expect(database.dump().node).toBe('existing');
  });
});
