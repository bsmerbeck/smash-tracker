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
 * - `creditBundleOps/{uid}/{bundleId}` -> { status, amount, createdAt, updatedAt } (durable
 *   operation marker guarding `spendCredits`' N-credit bundle debits against replay/concurrency)
 *
 * BILL-01/BILL-02 (Phase 10): every mutator here is now transaction-safe.
 * `addCredits`/`refundCredit`/`spendCredit` all increment the balance node
 * via `Reference.transaction()` — CR-01 discipline applies throughout:
 * `null`/`undefined` on a transaction's first pass means "not yet
 * initialized," never a permanent-abort condition (a fresh uid's first-ever
 * grant/refund is a legitimate null start). `fulfillCheckoutSession()` is
 * the Stripe-fulfillment entry point (code review R7-CR-03): ONE transaction
 * on `credits/{uid}` ADDS the pack's credits and writes a create-once grant
 * marker holding a fixed ledger key, then ONE idempotent root-level
 * multi-path `update()` writes the processed marker, its day mirror and the
 * ledger entry at that key with its day mirror — so a Stripe re-delivery
 * after any failure completes the same grant exactly once.
 *
 * - `credits/{uid}/grantMarkers/{stripeEventId}` -> { ledgerKey, createdAt, credits }
 *   (create-once grant markers, kept `GRANT_MARKER_RETENTION_MS`)
 * - `credits/{uid}/refundMarkers/{jobId:executionId}` -> { ledgerKey, createdAt }
 *   (create-once refund markers, kept 24 h)
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

/** The child of `credits/{uid}` holding `refundCreditOnce`'s create-once markers, one per refunded execution. */
export const REFUND_MARKERS_KEY = 'refundMarkers';

/**
 * Code review R6-IN-02 (iteration 6): how long a refund marker is kept. A
 * marker only has to outlive its own request's bounded retries and a
 * reconnect replay; nothing else reads the map, and every refund
 * transaction downloads and rewrites all of it.
 */
const REFUND_MARKER_RETENTION_MS = 24 * 60 * 60 * 1000;

interface RefundMarker {
  ledgerKey: string;
  createdAt: number;
}

/**
 * Code review R5-WR-01 (iteration 5): `refundCredit` made SAFE TO RETRY. The
 * balance increment and a create-once marker keyed on `markerKey` (one per
 * job execution) are written in ONE transaction on `credits/{uid}` — the
 * node that holds the balance — so the refund either commits with its
 * marker or not at all. A retry after a throw (a transient error, or a
 * commit whose acknowledgement was lost) finds the marker and adds nothing:
 * it can never refund twice. The marker also carries the ledger entry's key and
 * timestamp, so the ledger write is an idempotent `set` on a fixed key and
 * a retry rewrites the same entry instead of appending a second one.
 *
 * Returns true when this call committed the balance increment, false when
 * the marker already existed (an earlier attempt refunded). Code review
 * R6-IN-02: the same transaction drops every OTHER marker older than
 * `REFUND_MARKER_RETENTION_MS`, so the map cannot grow without bound; this
 * execution's own marker is checked first, so it never refunds again however
 * old that marker is.
 * A null first-run
 * input (the SDK's local cache on a listener-less server) is treated as an
 * empty node: the transaction's server compare re-runs it against the real
 * node, so it never overwrites an existing balance.
 *
 * Code review R7-CR-01 (iteration 7): an ABORT is not proof of an earlier
 * refund. The client runs a transaction's first pass against its LOCAL state,
 * which includes another pending attempt's unacknowledged marker. Had that
 * pass aborted, the client would complete with `committed === false` and the
 * local snapshot WITHOUT contacting the server — and if the pending attempt
 * were then aborted (a dropped socket), its marker would be reverted and the
 * balance would never move. (A `get()` does not help: it answers from the
 * client's event cache, which holds the pending write too.) So the update
 * never aborts: when the marker is already there it returns the node
 * UNCHANGED, a no-op the server's hash compare confirms — or, when the marker
 * was only a pending local write that got reverted, rejects as stale, so the
 * update re-runs against the real node and refunds. Every outcome is thus a
 * server-confirmed commit, and the committed marker's ledger key says whether
 * THIS call's run placed it.
 */
