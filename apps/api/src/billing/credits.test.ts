import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { dayShardKey } from '../events/ledger.js';
import type { FakeReference } from '../test-support/fakeDatabase.js';
import {
  REFUND_MARKERS_KEY,
  addCredits,
  bundleSlotRef,
  fulfillCheckoutSession,
  getBalance,
  refundCredit,
  refundCreditOnce,
  spendCredit,
  spendCredits,
} from './credits.js';

const UID = 'uid-1';

/**
 * B-event emission (`void createEvent(...)`) is intentionally fire-and-forget
 * — callers never await it. Flush the microtask/macrotask queue before
 * asserting on `eventLedger` so these tests aren't racing the emission.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function eventLedgerEntries(database: FakeDatabase, eventName: string) {
  const dump = database.dump() as Record<string, unknown>;
  const ledgerByDay = dump.eventLedger as Record<string, Record<string, unknown>> | undefined;
  if (!ledgerByDay) return [];
  return Object.values(ledgerByDay).flatMap((dayEntries) =>
    Object.values(dayEntries).filter(
      (entry) => (entry as { eventName?: string }).eventName === eventName,
    ),
  );
}

function creditLedgerEntries(
  database: FakeDatabase,
  uid: string,
): Array<{ type: string; amount: number; ref: string; createdAt: number }> {
  const dump = database.dump() as Record<string, unknown>;
  const ledger = dump.creditLedger as Record<string, Record<string, unknown>> | undefined;
  const entries = ledger?.[uid];
  if (!entries) return [];
  return Object.values(entries) as Array<{
    type: string;
    amount: number;
    ref: string;
    createdAt: number;
  }>;
}

describe('addCredits', () => {
  it('under two concurrent calls, the final balance is the sum of both grants (no lost update)', async () => {
    const database = new FakeDatabase();

    await Promise.all([
      addCredits(database as never, UID, 5, 'ref-a'),
      addCredits(database as never, UID, 15, 'ref-b'),
    ]);

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(20);
  });

  it('treats a fresh uid (null balance) as 0, not a permanent-abort condition', async () => {
    const database = new FakeDatabase();
    await addCredits(database as never, UID, 5, 'ref-a');
    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(5);
  });
});

describe('refundCredit', () => {
  it('uses a transaction and treats a null balance as 0 — a first-ever refund is a legitimate null start', async () => {
    const database = new FakeDatabase();
    await refundCredit(database as never, UID, 'ref-refund-1');
    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(1);
  });

  it('emits exactly one credit_refunded B event, deduped on ${ref}:credit_refunded', async () => {
    const database = new FakeDatabase();
    await refundCredit(database as never, UID, 'ref-refund-2');
    await refundCredit(database as never, UID, 'ref-refund-2');
    await flush();

    const events = eventLedgerEntries(database, 'credit_refunded');
    expect(events).toHaveLength(1);
  });
});

describe('spendCredit', () => {
  it('emits exactly one credit_spent B event on a successful spend', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 3);

    const spent = await spendCredit(database as never, UID, 'ref-spend-1');
    expect(spent).toBe(true);
    await flush();

    const events = eventLedgerEntries(database, 'credit_spent');
    expect(events).toHaveLength(1);
  });

  it('emits no credit_spent event when the balance is already 0', async () => {
    const database = new FakeDatabase();
    const spent = await spendCredit(database as never, UID, 'ref-spend-2');
    expect(spent).toBe(false);
    await flush();

    const events = eventLedgerEntries(database, 'credit_spent');
    expect(events).toHaveLength(0);
  });
});

function makeSession(overrides: { uid?: string; packId?: string } = {}) {
  return {
    id: 'cs_test_1',
    metadata: { uid: overrides.uid ?? UID, packId: overrides.packId ?? 'pack5' },
  };
}

describe('fulfillCheckoutSession', () => {
  it('on a fresh event, writes processedStripeEvents + its day-mirror + balance + creditLedger + its day-mirror in one atomic update, and returns granted=true', async () => {
    const database = new FakeDatabase();
    const session = makeSession();

    const result = await fulfillCheckoutSession(database as never, session, 'evt_fresh');
    expect(result).toEqual({ granted: true });

    const day = dayShardKey(Date.now());
    const dump = database.dump() as Record<string, unknown>;

    expect((dump.processedStripeEvents as Record<string, unknown>)['evt_fresh']).toBeTypeOf(
      'number',
    );
    const byDay = dump.processedStripeEventsByDay as Record<string, Record<string, unknown>>;
    expect(byDay[day]!['evt_fresh']).toBe(true);

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(5);

    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    const entries = Object.values(ledger[UID]!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'purchase', amount: 5, ref: 'evt_fresh' });

    const ledgerByDay = dump.creditLedgerByDay as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const dayEntries = Object.values(ledgerByDay[day]![UID]!);
    expect(dayEntries).toHaveLength(1);
    expect(dayEntries[0]).toMatchObject({ type: 'purchase', amount: 5, ref: 'evt_fresh' });
  });

  it('on a replayed event id, grants nothing a second time', async () => {
    const database = new FakeDatabase();
    const session = makeSession();

    const first = await fulfillCheckoutSession(database as never, session, 'evt_replay');
    const second = await fulfillCheckoutSession(database as never, session, 'evt_replay');

    expect(first).toEqual({ granted: true });
    expect(second).toEqual({ granted: false });

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(5);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    expect(Object.values(ledger[UID]!)).toHaveLength(1);
  });

  it('is a no-op (granted=false) when session metadata is missing uid/packId, without burning the dedup marker', async () => {
    const database = new FakeDatabase();
    const session = { id: 'cs_test_bad', metadata: {} };

    const result = await fulfillCheckoutSession(database as never, session, 'evt_bad_meta');
    expect(result).toEqual({ granted: false });

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.processedStripeEvents).toBeUndefined();
    expect(dump.credits).toBeUndefined();
  });

  it('emits exactly one credits_granted B event, deduped on ${stripeEventId}:credits_granted', async () => {
    const database = new FakeDatabase();
    const session = makeSession();

    await fulfillCheckoutSession(database as never, session, 'evt_event_dedup');
    await fulfillCheckoutSession(database as never, session, 'evt_event_dedup');
    await flush();

    const events = eventLedgerEntries(database, 'credits_granted');
    expect(events).toHaveLength(1);
  });
});

describe('spendCredits (RPT-02 bundle atomicity)', () => {
  it('happy path: debits exactly N credits in one transaction and materializes N -1 ledger entries with per-slot refs', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);

    const outcome = await spendCredits(database as never, UID, 'b1', 3);
    expect(outcome).toBe('debited');

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(2);

    const entries = creditLedgerEntries(database, UID);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.ref).sort()).toEqual(['b1:1', 'b1:2', 'b1:3']);
    expect(entries.every((entry) => entry.amount === -1)).toBe(true);
    expect(entries.every((entry) => entry.type === 'spend')).toBe(true);
  });

  it('replay: a second call with the same bundleId returns alreadyProcessed and changes nothing', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);

    await spendCredits(database as never, UID, 'b1', 3);
    const second = await spendCredits(database as never, UID, 'b1', 3);

    expect(second).toBe('alreadyProcessed');
    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(2);
    expect(creditLedgerEntries(database, UID)).toHaveLength(3);
  });

  it('concurrency (battery item 1): two concurrent calls with the same bundleId debit exactly once', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);

    const [first, second] = await Promise.all([
      spendCredits(database as never, UID, 'b1', 3),
      spendCredits(database as never, UID, 'b1', 3),
    ]);

    expect([first, second].sort()).toEqual(['alreadyProcessed', 'debited']);
    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(2);
    expect(creditLedgerEntries(database, UID)).toHaveLength(3);
  });

  it('insufficient balance writes nothing (battery item 2): balance, ledger, and event ledger are all untouched', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 2);

    const outcome = await spendCredits(database as never, UID, 'b1', 3);
    expect(outcome).toBe('insufficient');

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(2);
    expect(creditLedgerEntries(database, UID)).toHaveLength(0);

    await flush();
    expect(eventLedgerEntries(database, 'credit_spent')).toHaveLength(0);
  });

  it('an insufficient outcome is retryable: the same bundleId succeeds after a top-up', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 2);

    const first = await spendCredits(database as never, UID, 'b1', 3);
    expect(first).toBe('insufficient');

    await database.ref(`credits/${UID}/balance`).set(5);
    const second = await spendCredits(database as never, UID, 'b1', 3);

    expect(second).toBe('debited');
    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(2);
  });

  it('replay after refund (battery item 4): refunding one slot does not reopen the bundle for a second debit', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);

    await spendCredits(database as never, UID, 'b1', 3);
    await refundCredit(database as never, UID, bundleSlotRef('b1', 1));
    const balanceAfterRefund = await getBalance(database as never, UID);
    expect(balanceAfterRefund).toBe(3);

    const replay = await spendCredits(database as never, UID, 'b1', 3);
    expect(replay).toBe('alreadyProcessed');

    const balanceAfterReplay = await getBalance(database as never, UID);
    expect(balanceAfterReplay).toBe(3);
  });

  it('RTDB-safe refs (battery item 5): every written ledger ref and credit_spent causationId is path-legal with exactly one colon', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);

    await spendCredits(database as never, UID, 'b1', 3);
    await flush();

    const refs = creditLedgerEntries(database, UID).map((entry) => entry.ref);
    const causationIds = eventLedgerEntries(database, 'credit_spent').map(
      (entry) => (entry as { causationId?: string }).causationId ?? '',
    );

    expect(refs.length).toBeGreaterThan(0);
    expect(causationIds.length).toBeGreaterThan(0);

    // Build the illegal-character set from explicit char codes (not a raw
    // control-char regex literal) so period/hash/dollar/brackets/slash/space
    // and the full ASCII control range (0x00-0x1f, 0x7f/DEL) are all covered.
    const illegalCharacterCodes = new Set<number>([
      0x2e /* . */, 0x23 /* # */, 0x24 /* $ */, 0x5b /* [ */, 0x5d /* ] */, 0x2f /* / */,
      0x20 /* space */, 0x7f /* DEL */,
    ]);
    for (let code = 0x00; code <= 0x1f; code += 1) {
      illegalCharacterCodes.add(code);
    }
    function hasIllegalCharacter(value: string): boolean {
      return Array.from(value).some((char) => illegalCharacterCodes.has(char.charCodeAt(0)));
    }
    for (const ref of refs) {
      expect(hasIllegalCharacter(ref)).toBe(false);
      expect(ref.split(':')).toHaveLength(2);
    }
    for (const causationId of causationIds) {
      expect(hasIllegalCharacter(causationId)).toBe(false);
      expect(causationId.split(':')).toHaveLength(3);
    }
  });

  it('CR-01 / FakeDatabase parity (battery item 10): a positive seeded balance survives the always-null-first-run emulation', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 10);

    const outcome = await spendCredits(database as never, UID, 'b1', 3);
    expect(outcome).toBe('debited');
    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(7);
  });

  it('CR-01 / FakeDatabase parity (battery item 10): a pre-existing debited marker returns alreadyProcessed without touching the balance', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);
    database.seed(`creditBundleOps/${UID}/b1`, {
      status: 'debited',
      amount: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const outcome = await spendCredits(database as never, UID, 'b1', 3);
    expect(outcome).toBe('alreadyProcessed');

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(5);
  });

  it('argument guard: amount 0 or non-integer rejects before any RTDB access, leaving the balance untouched', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 5);

    await expect(spendCredits(database as never, UID, 'b1', 0)).rejects.toThrow();
    await expect(spendCredits(database as never, UID, 'b1', 2.5)).rejects.toThrow();

    const balance = await getBalance(database as never, UID);
    expect(balance).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Code review R6-WR-06 (iteration 6, LIVE MONEY — already in production):
