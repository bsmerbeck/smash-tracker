import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { dayShardKey } from '../events/ledger.js';
import {
  addCredits,
  fulfillCheckoutSession,
  getBalance,
  refundCredit,
  spendCredit,
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