export async function refundCreditOnce(
  database: Database,
  uid: string,
  ref: string,
  markerKey: string,
): Promise<boolean> {
  const ledgerKey = ledgerRef(database, uid).push().key;
  if (!ledgerKey) {
    throw new Error('Failed to allocate a creditLedger push key');
  }
  const createdAt = Date.now();
  const result = await database.ref(`credits/${uid}`).transaction((current) => {
    const node =
      current !== null && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    const markers =
      node[REFUND_MARKERS_KEY] !== null && typeof node[REFUND_MARKERS_KEY] === 'object'
        ? (node[REFUND_MARKERS_KEY] as Record<string, unknown>)
        : {};
    if (Object.prototype.hasOwnProperty.call(markers, markerKey)) {
      // Already refunded by an earlier attempt: write nothing new, but commit
      // the node unchanged so the server confirms the marker (R7-CR-01).
      return current;
    }
    const retained = Object.fromEntries(
      Object.entries(markers).filter(([, marker]) => {
        const markerCreatedAt = (marker as Partial<RefundMarker> | null)?.createdAt;
        return !(
          typeof markerCreatedAt === 'number' &&
          markerCreatedAt < createdAt - REFUND_MARKER_RETENTION_MS
        );
      }),
    );
    const balance = typeof node.balance === 'number' ? node.balance : 0;
    return {
      ...node,
      balance: balance + 1,
      [REFUND_MARKERS_KEY]: {
        ...retained,
        [markerKey]: { ledgerKey, createdAt } satisfies RefundMarker,
      },
    };
  });
  const settled = result.snapshot.val() as {
    [REFUND_MARKERS_KEY]?: Record<string, RefundMarker>;
  } | null;
  const marker = result.committed ? settled?.[REFUND_MARKERS_KEY]?.[markerKey] : undefined;
  if (!marker) {
    throw new Error('refund marker not confirmed by the server after the refund transaction');
  }

  await database.ref(`creditLedger/${uid}/${marker.ledgerKey}`).set(
    creditLedgerEntrySchema.parse({
      type: 'refund',
      amount: 1,
      createdAt: marker.createdAt,
      ref,
    }),
  );

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

  return marker.ledgerKey === ledgerKey;
}

/** Minimal structural seam over the fields `fulfillCheckoutSession` needs from a Stripe Checkout Session. */
export interface FulfillableCheckoutSession {
  id: string;
  metadata?: { uid?: string; packId?: string } | null;
}

/** The child of `credits/{uid}` holding `fulfillCheckoutSession`'s create-once grant markers, one per Stripe event. */
export const GRANT_MARKERS_KEY = 'grantMarkers';

/**
 * Code review R7-CR-03 (iteration 7): how long a grant marker is kept. A
 * marker is what makes a Stripe re-delivery of the same event grant nothing
 * twice while the trail below is still incomplete, so it must outlive every
 * delivery Stripe can make: automatic retries run for up to 3 days, and an
 * event can be re-sent by hand for as long as Stripe keeps it (30 days). It
 * is NOT the 24 h refund-marker window (`REFUND_MARKER_RETENTION_MS`). After
 * the trail completes, the permanent `processedStripeEvents/{id}` answers a
 * re-delivery first.
 */
export const GRANT_MARKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface GrantMarker {
  ledgerKey: string;
  createdAt: number;
  credits: number;
}

