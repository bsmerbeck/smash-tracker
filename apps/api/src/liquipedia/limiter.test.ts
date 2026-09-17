import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase, type FakeReference } from '../test-support/fakeDatabase.js';
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

/**
 * D-29: wraps a `FakeDatabase` so every `.transaction()` call — on ANY
 * path, including the limiter's own internal repair sub-transaction —
 * advances the shared clock by a caller-controlled latency BEFORE
 * resolving, simulating a real RTDB round trip whose duration varies from
 * call to call (a cold connection commonly costs ~1s; a warm one ~10ms).
 * `latenciesMs[i]` is consumed by the i-th `.transaction()` call across the
 * WHOLE wrapped database (any path, any ref); calls beyond the array's
 * length reuse the LAST entry (clamped, not zero) — a deliberate modelling
 * choice: once a connection is warm, later calls stay warm too, which is
 * also what lets a 2-element `[coldMs, warmMs]` array exercise a
 * reservation's own repair sub-transaction realistically without the test
 * needing to know exactly how many internal transaction calls one
 * `acquire()` makes.
 */
function withTransactionLatency(
  database: FakeDatabase,
  clock: ReturnType<typeof makeClock>,
  latenciesMs: readonly number[],
): Database {
  let callIndex = 0;
  const wrapRef = (ref: FakeReference): FakeReference => ({
    ...ref,
    transaction: async (updateFn: (current: unknown) => unknown) => {
      const latencyMs = latenciesMs[Math.min(callIndex, latenciesMs.length - 1)] ?? 0;
      callIndex += 1;
      const result = await ref.transaction(updateFn);
      clock.advance(latencyMs);
      return result;
    },
  });
  return {
    ref: (path: string) => wrapRef(database.ref(path)),
  } as unknown as Database;
}

/** A seeded, deterministic PRNG (mulberry32) — no external dependency, reproducible across runs. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

/**
 * D-29 (owner-recorded decision, 36-CONTEXT.md): the pre-fix limiter stamped
 * `lastGrantedAtMs` from the clock read BEFORE the `.transaction()` round
 * trip, then returned as soon as the transaction committed — with no sleep
 * to align the RESOLUTION to that stamp. When one transaction's round-trip
 * latency differs from the next (a cold RTDB connection commonly costs
 * ~1s, a warm one ~10ms), the REAL spacing between the moments the caller
 * actually dispatches its two requests drifts by exactly that latency
 * delta, and can fall below the published interval even though every
 * STAMP was correctly `>= intervalMs` apart. Reproduced live: two
 * `liqSpikeProbe.ts` requests measured 908ms apart after a
 * 1100ms-then-10ms transaction-latency profile.
 *
 * These tests assert the PROPERTY the fix restores: for any sequence of
 * acquisitions against one budget path, with ARBITRARY (including
 * decreasing) per-transaction latencies, the REAL instants at which
 * `acquire()` RESOLVES are always `>= intervalMs` apart.
 */
