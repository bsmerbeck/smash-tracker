import type { Database } from 'firebase-admin/database';
import {
  creditLedgerEntrySchema,
  CREDIT_PACKS,
  type CreditLedgerEntry,
} from '@smash-tracker/shared';
import { createEvent, dayShardKey } from '../events/ledger.js';
import { buildBillingEnvelope } from '../events/envelope.js';

/**
 * V7-C: RTDB credit ledger backing the Stripe-powered report-generation
 * paywall. RTDB layout (see `packages/shared/src/billing.ts`):
 *
 * - `credits/{uid}/balance`         -> number (int, >= 0)
 * - `creditLedger/{uid}/{pushKey}`  -> creditLedgerEntrySchema
 * - `creditLedgerByDay/{yyyymmdd}/{uid}/{pushKey}` -> creditLedgerEntrySchema (mirror)
 * - `processedStripeEvents/{eventId}` -> number (epoch ms, webhook idempotency guard)
 * - `processedStripeEventsByDay/{yyyymmdd}/{eventId}` -> true (mirror)
 *
 * BILL-01/BILL-02 (Phase 10): every mutator here is now transaction-safe.
 * `addCredits`/`refundCredit`/`spendCredit` all increment the balance node
 * via `Reference.transaction()` — CR-01 discipline applies throughout:
 * `null`/`undefined` on a transaction's first pass means "not yet
 * initialized," never a permanent-abort condition (a fresh uid's first-ever
 * grant/refund is a legitimate null start). `fulfillCheckoutSession()` is
 * the converged Stripe-fulfillment entry point: it dedups via
 * `markStripeEventProcessed`'s transaction, then performs ONE root-level
 * multi-path `update()` that atomically closes the mark+grant+ledger+
 * day-mirror write together — the specific gap this replaces (a separate
 * `markStripeEventProcessed()` call followed by a non-atomic `addCredits()`)
 * could otherwise leave an event marked-processed with no credit ever
 * granted if the process crashed between the two calls.
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
 * ledger entry. `ref` is the Stripe checkout session id (or, for the
 * converged webhook path, the Stripe event id — see `fulfillCheckoutSession`
 * below, which is what production actually calls). Transaction-safe
 * (BILL-02): concurrent calls for the same uid converge on the sum of both
 * grants — no lost update — and a fresh uid's null-first-run balance is
 * treated as 0, never a permanent-abort condition.
 */
