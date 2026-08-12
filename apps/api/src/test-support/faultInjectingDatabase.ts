import type { FakeDatabase, FakeReference } from './fakeDatabase.js';

/**
 * Phase 30.2 Plan 08 (cycle-1 review HIGH 3): a thin wrapper over
 * `FakeDatabase`, modelled on `conflictingTransactionDatabase.ts`'s
 * structure and its written self-justification.
 *
 * `ConflictingTransactionDatabase` proves convergence under a SINGLE
 * competing write on ONE nominated path. It cannot express what this task's
 * fault-injection tests need: a DETERMINISTIC PROCESS DEATH at an EXACT
 * point in a MULTI-WRITE, MULTI-PATH sequence (the enrichment applier's
 * three-phase witness protocol — witness pre-write, N per-row transactions,
 * witness commit — touches several distinct paths in a fixed order).
 *
 * `FaultInjectingDatabase` counts every `set`/`update`/`transaction` call
 * made through ANY `ref()` obtained from this instance — a single, shared,
 * instance-level counter, never per-path — and throws a distinguishable
 * `FaultInjectedError` the Nth time one of those three operations is
 * invoked, simulating a process crash immediately before that write would
 * have taken effect (the write never reaches the underlying `FakeDatabase`
 * at all — this mirrors a crash between "decided to write" and "write
 * landed", not a crash mid-write). A test picks N to land exactly between
 * two phases of the applier's own write sequence, drives the applier once
 * (observing the thrown error), constructs a FRESH `FaultInjectingDatabase`
 * over the SAME underlying `FakeDatabase` with N raised past the crash
 * point (or a plain `FakeDatabase` reference), and re-runs the applier —
 * proving the retry converges on the same final state a crash-free run
 * would have produced.
 *
 * What this DOES establish: that the applier's own write ordering leaves
 * the store in a state a RETRY can safely resume from, at every inter-write
 * boundary the applier itself creates.
 *
 * What this does NOT establish: a crash mid-write (the underlying
 * `FakeDatabase.set`/`.update`/`.transaction` call is never actually
 * invoked when this double throws — a real partial RTDB write is a
 * different failure mode this double does not model), or genuine wall-clock
 * concurrency (same caveat as `ConflictingTransactionDatabase`: every
 * "attempt" here runs on one JS thread in a fixed order).
 */
export class FaultInjectedError extends Error {
  constructor(writeNumber: number) {
    super(`FaultInjectingDatabase: injected crash on write #${writeNumber}`);
    this.name = 'FaultInjectedError';
  }
}

export class FaultInjectingDatabase {
  private readonly inner: FakeDatabase;
  private readonly crashOnWriteNumber: number;
  private writeCount = 0;

  constructor(inner: FakeDatabase, crashOnWriteNumber: number) {
    this.inner = inner;
    this.crashOnWriteNumber = crashOnWriteNumber;
  }

  /** How many `set`/`update`/`transaction` calls landed before any injected crash — a test's own bookkeeping aid. */
  get writesObserved(): number {
    return this.writeCount;
  }

  private countAndMaybeThrow(): void {
    this.writeCount += 1;
    if (this.writeCount === this.crashOnWriteNumber) {
      throw new FaultInjectedError(this.writeCount);
    }
  }

  ref(path?: string): FakeReference {
    const innerRef = this.inner.ref(path);
    return {
      ...innerRef,
      set: async (value: unknown) => {
        this.countAndMaybeThrow();
        return innerRef.set(value);
      },
      update: async (values: Record<string, unknown>) => {
        this.countAndMaybeThrow();
        return innerRef.update(values);
      },
      transaction: async (updateFn: (current: unknown) => unknown) => {
        this.countAndMaybeThrow();
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
