import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  LIQUIPEDIA_GENERAL_BUDGET_PATH,
  LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
  LIQUIPEDIA_PARSE_BUDGET_PATH,
  LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS,
  createLiquipediaLimiter,
} from './limiter.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeClock(startMs: number) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/**
 * A `sleep` that advances the clock it is paired with and resolves
 * immediately — this is the mechanism (per ENR-01 / the plan's `<behavior>`)
 * that lets a suite proving 60+ virtual seconds of enforced spacing finish
 * in well under two REAL seconds. No `setTimeout` anywhere in this file.
 */
function pairedSleep(clock: ReturnType<typeof makeClock>) {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
    clock.advance(ms);
  };
  return { sleep, calls };
}

describe('createLiquipediaLimiter', () => {
  it('advances the injected clock by at least 4000ms total across three consecutive general acquisitions', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const startMs = clock.now();
    for (let i = 0; i < 3; i += 1) {
      const result = await limiter.acquire('general', 60_000);
      expect(result.granted).toBe(true);
    }
    expect(clock.now() - startMs).toBeGreaterThanOrEqual(4000);
  });

  it('advances the injected clock by at least 30000ms across two consecutive parse-class acquisitions', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const startMs = clock.now();
    const first = await limiter.acquire('parse-class', 60_000);
    const second = await limiter.acquire('parse-class', 60_000);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(clock.now() - startMs).toBeGreaterThanOrEqual(30_000);
  });

  it('a parse-class acquisition consumes BOTH budgets, so an immediate general acquisition still waits the general interval', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    await limiter.acquire('parse-class', 60_000);
    const startMs = clock.now();
    const generalResult = await limiter.acquire('general', 10_000);
    expect(generalResult.granted).toBe(true);
    // The parse-class acquisition already stamped the general budget, so the
    // very next general acquisition must still wait ~2000ms.
    expect(clock.now() - startMs).toBeGreaterThanOrEqual(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
  });

  it('two independently constructed limiter instances sharing one database still honour the interval between them', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const limiterA = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });
    const limiterB = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const first = await limiterA.acquire('general', 60_000);
    const startMs = clock.now();
    const second = await limiterB.acquire('general', 60_000);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    // The interval is enforced on the SHARED durable node, not per-instance
    // in-process state — this is the whole point of ENR-01's durable budget.
    expect(clock.now() - startMs).toBeGreaterThanOrEqual(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
  });

  it('invokes the transaction update function with null on its first run and still commits (FakeDatabase parity)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now });

    const result = await limiter.acquire('general', 10_000);
    expect(result.granted).toBe(true);

    const stored = database.dump().researchRateBudget as { liquipedia?: unknown };
    expect(stored?.liquipedia).toBeDefined();
  });

  it('returns a non-granted result rather than sleeping past the caller-supplied remaining wait budget', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep, calls } = pairedSleep(clock);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    await limiter.acquire('parse-class', 60_000);
    // Budget far too small for the ~30000ms residual wait.
    const result = await limiter.acquire('parse-class', 10);
    expect(result.granted).toBe(false);
    expect(result.waitedMs).toBeLessThanOrEqual(10);
    expect(calls.every((ms) => ms <= 10)).toBe(true);
  });

  it("the whole suite's own acquisitions finish in under 2000 real milliseconds while proving over 60000 virtual milliseconds of enforced spacing", async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const realStart = Date.now();
    const virtualStart = clock.now();

    for (let i = 0; i < 3; i += 1) {
      await limiter.acquire('general', 60_000);
    }
    await limiter.acquire('parse-class', 60_000);
    await limiter.acquire('parse-class', 60_000);
    await limiter.acquire('parse-class', 60_000);

    const virtualElapsed = clock.now() - virtualStart;
    const realElapsed = Date.now() - realStart;

    expect(virtualElapsed).toBeGreaterThan(60_000);
    expect(realElapsed).toBeLessThan(2000);
  });

  it('grants immediately when a budget node was never written (no lingering wait from a prior test)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep, calls } = pairedSleep(clock);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const result = await limiter.acquire('general', 1);
    expect(result.granted).toBe(true);
    expect(result.waitedMs).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('uses LIQUIPEDIA_GENERAL_BUDGET_PATH and LIQUIPEDIA_PARSE_BUDGET_PATH as the storage paths', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now });

    await limiter.acquire('parse-class', 60_000);

    const generalSnapshot = await database.ref(LIQUIPEDIA_GENERAL_BUDGET_PATH).get();
    const parseSnapshot = await database.ref(LIQUIPEDIA_PARSE_BUDGET_PATH).get();
    expect(generalSnapshot.exists()).toBe(true);
    expect(parseSnapshot.exists()).toBe(true);
  });

  it('acquire with a non-positive remaining wait budget returns granted:false immediately with zero waited', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now });

    expect(await limiter.acquire('general', 0)).toEqual({
      granted: false,
      waitedMs: 0,
      reason: 'no-wait-budget',
    });
    expect(await limiter.acquire('general', -1)).toEqual({
      granted: false,
      waitedMs: 0,
      reason: 'no-wait-budget',
    });
  });

  it('constants match the published access contract', () => {
    expect(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS).toBe(2000);
    expect(LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS).toBe(30_000);
  });
});