export async function addCredits(
  database: Database,
  uid: string,
  amount: number,
  ref: string,
): Promise<void> {
  await balanceRef(database, uid).transaction((current) =>
    typeof current === 'number' ? current + amount : amount,
  );
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
 * a `spend` ledger entry otherwise. Emits one `credit_spent` B event per
 * successful spend (BILL-05/MEAS-03), deduped on `${ref}:credit_spent`.
 */
export async function spendCredit(database: Database, uid: string, ref: string): Promise<boolean> {
  const result = await balanceRef(database, uid).transaction((current) => {
    if (current === null || current === undefined) {
      // Real RTDB runs this against the SDK's LOCAL CACHE first — `null` on
      // a listener-less server even when a positive balance exists (review
      // CR-01's abort-on-null-first-run class). Aborting here would be
      // permanent (no server-verified retry), 402ing users who hold
      // credits. Returning the input unchanged instead forces the hash
      // compare: a no-op commit when the balance node truly doesn't exist
      // (detected below via the committed snapshot), or a retry with the
      // real balance.
      return current;
    }
    const balance = typeof current === 'number' ? current : 0;
    if (balance <= 0) {
      // Verified-zero balance — abort, no write happens.
      return undefined;
    }
    return balance - 1;
  });

  if (!result.committed) {
    return false;
  }
  if (typeof result.snapshot.val() !== 'number') {
    // The commit was the null-input no-op (balance node never existed) —
    // nothing was spent.
    return false;
  }

  await appendLedgerEntry(database, uid, {
    type: 'spend',
    amount: -1,
    createdAt: Date.now(),
    ref,
  });

  void createEvent(
    database,
    buildBillingEnvelope({
      eventName: 'credit_spent',
      source: 'job',
      actorId: uid,
      sessionId: uid,
      causationId: `${ref}:credit_spent`,
      consentState: 'unknown',
      payload: { amount: -1 },
    }),
  );

  return true;
}

/**
 * Refunds one credit to `uid` after a failed generation (every failure path
 * after `spendCredit` succeeded must call this — see `routes/reports.ts`).
 * Transaction-safe (BILL-02): treats a null balance as 0 (a first-ever
 * refund for a uid is a legitimate null start, not an abort condition) and
 * converges correctly under concurrent grant/spend/refund activity. Emits
 * one `credit_refunded` B event per refund (BILL-05/MEAS-03), deduped on
 * `${ref}:credit_refunded`.
 */
export async function refundCredit(database: Database, uid: string, ref: string): Promise<void> {
  await balanceRef(database, uid).transaction((current) =>
    typeof current === 'number' ? current + 1 : 1,
  );
  await appendLedgerEntry(database, uid, {
    type: 'refund',
    amount: 1,
    createdAt: Date.now(),
    ref,
  });

  void createEvent(
    database,
    buildBillingEnvelope({
      eventName: 'credit_refunded',
      source: 'job',
      actorId: uid,
      sessionId: uid,
      causationId: `${ref}:credit_refunded`,
      consentState: 'unknown',
      payload: { amount: 1 },
    }),
  );
}

/**
 * Idempotency guard for Stripe webhook deliveries: Stripe retries delivery
 * on any non-2xx/timeout response, so the same fulfilling event can arrive
 * more than once. Returns `true` (and marks the event processed) the first
 * time `eventId` is seen; `false` for a replay, which the caller treats as a
 * no-op success. Reused as the dedup gate inside `fulfillCheckoutSession`.
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

/** Minimal structural seam over the fields `fulfillCheckoutSession` needs from a Stripe Checkout Session. */
export interface FulfillableCheckoutSession {
  id: string;
  metadata?: { uid?: string; packId?: string } | null;
}

/**
 * BILL-01/BILL-03/BILL-04/BILL-05: the converged, atomic Stripe-fulfillment
 * entry point. Called from every webhook branch that should grant credits
 * (`checkout.session.completed` with `payment_status === 'paid'`,
 * `checkout.session.async_payment_succeeded`) — never from
 * `async_payment_failed`.
 *
 * 1. Resolves `uid`/`pack` from `session.metadata` — missing/unknown
 *    metadata is a no-op (`{ granted: false }`), same as the pre-hardening
 *    behavior, and never burns the dedup marker.
 * 2. Dedups via `markStripeEventProcessed`'s transaction on
 *    `processedStripeEvents/{stripeEventId}` — a replayed/duplicate-delivered
 *    event returns `{ granted: false }` with no second grant.
 * 3. On a fresh event, issues ONE root-level multi-path `update()` writing
 *    the `processedStripeEvents` marker, its day-mirror, the balance
 *    increment, the `creditLedger` entry, and its day-mirror together — so
 *    the grant and its ledger trail commit as a single atomic unit (the day
 *    mirrors feed the nightly reconciliation job from a later plan).
 * 4. Emits one `credits_granted` B event, deduped on
 *    `${stripeEventId}:credits_granted`.
 */
export async function fulfillCheckoutSession(
  database: Database,
  session: FulfillableCheckoutSession,
  stripeEventId: string,
): Promise<{ granted: boolean }> {
  const uid = session.metadata?.uid;
  const packId = session.metadata?.packId;
  const pack = CREDIT_PACKS.find((candidate) => candidate.id === packId);
  if (!uid || !pack) {
    return { granted: false };
  }

  const shouldProcess = await markStripeEventProcessed(database, stripeEventId);
  if (!shouldProcess) {
    return { granted: false };
  }

  const current = await getBalance(database, uid);
  const day = dayShardKey(Date.now());
  const key = ledgerRef(database, uid).push().key;
  if (!key) {
    throw new Error('Failed to allocate a creditLedger push key');
  }

  const now = Date.now();
  const ledgerEntry = creditLedgerEntrySchema.parse({
    type: 'purchase' as const,
    amount: pack.credits,
    createdAt: now,
    ref: stripeEventId,
  });

  await database.ref().update({
    [`processedStripeEvents/${stripeEventId}`]: now,
    [`processedStripeEventsByDay/${day}/${stripeEventId}`]: true,
    [`credits/${uid}/balance`]: current + pack.credits,
    [`creditLedger/${uid}/${key}`]: ledgerEntry,
    [`creditLedgerByDay/${day}/${uid}/${key}`]: ledgerEntry,
  });

  void createEvent(
    database,
    buildBillingEnvelope({
      eventName: 'credits_granted',
      source: 'stripe',
      actorId: uid,
      sessionId: uid,
      causationId: `${stripeEventId}:credits_granted`,
      consentState: 'unknown',
      payload: { packId: pack.id, credits: pack.credits },
    }),
  );

  return { granted: true };
}
