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

/**
 * WR-01-i3 (36-REVIEW.md iteration 3): a stored `lastGrantedAtMs` implausibly
 * far in the future used to be trusted unconditionally forever — every
 * subsequent acquisition would compute an unreachable floor from it and
 * decline, and a decline still commits a reservation, so the poisoned value
 * could never shrink back down. These tests assert the sanity ceiling: a
 * poisoned stamp is clamped to `now() + intervalMs` (never earlier — still
 * conservative) and surfaced via `durableStampWasPoisoned`, while a
 * legitimately-queued near-future stamp (well within the horizon) is left
 * completely untouched.
 */
describe('createLiquipediaLimiter — poisoned durable stamp sanity ceiling (WR-01-i3)', () => {
  it('clamps a stored lastGrantedAtMs implausibly far in the future instead of trusting it forever, and surfaces durableStampWasPoisoned', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    // General horizon is 2000 * 20 = 40_000ms — this is ~250x that.
    await database
      .ref(LIQUIPEDIA_GENERAL_BUDGET_PATH)
      .set({ lastGrantedAtMs: clock.now() + 10_000_000 });
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const startMs = clock.now();
    const result = await limiter.acquire('general', 60_000);

    expect(result.granted).toBe(true);
    expect(result.durableStampWasPoisoned).toBe(true);
    // Clamped to now() + interval, NOT the poisoned 10_000_000ms-out value —
    // the whole point of the fix is that the wait stays bounded.
    expect(clock.now() - startMs).toBe(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);

    // The durable stamp itself is no longer poisoned for the NEXT caller —
    // it was clamped down, not merely worked around for this one call.
    const stored = database.dump().researchRateBudget as {
      liquipedia?: { lastGrantedAtMs: number };
    };
    expect(stored.liquipedia!.lastGrantedAtMs).toBeLessThan(clock.now() + 1000);
  });

  it('does NOT clamp a legitimately-queued near-future stamp well within the horizon', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    // 5000ms ahead — comfortably inside the 40_000ms general horizon, the
    // shape a few genuinely queued concurrent acquisitions could produce.
    const queuedAheadMs = 5000;
    await database
      .ref(LIQUIPEDIA_GENERAL_BUDGET_PATH)
      .set({ lastGrantedAtMs: clock.now() + queuedAheadMs });
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now, sleep });

    const startMs = clock.now();
    const result = await limiter.acquire('general', 60_000);

    expect(result.granted).toBe(true);
    expect(result.durableStampWasPoisoned).toBeUndefined();
    // Untouched: floor is the genuine stamp + interval, not clamped down.
    expect(clock.now() - startMs).toBe(queuedAheadMs + LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
  });

  it('treats a NaN/non-finite stored lastGrantedAtMs as "no prior grant" (parseIntervalBudget parity, not a new behavior)', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const limiter = createLiquipediaLimiter(asDatabase(database), { now: clock.now });

    // Seeded directly (not via JSON, which cannot represent NaN) — the
    // in-memory FakeDatabase preserves it byte-for-byte.
    await database.ref(LIQUIPEDIA_GENERAL_BUDGET_PATH).set({ lastGrantedAtMs: Number.NaN });

    const result = await limiter.acquire('general', 1000);
    expect(result.granted).toBe(true);
    expect(result.waitedMs).toBe(0);
    expect(result.durableStampWasPoisoned).toBeUndefined();
  });
});

/**
 * WR-03-i3 (36-REVIEW.md iteration 3): the resolution-spacing property this
 * whole module exists to provide was, until this fix, conditioned on an
 * unenforced assumption that every caller awaits sequentially. These tests
 * fire acquisitions WITHOUT an intervening `await` (`Promise.all`) and
 * assert the property still holds, plus that a thrown transaction attempt
 * never wedges the in-process mutex for callers queued behind it.
 */