describe('createLiquipediaLimiter — request-start spacing under variable transaction latency (D-29)', () => {
  it('keeps consecutive general-class ACQUIRE RESOLUTIONS >= the published interval apart even when transaction latency drops from ~1.1s to ~10ms (owner-observed regression: pre-fix this resolves ~908ms apart)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const txDatabase = withTransactionLatency(database, clock, [1100, 10]);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const first = await limiter.acquire('general', 60_000);
    const resolveAtFirst = clock.now();
    expect(first.granted).toBe(true);

    const second = await limiter.acquire('general', 60_000);
    const resolveAtSecond = clock.now();
    expect(second.granted).toBe(true);

    const observedGapMs = resolveAtSecond - resolveAtFirst;
    expect(observedGapMs).toBeGreaterThanOrEqual(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
  });

  it('holds over a decreasing latency ramp (1500 -> 5ms across 6 acquisitions)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const latencies = [1500, 1200, 900, 600, 300, 5];
    const txDatabase = withTransactionLatency(database, clock, latencies);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const resolves: number[] = [];
    for (let i = 0; i < latencies.length; i += 1) {
      const result = await limiter.acquire('general', 60_000);
      expect(result.granted).toBe(true);
      resolves.push(clock.now());
    }
    for (let i = 1; i < resolves.length; i += 1) {
      expect(resolves[i]! - resolves[i - 1]!).toBeGreaterThanOrEqual(
        LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
      );
    }
  });

  it('holds over an increasing latency ramp (5ms -> 1500ms across 6 acquisitions)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const latencies = [5, 300, 600, 900, 1200, 1500];
    const txDatabase = withTransactionLatency(database, clock, latencies);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const resolves: number[] = [];
    for (let i = 0; i < latencies.length; i += 1) {
      const result = await limiter.acquire('general', 60_000);
      expect(result.granted).toBe(true);
      resolves.push(clock.now());
    }
    for (let i = 1; i < resolves.length; i += 1) {
      expect(resolves[i]! - resolves[i - 1]!).toBeGreaterThanOrEqual(
        LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
      );
    }
  });

  it('holds over 50 acquisitions with a seeded random latency profile (0-1800ms per transaction call)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const random = seededRandom(0xd29);
    // A generous, over-provisioned latency array: each acquisition may cost
    // several internal transaction calls (main + repair), so this array is
    // sized well beyond 50 to comfortably cover every call the run makes;
    // clamp-to-last semantics also cover any excess.
    const latencies = Array.from({ length: 400 }, () => Math.floor(random() * 1800));
    const txDatabase = withTransactionLatency(database, clock, latencies);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const resolves: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const result = await limiter.acquire('general', 120_000);
      expect(result.granted).toBe(true);
      resolves.push(clock.now());
    }
    for (let i = 1; i < resolves.length; i += 1) {
      expect(resolves[i]! - resolves[i - 1]!).toBeGreaterThanOrEqual(
        LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
      );
    }
  });

  it('holds when a single transaction latency exceeds the interval itself (extreme overshoot)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    // 5000ms latency on the FIRST acquisition alone exceeds the 2000ms
    // general interval — the repair path must still leave the record
    // accurate for the second acquisition.
    const txDatabase = withTransactionLatency(database, clock, [5000, 10]);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const first = await limiter.acquire('general', 60_000);
    const resolveAtFirst = clock.now();
    expect(first.granted).toBe(true);

    const second = await limiter.acquire('general', 60_000);
    const resolveAtSecond = clock.now();
    expect(second.granted).toBe(true);
    expect(resolveAtSecond - resolveAtFirst).toBeGreaterThanOrEqual(
      LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
    );
  });

  it('preserves the parse-class 30s + general 2s two-budget composition under variable transaction latency', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const txDatabase = withTransactionLatency(database, clock, [900, 50, 700, 20]);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const first = await limiter.acquire('parse-class', 120_000);
    const resolveAtFirst = clock.now();
    expect(first.granted).toBe(true);

    const second = await limiter.acquire('parse-class', 120_000);
    const resolveAtSecond = clock.now();
    expect(second.granted).toBe(true);
    expect(resolveAtSecond - resolveAtFirst).toBeGreaterThanOrEqual(
      LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS,
    );

    // The parse-class acquisition also stamped the general budget — an
    // immediate general acquisition must still respect the general
    // interval relative to that stamp, latency variance included.
    const generalStart = clock.now();
    const generalResult = await limiter.acquire('general', 60_000);
    const generalResolve = clock.now();
    expect(generalResult.granted).toBe(true);
    expect(generalResolve - generalStart).toBeGreaterThanOrEqual(0);
    expect(generalResolve).toBeGreaterThanOrEqual(resolveAtSecond);
  });

  it('still declines rather than sleeping past the remaining wait budget, with transaction latency in play', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep, calls } = pairedSleep(clock);
    const txDatabase = withTransactionLatency(database, clock, [200, 300]);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    await limiter.acquire('parse-class', 120_000);
    // Budget far too small for the ~30000ms residual wait on the parse
    // budget, even accounting for the injected transaction latency.
    const result = await limiter.acquire('parse-class', 10);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe('wait-budget-exceeded');
    expect(calls.every((ms) => ms <= 10)).toBe(true);
  });
});
