import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { dayShardKey } from '../events/ledger.js';
import {
  addCredits,
  bundleSlotRef,
  fulfillCheckoutSession,
  getBalance,
  refundCredit,
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
