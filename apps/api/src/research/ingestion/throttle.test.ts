import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  RESEARCH_THROTTLE_BURST,
  RESEARCH_THROTTLE_MAX_REQUESTS,
  RESEARCH_THROTTLE_ROLLING_MAX,
  RESEARCH_THROTTLE_WINDOW_MS,
  RESEARCH_TOKEN_BUDGET_PATH,
  RESEARCH_TOKEN_REFILL_INTERVAL_MS,
  createRequestThrottle,
  createSharedRequestThrottle,
} from './throttle.js';

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

function recordingSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

describe('createRequestThrottle', () => {
  it('allows up to the configured maximum without sleeping', async () => {
    const clock = makeClock(0);
    const { sleep, calls } = recordingSleep();
    const throttle = createRequestThrottle({
      maxRequests: 3,
      windowMs: 1000,
      now: clock.now,
      sleep,
    });

    for (let i = 0; i < 3; i += 1) {
      const result = await throttle.acquire(10_000);
      expect(result.acquired).toBe(true);
      expect(result.sleptMs).toBe(0);
    }
    expect(calls).toHaveLength(0);
    expect(throttle.requestsInWindow()).toBe(3);
  });

  it('sleeps exactly until the oldest request ages out, then proceeds', async () => {
    const clock = makeClock(0);
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      clock.advance(ms);
    };
    const throttle = createRequestThrottle({
      maxRequests: 2,
      windowMs: 1000,
      now: clock.now,
      sleep,
    });

    await throttle.acquire(10_000); // t=0
    clock.advance(200);
    await throttle.acquire(10_000); // t=200

    const result = await throttle.acquire(10_000);
    expect(result.acquired).toBe(true);
    // At t=200, the oldest entry (t=0) ages out at t=1000 — an 800ms wait.
    expect(sleepCalls).toEqual([800]);
    expect(result.sleptMs).toBe(800);
  });

  it('reports zero requests in window once the window has fully advanced', async () => {
    const clock = makeClock(0);
    const throttle = createRequestThrottle({ maxRequests: 2, windowMs: 1000, now: clock.now });
    await throttle.acquire(10_000);
    clock.advance(1001);
    expect(throttle.requestsInWindow()).toBe(0);
  });

  it('defaults to 60 requests per 60000ms', async () => {
    const throttle = createRequestThrottle();
    // Exercise the default via behavior rather than reaching into internals:
    // 60 acquisitions with a real (fast, unadvanced) clock should not sleep.
    const clock = makeClock(0);
    const sleep = async () => {
      throw new Error('should not sleep for the first 60 requests');
    };
    const t = createRequestThrottle({ now: clock.now, sleep });
    for (let i = 0; i < RESEARCH_THROTTLE_MAX_REQUESTS; i += 1) {
      const result = await t.acquire(10_000);
      expect(result.acquired).toBe(true);
    }
    expect(t.requestsInWindow()).toBe(RESEARCH_THROTTLE_MAX_REQUESTS);
    void throttle;
  });

  it('acquire(0) and acquire(-1) return acquired:false immediately with zero sleeps and no throw', async () => {
    const sleep = async () => {
      throw new Error('should never sleep');
    };
    const throttle = createRequestThrottle({ sleep });
    expect(await throttle.acquire(0)).toEqual({ acquired: false, sleptMs: 0 });
    expect(await throttle.acquire(-1)).toEqual({ acquired: false, sleptMs: 0 });
  });

  it('sums sleeps across three shrinking-budget acquisitions and never exceeds the first budget (review C3-A1)', async () => {
    const clock = makeClock(0);
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      clock.advance(ms);
    };
    const throttle = createRequestThrottle({
      maxRequests: 1,
      windowMs: 900,
      now: clock.now,
      sleep,
    });

    await throttle.acquire(10_000); // fills the single slot at t=0

    let remaining = 900;
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = await throttle.acquire(remaining);
      total += result.sleptMs;
      remaining -= result.sleptMs;
    }
    const sum = sleepCalls.reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(900);
    expect(total).toBeLessThanOrEqual(900);
  });
});

