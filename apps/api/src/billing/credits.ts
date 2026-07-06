import type { Database } from 'firebase-admin/database';
import { creditLedgerEntrySchema, type CreditLedgerEntry } from '@smash-tracker/shared';

/**
 * V7-C: RTDB credit ledger backing the Stripe-powered report-generation
 * paywall. RTDB layout (see `packages/shared/src/billing.ts`):
 *
 * - `credits/{uid}/balance`         -> number (int, >= 0)
 * - `creditLedger/{uid}/{pushKey}`  -> creditLedgerEntrySchema
 *
 * `spendCredit` is the only mutation that can race (concurrent report
 * generations from the same uid), so it alone uses `Reference.transaction`
 * on the balance node — every other mutation here is a single-writer path
 * (Stripe webhook for purchases, the reports route's own error handler for
 * refunds) and uses a plain read-then-write, mirroring `startgg/sync.ts`'s
 * convention of keeping non-concurrent writes simple.
 */

function balanceRef(database: Database, uid: string) {
  return database.ref(`credits/${uid}/balance`);
}

function ledgerRef(database: Database, uid: string) {
  return database.ref(`creditLedger/${uid}`);
}

async function appendLedgerEntry(
  database: Database,
  uid: string,
  entry: CreditLedgerEntry,
): Promise<void> {
  await ledgerRef(database, uid).push().set(creditLedgerEntrySchema.parse(entry));
}

/** Current credit balance for `uid`; 0 when the uid has never had a ledger entry. */
export async function getBalance(database: Database, uid: string): Promise<number> {
  const snapshot = await balanceRef(database, uid).get();
  if (!snapshot.exists()) {
    return 0;
  }
  const value = snapshot.val();
  return typeof value === 'number' ? value : 0;
}

/**
 * Credits a purchased pack onto `uid`'s balance and appends a `purchase`
 * ledger entry. `ref` is the Stripe checkout session id — the webhook
 * handler's idempotency guard (`processedStripeEvents/{eventId}`) is what
 * actually prevents double-crediting a replayed Stripe event; this function
 * itself is a plain add, matching the webhook's single-writer nature.
 */
export async function addCredits(
  database: Database,
  uid: string,
  amount: number,
  ref: string,
): Promise<void> {
  const current = await getBalance(database, uid);
  await balanceRef(database, uid).set(current + amount);
  await appendLedgerEntry(database, uid, {
    type: 'purchase',
    amount,
    createdAt: Date.now(),
    ref,
  });
}

/**
 * Atomically spends one credit for `uid` via an RTDB transaction on the
 * balance node, so concurrent report-generation requests from the same uid
 * can't both observe a positive balance and double-spend. Returns `false`
 * (no-op, no ledger entry) when the balance is already 0; `true` and appends
 * a `spend` ledger entry otherwise.
 */
export async function spendCredit(database: Database, uid: string, ref: string): Promise<boolean> {
  const result = await balanceRef(database, uid).transaction((current) => {
    const balance = typeof current === 'number' ? current : 0;
    if (balance <= 0) {
      // Aborts the transaction — no write happens.
      return undefined;
    }
    return balance - 1;
  });

  if (!result.committed) {
    return false;
  }

  await appendLedgerEntry(database, uid, {
    type: 'spend',
    amount: -1,
    createdAt: Date.now(),
    ref,
  });
  return true;
}

/**
 * Refunds one credit to `uid` after a failed generation (every failure path
 * after `spendCredit` succeeded must call this — see `routes/reports.ts`).
 * A plain add is safe here without a transaction: refunds only ever follow a
 * spend the caller itself just made, so there's no concurrent-refund race to
 * guard against for a single request.
 */
export async function refundCredit(database: Database, uid: string, ref: string): Promise<void> {
  const current = await getBalance(database, uid);
  await balanceRef(database, uid).set(current + 1);
  await appendLedgerEntry(database, uid, {
    type: 'refund',
    amount: 1,
    createdAt: Date.now(),
    ref,
  });
}

/**
 * Idempotency guard for Stripe webhook deliveries: Stripe retries delivery
 * on any non-2xx/timeout response, so the same `checkout.session.completed`
 * event can arrive more than once. Returns `true` (and marks the event
 * processed) the first time `eventId` is seen; `false` for a replay, which
 * the webhook route treats as a no-op success.
 */
export async function markStripeEventProcessed(
  database: Database,
  eventId: string,
): Promise<boolean> {
  const ref = database.ref(`processedStripeEvents/${eventId}`);
  const result = await ref.transaction((current) => {
    if (current !== null && current !== undefined) {
      // Already processed — abort, no write.
      return undefined;
    }
    return Date.now();
  });
  return result.committed;
}