/**
 * BILL-01/BILL-03/BILL-04/BILL-05: the Stripe-fulfillment entry point. Called
 * from every webhook branch that should grant credits
 * (`checkout.session.completed` with `payment_status === 'paid'`,
 * `checkout.session.async_payment_succeeded`) — never from
 * `async_payment_failed`.
 *
 * Code review R7-CR-03 (iteration 7): the grant is create-once and SAFE TO
 * RETRY, the same way `refundCreditOnce` is. Stripe answers a 5xx or a
 * timeout by delivering the same event again, so the grant must survive any
 * failure at any point and be completed — exactly once — by a later delivery:
 *
 * 1. Resolves `uid`/`pack` from `session.metadata` — missing/unknown
 *    metadata is a no-op (`{ granted: false }`), same as the pre-hardening
 *    behavior.
 * 2. Fast path: a delivery whose `processedStripeEvents/{id}` already exists
 *    returns `{ granted: false }`. That marker is written only in step 4,
 *    after the grant committed, so it never gates a grant that has not
 *    happened (the iteration-6 flaw: the dedup marker committed FIRST, a
 *    grant transaction aborted by a dropped socket then failed the webhook,
 *    and Stripe's retry was deduped — the buyer paid and got nothing). It
 *    also answers events granted before this deploy, which carry no grant
 *    marker.
 * 3. ONE transaction on `credits/{uid}` ADDS `pack.credits` to the balance
 *    and writes a create-once grant marker `grantMarkers/{stripeEventId}`
 *    holding a fixed, pre-allocated ledger key, its timestamp and the credit
 *    count — so the grant commits with its marker or not at all. Being a
 *    transaction, it re-runs against whatever committed first, so a refund
 *    or a spend from another process is never overwritten (R6-WR-06). When
 *    the marker is already there it returns the node UNCHANGED instead of
 *    aborting, so the outcome is always a server-confirmed commit: an abort
 *    would complete from the client's local state, which can hold another
 *    delivery's unacknowledged (and revertible) marker (see
 *    `refundCreditOnce`, R7-CR-01). Other grant markers older than
 *    `GRANT_MARKER_RETENTION_MS` are dropped in the same write.
 * 4. Then ONE idempotent root-level multi-path `update()` writes the
 *    `processedStripeEvents` marker, its day mirror, and the `creditLedger`
 *    entry at the marker's ledger key with its day mirror — every value taken
 *    from the marker, so a retry rewrites the same bytes and never appends a
 *    second entry (the day mirrors feed the nightly reconciliation job). It
 *    touches nothing under `credits/`, so it cannot abort an in-flight
 *    transaction there.
 * 5. Emits one `credits_granted` B event, deduped on
 *    `${stripeEventId}:credits_granted`.
 *
 * If the process stops between steps 3 and 4, the balance holds the credits
 * and the trail is missing until Stripe re-delivers the event (the webhook
 * never answered 2xx), which completes it from the marker. Reconciliation
 * cannot see that window — it cross-checks the day mirrors against the event
 * ledger, and neither exists yet — so Stripe's re-delivery is what closes it.
 *
 * Returns `{ granted: true }` when this delivery granted the pack or
 * completed the trail of a grant an earlier delivery committed; the events
 * that drives are deduped on the Stripe event id.
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

  if ((await database.ref(`processedStripeEvents/${stripeEventId}`).get()).exists()) {
    return { granted: false };
  }

  const ledgerKey = ledgerRef(database, uid).push().key;
  if (!ledgerKey) {
    throw new Error('Failed to allocate a creditLedger push key');
  }
  const createdAt = Date.now();
  const result = await database.ref(`credits/${uid}`).transaction((current) => {
    const node =
      current !== null && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    const markers =
      node[GRANT_MARKERS_KEY] !== null && typeof node[GRANT_MARKERS_KEY] === 'object'
        ? (node[GRANT_MARKERS_KEY] as Record<string, unknown>)
        : {};
    if (Object.prototype.hasOwnProperty.call(markers, stripeEventId)) {
      // Already granted by an earlier delivery: add nothing, but commit the
      // node unchanged so the server confirms the marker (R7-CR-03).
      return current;
    }
    const retained = Object.fromEntries(
      Object.entries(markers).filter(([, marker]) => {
        const markerCreatedAt = (marker as Partial<GrantMarker> | null)?.createdAt;
        return !(
          typeof markerCreatedAt === 'number' &&
          markerCreatedAt < createdAt - GRANT_MARKER_RETENTION_MS
        );
      }),
    );
    const balance = typeof node.balance === 'number' ? node.balance : 0;
    return {
      ...node,
      balance: balance + pack.credits,
      [GRANT_MARKERS_KEY]: {
        ...retained,
        [stripeEventId]: { ledgerKey, createdAt, credits: pack.credits } satisfies GrantMarker,
      },
    };
  });
  const settled = result.snapshot.val() as {
    [GRANT_MARKERS_KEY]?: Record<string, GrantMarker>;
  } | null;
  const marker = result.committed ? settled?.[GRANT_MARKERS_KEY]?.[stripeEventId] : undefined;
  if (!marker) {
    throw new Error('grant marker not confirmed by the server after the grant transaction');
  }

  const day = dayShardKey(marker.createdAt);
  const ledgerEntry = creditLedgerEntrySchema.parse({
    type: 'purchase' as const,
    amount: marker.credits,
    createdAt: marker.createdAt,
    ref: stripeEventId,
  });

  await database.ref().update({
    [`processedStripeEvents/${stripeEventId}`]: marker.createdAt,
    [`processedStripeEventsByDay/${day}/${stripeEventId}`]: true,
    [`creditLedger/${uid}/${marker.ledgerKey}`]: ledgerEntry,
    [`creditLedgerByDay/${day}/${uid}/${marker.ledgerKey}`]: ledgerEntry,
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
      payload: { packId: pack.id, credits: marker.credits },
    }),
  );

  return { granted: true };
}

/** Root RTDB collection for `spendCredits`' durable per-bundle operation markers. */
export const CREDIT_BUNDLE_OPS_ROOT = 'creditBundleOps';