describe('createSharedRequestThrottle', () => {
  it('admits requests up to the burst before either of two throttles has to sleep', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = recordingSleep();

    const throttleA = createSharedRequestThrottle(asDatabase(database), {
      burst: 3,
      now: clock.now,
      sleep,
    });
    const throttleB = createSharedRequestThrottle(asDatabase(database), {
      burst: 3,
      now: clock.now,
      sleep,
    });

    const first = await throttleA.acquire(10_000);
    const second = await throttleB.acquire(10_000);
    const third = await throttleA.acquire(10_000);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(third.acquired).toBe(true);

    // The bucket (burst 3) is now drained — a 4th acquisition, from either
    // instance, must sleep because the SHARED bucket has nothing left, which
    // an in-process throttle alone cannot express.
    const fourthSleepCalls: number[] = [];
    const sleepingClock = makeClock(clock.now());
    const throttleC = createSharedRequestThrottle(asDatabase(database), {
      burst: 3,
      now: sleepingClock.now,
      sleep: async (ms) => {
        fourthSleepCalls.push(ms);
        sleepingClock.advance(ms);
      },
    });
    const fourth = await throttleC.acquire(10_000);
    expect(fourth.acquired).toBe(true);
    expect(fourthSleepCalls.length).toBeGreaterThan(0);
  });

  it('refills at exactly the configured rate, capped at the burst', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(0);
    const throttle = createSharedRequestThrottle(asDatabase(database), {
      burst: RESEARCH_THROTTLE_BURST,
      now: clock.now,
    });

    // Drain the bucket. Uses a minimal positive budget (0 always short-
    // circuits before touching the database — see the dedicated acquire(0)
    // test below).
    for (let i = 0; i < RESEARCH_THROTTLE_BURST; i += 1) {
      const result = await throttle.acquire(1);
      expect(result.acquired).toBe(true);
    }
    expect((await throttle.acquire(1)).acquired).toBe(false);

    // One refill interval admits exactly one more request.
    clock.advance(RESEARCH_TOKEN_REFILL_INTERVAL_MS);
    expect((await throttle.acquire(1)).acquired).toBe(true);
    expect((await throttle.acquire(1)).acquired).toBe(false);

    // Ten refill intervals admit exactly ten (never more — capped at burst).
    clock.advance(RESEARCH_TOKEN_REFILL_INTERVAL_MS * 10);
    let admitted = 0;
    for (let i = 0; i < 20; i += 1) {
      const result = await throttle.acquire(1);
      if (result.acquired) {
        admitted += 1;
      }
    }
    expect(admitted).toBe(10);
  });

  it('never exceeds the rolling bound across a 180-second span, including across a nominal window boundary', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(0);
    const throttle = createSharedRequestThrottle(asDatabase(database), {
      now: clock.now,
    });

    const admittedAtMs: number[] = [];
    const stepMs = 250;
    for (let elapsed = 0; elapsed <= 180_000; elapsed += stepMs) {
      const result = await throttle.acquire(1);
      if (result.acquired) {
        admittedAtMs.push(clock.now());
      }
      clock.advance(stepMs);
    }

    // Every 60-second sub-window (including the boundary the old fixed-window
    // design broke) admits at most RESEARCH_THROTTLE_ROLLING_MAX requests.
    for (const windowStart of admittedAtMs) {
      const count = admittedAtMs.filter(
        (t) => t >= windowStart && t < windowStart + RESEARCH_THROTTLE_WINDOW_MS,
      ).length;
      expect(count).toBeLessThanOrEqual(RESEARCH_THROTTLE_ROLLING_MAX);
    }

    // Drain further, then advance by exactly one nominal window's worth of
    // time. A fixed per-window counter would grant a FRESH allowance of up
    // to RESEARCH_THROTTLE_MAX_REQUESTS at this point; the token bucket has
    // no window concept and refills only up to its burst cap — never more,
    // even after a full window has elapsed (review C2-A4).
    while ((await throttle.acquire(1)).acquired) {
      // drain whatever remains
    }
    clock.advance(RESEARCH_THROTTLE_WINDOW_MS);
    let admittedAfterWindow = 0;
    for (let i = 0; i < RESEARCH_THROTTLE_MAX_REQUESTS; i += 1) {
      const result = await throttle.acquire(1);
      if (!result.acquired) {
        break;
      }
      admittedAfterWindow += 1;
    }
    expect(admittedAfterWindow).toBe(RESEARCH_THROTTLE_BURST);
  });

  it('stores only a token balance and a refill timestamp — no tenant-identifying member', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(0);
    const throttle = createSharedRequestThrottle(asDatabase(database), { now: clock.now });
    await throttle.acquire(1);

    const stored = database.dump().researchRateBudget as { startgg?: Record<string, unknown> };
    expect(stored?.startgg).toBeDefined();
    const keys = Object.keys(stored!.startgg!).sort();
    expect(keys).toEqual(['lastRefillAtMs', 'tokensMilli']);
  });

  it('uses RESEARCH_TOKEN_BUDGET_PATH as the default storage path', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(0);
    const throttle = createSharedRequestThrottle(asDatabase(database), { now: clock.now });
    await throttle.acquire(1);
    const snapshot = await database.ref(RESEARCH_TOKEN_BUDGET_PATH).get();
    expect(snapshot.exists()).toBe(true);
  });

  it('bounds its own waiting by the per-call remaining budget, reporting sleptMs without acquiring', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(0);
    const sleepCalls: number[] = [];
    const throttle = createSharedRequestThrottle(asDatabase(database), {
      burst: 1,
      now: clock.now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        clock.advance(ms);
      },
    });

    await throttle.acquire(10_000); // drains the single-token bucket

    const result = await throttle.acquire(10); // budget far too small for a ~1000ms refill wait
    expect(result.acquired).toBe(false);
    expect(result.sleptMs).toBeLessThanOrEqual(10);
  });

  it('sleeps no more than the caller-supplied cumulative budget across three shrinking-budget acquisitions (review C3-A1)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(0);
    const sleepCalls: number[] = [];
    const throttle = createSharedRequestThrottle(asDatabase(database), {
      burst: 1,
      now: clock.now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        clock.advance(ms);
      },
    });

    await throttle.acquire(10_000); // drain the single-token bucket

    const firstBudget = 900;
    let remaining = firstBudget;
    for (let i = 0; i < 3; i += 1) {
      const result = await throttle.acquire(remaining);
      remaining -= result.sleptMs;
    }
    const total = sleepCalls.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(firstBudget);
  });

  it('acquire(0) returns acquired:false with zero sleeps and no throw', async () => {
    const database = new FakeDatabase();
    const throttle = createSharedRequestThrottle(asDatabase(database));
    const sleepCalls: number[] = [];
    const throttleWithSleep = createSharedRequestThrottle(asDatabase(database), {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(await throttleWithSleep.acquire(0)).toEqual({ acquired: false, sleptMs: 0 });
    expect(sleepCalls).toHaveLength(0);
    void throttle;
  });
});