// `fulfillCheckoutSession` read the balance with `getBalance` and then wrote
// the ABSOLUTE value `current + pack.credits` in a root multi-path update. A
// refund (`refundCreditOnce`, a transaction on `credits/{uid}`) or a spend
// (`spendCredit`, a transaction on `credits/{uid}/balance`) that committed
// between the read and the write was overwritten: the refund's +1 was lost
// for good (its create-once marker makes a retry abort), and a spend in the
// same window minted a free credit. The grant must ADD the pack's credits
// atomically. Each case below lets the competing write land exactly between
// the grant's read of the balance and its write — at the read for a
// read-then-write, or as the competing commit a transaction is retried
// against (the Admin SDK's hash compare) — and proves the outcome through
// the balance AND the ledger: the opening balance plus every ledger amount
// equals the final balance.
// ---------------------------------------------------------------------------

/**
 * A `FakeDatabase` view on which the FIRST read or transaction that touches
 * `credits/{uid}` (the balance node or its parent) lets `competing` commit on
 * the INNER database in between: a `get()` returns the value it read BEFORE
 * the competing write; a `transaction()` first runs its update against that
 * stale value (discarded), then the competing write commits, then the real
 * transaction re-runs against the committed value — the SDK's retry.
 */
function interleavedCredits(inner: FakeDatabase, competing: () => Promise<unknown>) {
  let fired = false;
  const fireOnce = async (): Promise<void> => {
    if (!fired) {
      fired = true;
      await competing();
    }
  };
  return {
    fired: () => fired,
    ref(path?: string): FakeReference {
      const ref = inner.ref(path);
      if (path !== `credits/${UID}/balance` && path !== `credits/${UID}`) {
        return ref;
      }
      return {
        ...ref,
        get: async () => {
          const stale = await ref.get();
          await fireOnce();
          return stale;
        },
        transaction: async (updateFn: (current: unknown) => unknown) => {
          if (!fired) {
            void updateFn((await ref.get()).val());
            await fireOnce();
          }
          return ref.transaction(updateFn);
        },
      };
    },
  };
}