function bundleOpRef(database: Database, uid: string, bundleId: string) {
  return database.ref(`${CREDIT_BUNDLE_OPS_ROOT}/${uid}/${bundleId}`);
}

/**
 * The single constructor for the per-slot ref every `spendCredits`-debited
 * bundle child carries as its `creditLedger` `ref` and its later
 * `refundCredit` ref. Uses `:` (not `#`) as the separator: `#` is
 * RTDB-path-illegal and, if it ever reached a ref that becomes a
 * `causationId`, would land as an illegal path segment under `eventDedup`
 * (27-CONTEXT.md line 33). This is the ONE place the slot ref is built —
 * call sites (27-08's bundle orchestration, refund handling) must never
 * hand-concatenate `${bundleId}:${slot}` themselves.
 */
export function bundleSlotRef(bundleId: string, slot: number): string {
  return `${bundleId}:${slot}`;
}

/**
 * The inverse of `bundleSlotRef`: the bundle id a slot ref was built from, or
 * `null` when `ref` is not a slot ref (no `:`, or a suffix that is not a
 * positive slot number). Splits on the LAST `:`, since the slot is always the
 * final segment.
 */
export function bundleIdFromSlotRef(ref: string): string | null {
  const separator = ref.lastIndexOf(':');
  if (separator <= 0 || !/^[1-9]\d*$/.test(ref.slice(separator + 1))) {
    return null;
  }
  return ref.slice(0, separator);
}