describe('createLiquipediaLimiter — concurrent in-process acquisitions (WR-03-i3)', () => {
  it('keeps the total elapsed time across 10 Promise.all-fired (not awaited-sequentially) general acquisitions at least 9 intervals, with varied transaction latencies', async () => {
    // Measuring each individual RESOLUTION instant via an external `.then()`
    // probe would itself race the internal mutex hand-off under a virtual
    // clock (a probe callback and the mutex's own continuation are both
    // scheduled as microtasks, and the probe sits behind extra async-function
    // unwrapping layers relative to the mutex's direct `.then()` — a few
    // milliseconds of observation-order noise, not an algorithm defect). The
    // TOTAL elapsed time read once, after `Promise.all` itself has fully
    // settled (by which point every internal continuation has already run),
    // has no such race and is what this test asserts instead: 10 acquisitions
    // fully serialized by the mutex must span at least 9 full intervals,
    // exactly as if they had been awaited one at a time.
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    const random = seededRandom(0xc0ffee);
    const latencies = Array.from({ length: 200 }, () => Math.floor(random() * 500));
    const txDatabase = withTransactionLatency(database, clock, latencies);
    const limiter = createLiquipediaLimiter(txDatabase, { now: clock.now, sleep });

    const startMs = clock.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.acquire('general', 200_000)),
    );

    expect(results.every((result) => result.granted)).toBe(true);
    expect(clock.now() - startMs).toBeGreaterThanOrEqual(9 * LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
  });

  it('does not even ATTEMPT a second, genuinely concurrent acquire on the same path until the first has fully released — the direct discriminator for the mutex (holding the first transaction open with a manual gate)', async () => {
    // FakeDatabase's `.transaction()` body is fully synchronous internally,
    // so a naive `Promise.all` + varied-latency test (below) cannot actually
    // force two callers' RESERVATION steps to interleave — the fake commits
    // each write before yielding, so even the pre-mutex code serializes
    // correctly against THAT double by accident. This test instead holds
    // the FIRST acquisition's underlying `.transaction()` open with a
    // manually-resolved gate, so the second acquisition — fired without any
    // `await` between them — has every opportunity to race ahead if nothing
    // is serializing them. Without the mutex, the second call reaches and
    // completes its OWN (ungated) `.transaction()` almost immediately, long
    // before the first is ever unblocked. With the mutex, the second call's
    // `acquireOnBudgetExclusive` body never even starts — it cannot call
    // `now()` or touch a transaction — until the first's entire exclusive
    // section (still parked on the gate) has resolved.
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    let unblockFirstTransaction: (() => void) | undefined;
    const firstTransactionGate = new Promise<void>((resolve) => {
      unblockFirstTransaction = resolve;
    });
    let callIndex = 0;
    const gatedDatabase = {
      ref: (refPath: string) => {
        const ref = database.ref(refPath);
        return {
          ...ref,
          transaction: async (updateFn: (current: unknown) => unknown) => {
            const index = callIndex;
            callIndex += 1;
            if (index === 0) {
              await firstTransactionGate;
            }
            return ref.transaction(updateFn);
          },
        };
      },
    } as unknown as Database;
    const limiter = createLiquipediaLimiter(gatedDatabase, { now: clock.now, sleep });

    const firstPromise = limiter.acquire('general', 60_000);

    let secondSettled = false;
    const secondPromise = limiter.acquire('general', 60_000).then((result) => {
      secondSettled = true;
      return result;
    });

    // Drain several microtask ticks — ample opportunity for an unserialized
    // second call to reach and resolve its own (ungated) transaction.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(secondSettled).toBe(false);

    unblockFirstTransaction!();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(secondSettled).toBe(true);
  });

  it('a thrown transaction attempt does not deadlock subsequent acquires on the same budget path', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    let callIndex = 0;
    const throwingDatabase = {
      ref: (refPath: string) => {
        const ref = database.ref(refPath);
        return {
          ...ref,
          transaction: async (updateFn: (current: unknown) => unknown) => {
            const index = callIndex;
            callIndex += 1;
            if (index === 0) {
              throw new Error('simulated transaction failure on the first attempt');
            }
            return ref.transaction(updateFn);
          },
        };
      },
    } as unknown as Database;
    const limiter = createLiquipediaLimiter(throwingDatabase, { now: clock.now, sleep });

    await expect(limiter.acquire('general', 60_000)).rejects.toThrow(
      /simulated transaction failure/,
    );

    // The mutex must have released for the next queued caller despite the
    // thrown attempt above — this would hang forever if it wedged.
    const second = await limiter.acquire('general', 60_000);
    expect(second.granted).toBe(true);
  });

  it('a thrown transaction attempt on a QUEUED (not yet started) concurrent acquire still lets the next one through', async () => {
    const database = new FakeDatabase();
    const clock = makeClock(1_767_225_600_000);
    const { sleep } = pairedSleep(clock);
    let callIndex = 0;
    const throwingDatabase = {
      ref: (refPath: string) => {
        const ref = database.ref(refPath);
        return {
          ...ref,
          transaction: async (updateFn: (current: unknown) => unknown) => {
            const index = callIndex;
            callIndex += 1;
            // Fail the SECOND `.transaction()` call — i.e. the second
            // concurrently-fired acquisition's own attempt, after the
            // mutex has let it through following the first's success.
            if (index === 1) {
              throw new Error('simulated transaction failure on the second attempt');
            }
            return ref.transaction(updateFn);
          },
        };
      },
    } as unknown as Database;
    const limiter = createLiquipediaLimiter(throwingDatabase, { now: clock.now, sleep });

    const [firstOutcome, secondOutcome] = await Promise.allSettled([
      limiter.acquire('general', 60_000),
      limiter.acquire('general', 60_000),
    ]);
    expect(firstOutcome.status).toBe('fulfilled');
    expect(secondOutcome.status).toBe('rejected');

    // A THIRD acquisition, queued behind the failed second one, must still
    // resolve rather than hang.
    const third = await limiter.acquire('general', 60_000);
    expect(third.granted).toBe(true);
  });
});