function ledgerSum(database: FakeDatabase): number {
  return creditLedgerEntries(database, UID).reduce((sum, entry) => sum + entry.amount, 0);
}

describe('R6-WR-06: a purchase grant ADDS the pack credits, so a refund or a spend that lands mid-grant is never lost or undone', () => {
  it('a refund that commits between the grant reading and writing the balance survives: 0 + 1 (refund) + 5 (pack) = 6', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 0);
    const view = interleavedCredits(database, () =>
      refundCreditOnce(database as never, UID, 'job-refund', 'job-refund:exec-1'),
    );

    const result = await fulfillCheckoutSession(view as never, makeSession(), 'evt_refund_race');

    expect(result).toEqual({ granted: true });
    expect(view.fired()).toBe(true);
    expect(await getBalance(database as never, UID)).toBe(6);
    const entries = creditLedgerEntries(database, UID);
    expect(entries.map((entry) => `${entry.type}:${entry.amount}:${entry.ref}`).sort()).toEqual([
      'purchase:5:evt_refund_race',
      'refund:1:job-refund',
    ]);
    expect(0 + ledgerSum(database)).toBe(await getBalance(database as never, UID));
  });

  it('a spend that commits between the grant reading and writing the balance is not undone: 1 - 1 (spend) + 5 (pack) = 5, no free credit', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 1);
    const view = interleavedCredits(database, () =>
      spendCredit(database as never, UID, 'job-spend'),
    );

    const result = await fulfillCheckoutSession(view as never, makeSession(), 'evt_spend_race');

    expect(result).toEqual({ granted: true });
    expect(view.fired()).toBe(true);
    expect(await getBalance(database as never, UID)).toBe(5);
    const entries = creditLedgerEntries(database, UID);
    expect(entries.map((entry) => `${entry.type}:${entry.amount}:${entry.ref}`).sort()).toEqual([
      'purchase:5:evt_spend_race',
      'spend:-1:job-spend',
    ]);
    expect(1 + ledgerSum(database)).toBe(await getBalance(database as never, UID));
  });

  it('a refund marker the grant raced keeps working: a retry of the same refund still finds its marker and refunds nothing more', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 0);
    const view = interleavedCredits(database, () =>
      refundCreditOnce(database as never, UID, 'job-refund', 'job-refund:exec-1'),
    );

    await fulfillCheckoutSession(view as never, makeSession(), 'evt_refund_retry');
    const again = await refundCreditOnce(database as never, UID, 'job-refund', 'job-refund:exec-1');

    expect(again).toBe(false);
    expect(await getBalance(database as never, UID)).toBe(6);
    expect(
      creditLedgerEntries(database, UID).filter((entry) => entry.type === 'refund'),
    ).toHaveLength(1);
  });

  it('unchanged purchase trail: the processed marker, its day mirror, one purchase ledger entry, its day mirror and one credits_granted event', async () => {
    const database = new FakeDatabase();
    database.seed(`credits/${UID}/balance`, 2);

    const first = await fulfillCheckoutSession(database as never, makeSession(), 'evt_trail');
    const replay = await fulfillCheckoutSession(database as never, makeSession(), 'evt_trail');
    await flush();

    expect(first).toEqual({ granted: true });
    expect(replay).toEqual({ granted: false });
    expect(await getBalance(database as never, UID)).toBe(7);
    const day = dayShardKey(Date.now());
    const dump = database.dump() as Record<string, Record<string, unknown>>;
    expect(dump.processedStripeEvents!['evt_trail']).toBeTypeOf('number');
    expect((dump.processedStripeEventsByDay![day] as Record<string, unknown>)['evt_trail']).toBe(
      true,
    );
    const entries = creditLedgerEntries(database, UID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'purchase', amount: 5, ref: 'evt_trail' });
    const byDay = (dump.creditLedgerByDay![day] as Record<string, Record<string, unknown>>)[UID]!;
    expect(Object.values(byDay)).toEqual(entries);
    expect(eventLedgerEntries(database, 'credits_granted')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Code review R6-IN-02 (iteration 6): `credits/{uid}/refundMarkers` gained
// one entry per refunded execution and was never pruned, and a user can drive
// the growth (the thin-evidence fail-fast spends and refunds at no net cost).
// A marker only needs to outlive its own request's retries and a reconnect
// replay, so `refundCreditOnce` drops every OTHER marker older than 24 hours
// inside its own transaction.
// ---------------------------------------------------------------------------

describe('R6-IN-02: refundCreditOnce prunes markers older than 24 hours in its own transaction', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('drops markers older than 24 h, keeps younger ones, and writes its own', async () => {
    const database = new FakeDatabase();
    const now = Date.now();
    database.seed(`credits/${UID}`, {
      balance: 2,
      [REFUND_MARKERS_KEY]: {
        'old-job:exec': { ledgerKey: 'k-old', createdAt: now - DAY_MS - 60_000 },
        'young-job:exec': { ledgerKey: 'k-young', createdAt: now - 60 * 60 * 1000 },
      },
    });

    const committed = await refundCreditOnce(database as never, UID, 'new-job', 'new-job:exec');

    expect(committed).toBe(true);
    expect(await getBalance(database as never, UID)).toBe(3);
    const markers = (database.dump().credits as Record<string, Record<string, unknown>>)[UID]![
      REFUND_MARKERS_KEY
    ] as Record<string, unknown>;
    expect(Object.keys(markers).sort()).toEqual(['new-job:exec', 'young-job:exec']);
  });

  it("never refunds twice: this execution's own marker aborts the refund however old it is", async () => {
    const database = new FakeDatabase();
    const now = Date.now();
    database.seed(`credits/${UID}`, {
      balance: 2,
      [REFUND_MARKERS_KEY]: {
        'job:exec': { ledgerKey: 'k-own', createdAt: now - 2 * DAY_MS },
      },
    });

    const committed = await refundCreditOnce(database as never, UID, 'job', 'job:exec');

    expect(committed).toBe(false);
    expect(await getBalance(database as never, UID)).toBe(2);
  });
});