/**
 * Code review R2-IN-03: the DURABLE spend fact for a bundle, read from its
 * `creditBundleOps/{uid}/{bundleId}` operation marker. `'debited'` means the
 * bundle's credits were taken (true); `'insufficient'` means no debit
 * happened (false).
 *
 * Code review R3-IN-03 (iteration 3): an ABSENT marker also means no debit
 * (false). `spendCredits` is the only writer of these markers — it writes
 * `'claiming'` before it touches the balance, then `'insufficient'` or
 * `'debited'` — and nothing ever deletes one, so a bundle whose credits were
 * taken always has a marker. A free-access submission writes none.
 *
 * A `'claiming'` marker alone is ambiguous — a process can stop between the
 * balance debit and the marker's `'debited'` write — so it returns `null`.
 */
export async function readBundleSpendFact(
  database: Database,
  uid: string,
  bundleId: string,
): Promise<boolean | null> {
  const marker = (await bundleOpRef(database, uid, bundleId).get()).val() as {
    status?: unknown;
  } | null;
  if (marker?.status === 'debited') {
    return true;
  }
  if (marker === null || marker?.status === 'insufficient') {
    return false;
  }
  return null;
}

export type SpendCreditsOutcome = 'debited' | 'insufficient' | 'alreadyProcessed';

interface CreditBundleOpMarker {
  status: 'claiming' | 'insufficient' | 'debited';
  amount: number;
  createdAt: number;
  updatedAt?: number;
}

/**
 * The narrow, owner-mandated primitive for the 3-credit prep bundle: ONE
 * atomic verify-and-subtract of `amount` credits, guarded by a durable
 * operation marker keyed on `bundleId`, materializing `amount` existing
 * -shaped `-1` ledger entries with RTDB-safe refs. This deliberately does
 * NOT call `spendCredit` `amount` times — three sequential `spendCredit`
 * calls are compensating transactions, not all-or-nothing (the process can
 * crash between debits, concurrent requests can interleave, and
 * `refundCredit` is not balance-idempotent — credits.ts:157-180 increments
 * the balance on every invocation; only its canonical event is deduped).
 * The owner rejected that design outright (27-CONTEXT.md lines 30-41).
 *
 * Two-phase design:
 *
 * **Phase 1 — claim.** A transaction on `creditBundleOps/{uid}/{bundleId}`
 * mirrors the write-on-empty polarity of `createEvent`'s `eventDedup`
 * transaction (`events/ledger.ts`), NOT
 * `spendCredit`'s null-handling (credits.ts:96-107): for a balance, "node
 * does not exist" means "zero credits, do nothing"; for a claim marker it
 * means "nobody has attempted this bundle yet, proceed and claim." Reusing
 * `spendCredit`'s `if (current === null) return current;` branch here would
 * make the FIRST-EVER claim for a bundle a silent permanent no-op — the
 * exact claim-marker polarity inversion trap called out in
 * 27-RESEARCH.md Pitfall 1. `'insufficient'` is the ONE non-terminal marker
 * status: a prior balance failure must remain retryable after a top-up, so
 * the guard explicitly re-opens the claim when the existing marker's status
 * is `'insufficient'`. `'claiming'` is deliberately NEVER auto-expired:
 * `bundleId` is client-generated per purchase click (the same convention as
 * `jobId`), so a stranded claim costs the user nothing — their next click
 * mints a fresh bundleId — whereas a staleness window would reopen the
 * exact double-debit hole this primitive exists to close.
 *
 * **Phase 2 — the single atomic verify-and-subtract.** One
 * `balanceRef(...).transaction()`, parameterized by `amount`, reusing
 * `spendCredit`'s proven shape verbatim: a null/undefined current balance
 * returns the input unchanged (CR-01 discipline — never a permanent abort,
 * forces the hash-compare retry against the real stored balance); a
 * numeric balance below `amount` returns `undefined` (a verified-insufficient
 * abort — no write happens); otherwise returns `balance - amount`.
 *
 * On the insufficient path NOTHING else is written: no ledger entry, no
 * event — only the marker is set to `'insufficient'` so the SAME bundleId
 * can retry after a top-up.
 *
 * **Phase 3 — converged materialization.** On a debit, one root-level
 * multi-path `database.ref().update()` (mirroring `fulfillCheckoutSession`,
 * credits.ts:263-269) writes the terminal `'debited'` marker plus, for each
 * slot `1..amount`, a `creditLedger/{uid}/{pushKey}` entry
 * (`{type:'spend', amount:-1, ref: bundleSlotRef(bundleId, slot)}`).
 * Day-shard mirrors are deliberately NOT written here: the existing
 * `spendCredit` path does not write them either (`appendLedgerEntry`,
 * credits.ts:43-49) — the spend side's ledger shape stays byte-identical so
 * the open Aug-2 reconciliation window is not perturbed. One `credit_spent`
 * B event is emitted per slot afterward, envelope-identical to
 * `spendCredit`'s (credits.ts:132-143), so each slot's spend and its later
 * refund correlate on the same ref. Payload carries only `amount` — no
 * bundleId, entryKey, or opponent name (D-14).
 */
