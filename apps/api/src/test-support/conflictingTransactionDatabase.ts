import type { FakeDatabase, FakeReference, FakeTransactionResult } from './fakeDatabase.js';

/**
 * Phase 29 Plan 10 (cycle-2 finding C2-MED-9): `FakeDatabase.transaction`
 * runs its callback SYNCHRONOUSLY against the current in-memory value with
 * no interleaving and no retry (`apps/api/src/test-support/fakeDatabase.ts`
 * around line 259) — a test built only on it cannot distinguish a
 * genuinely convergent implementation from one that would lose a write
 * under real contention.
 *
 * `ConflictingTransactionDatabase` is a thin wrapper over a `FakeDatabase`
 * whose `.transaction()` on ONE nominated path emulates the Admin SDK's
 * retry-on-conflict loop for exactly the FIRST `.transaction()` call made
 * against that path: it captures a stale snapshot, runs the caller's
 * `updateFn` against it ONCE and discards the result (this is the
 * caller's own speculative attempt, exactly as a real transaction's local
 * write is discarded once the SDK detects the server has moved on), then
 * commits a caller-supplied COMPETING write via the inner `FakeDatabase`'s
 * own (uncontested) transaction machinery, then delegates to the inner
 * `FakeDatabase`'s real `.transaction(updateFn)` — which itself re-invokes
 * `updateFn` against the now-updated value and commits that result. Every
 * subsequent `.transaction()` call on the SAME path (from either this
 * wrapper or a caller holding the same nominated ref) behaves like a plain,
 * uncontested `FakeDatabase` transaction — the interception fires exactly
 * once per instance, matching "one competing write races one call".
 *
 * What this DOES establish: the wrapped callback is a pure function of its
 * input that converges to the SAME correct state whether it observes a
 * stale snapshot first (and is later re-invoked against the winner's
 * committed value) or the up-to-date value directly — which is precisely
 * the property the operations index (`packages/shared/src/researchEntitlement.ts`)
 * depends on to keep a concurrently-losing attempt's key durable.
 *
 * What this does NOT establish: real wall-clock concurrency. No in-process
 * double can — both "attempts" here still run on one JS thread, in a fixed
 * order this wrapper controls. Every concurrency claim in this plan's tests
 * and SUMMARY is narrowed to exactly the convergence-under-retry property
 * above, never to genuine parallel execution.
 */
export interface ConflictingTransactionConfig {
  /** The exact RTDB path this double intercepts — every other path proxies straight to the inner `FakeDatabase`, unchanged. */
  path: string;
  /**
   * The competing write that "wins" the race — committed via the INNER
   * `FakeDatabase`'s own uncontested transaction machinery, between the
   * intercepted call's discarded first attempt and its committed second
   * attempt.
   */
  competingWrite: () => Promise<void>;
}

export class ConflictingTransactionDatabase {
  private readonly inner: FakeDatabase;
  private readonly config: ConflictingTransactionConfig;
  private intercepted = false;

  constructor(inner: FakeDatabase, config: ConflictingTransactionConfig) {
    this.inner = inner;
    this.config = config;
  }

  ref(path?: string): FakeReference {
    const innerRef = this.inner.ref(path);
    if (path !== this.config.path || this.intercepted) {
      return innerRef;
    }

    return {
      ...innerRef,
      transaction: async (
        updateFn: (current: unknown) => unknown,
      ): Promise<FakeTransactionResult> => {
        // Set BEFORE any `await` so a re-entrant `.ref()` call made from
        // within the competing write (or from a nested call on this same
        // instance) can never re-trigger interception.
        this.intercepted = true;

        // Phase 1: this caller's own speculative attempt, run against a
        // captured STALE snapshot — computed but never committed.
        const staleSnapshot = await innerRef.get();
        void updateFn(staleSnapshot.val());

        // Phase 2: the competing write commits FIRST, via the inner
        // FakeDatabase's own uncontested transaction machinery.
        await this.config.competingWrite();

        // Phase 3: the SDK's retry-on-conflict loop re-invokes the SAME
        // callback against the now-updated value and commits the result.
        return innerRef.transaction(updateFn);
      },
    };
  }

  /** Test helper parity with `FakeDatabase.seed` — proxies straight through. */
  seed(path: string, value: unknown): void {
    this.inner.seed(path, value);
  }

  /** Test helper parity with `FakeDatabase.dump` — proxies straight through. */
  dump(): unknown {
    return this.inner.dump();
  }
}
