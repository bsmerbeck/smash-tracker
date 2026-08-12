import type { FakeDatabase, FakeReference } from './fakeDatabase.js';

/**
 * Phase 30.2 gap-closure (BLOCKER 1): a thin wrapper over `FakeDatabase`,
 * modelled on `faultInjectingDatabase.ts`'s structure and its written
 * self-justification.
 *
 * `FaultInjectingDatabase` proves what a CRASH between two of the applier's
 * own writes leaves behind. `ConflictingTransactionDatabase` proves
 * convergence under a competing write on one nominated path. Neither can
 * express what the write-time-ownership tests need: a FOREIGN WRITE (a user
 * editing their own match row through the ordinary edit form) landing at an
 * exact point in the applier's three-phase sequence — specifically AFTER the
 * planning reads and AFTER phase A's witness pre-write, but BEFORE the phase
 * B transaction for that same row.
 *
 * This double fires a caller-supplied `edit` callback exactly ONCE,
 * immediately before delegating the nominated path's FIRST `.transaction()`
 * call to the underlying `FakeDatabase`. Because the edit is applied to the
 * underlying store before the transaction reads it, the transaction sees the
 * edited row as its `current` value — which is precisely the interleaving a
 * plan-time-only resolver silently overwrites and a write-time resolver
 * preserves.
 *
 * What this DOES establish: that the applier's per-row transaction resolves
 * ownership against the value the store holds at commit time, not against
 * the value it read while planning.
 *
 * What this does NOT establish: genuine wall-clock concurrency (same caveat
 * as the other doubles — every "attempt" here runs on one JS thread in a
 * fixed order), nor a foreign write landing DURING a transaction retry (the
 * underlying `FakeDatabase.transaction` reads its `current` once).
 */
export interface ConcurrentEditSpec {
  /** The exact `ref()` path whose first `.transaction()` call triggers the edit. */
  path: string;
  /** Applied to the underlying store immediately before that transaction is delegated. */
  edit: () => void;
}

export class ConcurrentEditDatabase {
  private readonly inner: FakeDatabase;
  private readonly spec: ConcurrentEditSpec;
  private fired = false;

  constructor(inner: FakeDatabase, spec: ConcurrentEditSpec) {
    this.inner = inner;
    this.spec = spec;
  }

  /** Whether the injected edit has been applied — a test's own bookkeeping aid. */
  get editApplied(): boolean {
    return this.fired;
  }

  ref(path?: string): FakeReference {
    const innerRef = this.inner.ref(path);
    return {
      ...innerRef,
      transaction: async (updateFn: (current: unknown) => unknown) => {
        if (!this.fired && path === this.spec.path) {
          this.fired = true;
          this.spec.edit();
        }
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