export async function spendCredits(
  database: Database,
  uid: string,
  bundleId: string,
  amount: number,
): Promise<SpendCreditsOutcome> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('spendCredits amount must be a positive integer');
  }

  const claim = await bundleOpRef(database, uid, bundleId).transaction((current) => {
    if (
      current !== null &&
      current !== undefined &&
      (current as CreditBundleOpMarker).status !== 'insufficient'
    ) {
      // Already claimed (claiming or debited, not the retryable
      // insufficient state) — abort, no write happens.
      return undefined;
    }
    return {
      status: 'claiming',
      amount,
      createdAt: Date.now(),
    } satisfies CreditBundleOpMarker;
  });

  if (!claim.committed) {
    return 'alreadyProcessed';
  }

  const claimCreatedAt = (claim.snapshot.val() as CreditBundleOpMarker).createdAt;

  const result = await balanceRef(database, uid).transaction((current) => {
    if (current === null || current === undefined) {
      // See spendCredit's identical CR-01 comment (credits.ts:98-105): the
      // SDK's local cache reads null on a listener-less server even when a
      // positive balance exists server-side. Returning the input unchanged
      // forces the hash-compare retry against the real stored value instead
      // of permanently aborting.
      return current;
    }
    const balance = typeof current === 'number' ? current : 0;
    if (balance < amount) {
      // Verified-insufficient balance — abort, no write happens.
      return undefined;
    }
    return balance - amount;
  });

  const debited = result.committed && typeof result.snapshot.val() === 'number';

  if (!debited) {
    await bundleOpRef(database, uid, bundleId).set({
      status: 'insufficient',
      amount,
      createdAt: claimCreatedAt,
      updatedAt: Date.now(),
    } satisfies CreditBundleOpMarker);
    return 'insufficient';
  }

  const now = Date.now();
  const updates: Record<string, unknown> = {
    [`${CREDIT_BUNDLE_OPS_ROOT}/${uid}/${bundleId}`]: {
      status: 'debited',
      amount,
      createdAt: claimCreatedAt,
      updatedAt: now,
    } satisfies CreditBundleOpMarker,
  };

  for (let slot = 1; slot <= amount; slot += 1) {
    const key = ledgerRef(database, uid).push().key;
    if (!key) {
      throw new Error('Failed to allocate a creditLedger push key');
    }
    updates[`creditLedger/${uid}/${key}`] = creditLedgerEntrySchema.parse({
      type: 'spend',
      amount: -1,
      createdAt: now,
      ref: bundleSlotRef(bundleId, slot),
    });
  }

  await database.ref().update(updates);

  for (let slot = 1; slot <= amount; slot += 1) {
    void createEvent(
      database,
      buildBillingEnvelope({
        eventName: 'credit_spent',
        source: 'job',
        actorId: uid,
        sessionId: uid,
        causationId: `${bundleSlotRef(bundleId, slot)}:credit_spent`,
        consentState: 'unknown',
        payload: { amount: -1 },
      }),
    );
  }

  return 'debited';
}
