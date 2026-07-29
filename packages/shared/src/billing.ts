import { z } from 'zod';
import { entryKeyInputSchema } from './prep.js';

/**
 * V7-C: Stripe-powered credit packs that gate AI report generation
 * (`packages/shared`'s `generatedScoutReportSchema` / apps/api's
 * `POST /api/reports`) for everyone EXCEPT allowlisted uids
 * (`REPORTS_ALLOWED_UIDS`, unchanged from V7-B — those stay free/unlimited,
 * covering the owner's own usage). Everyone else spends one credit per
 * generation and buys more via Stripe Checkout.
 *
 * RTDB layout (see apps/api's `billing/credits.ts` for the read/write layer):
 * - `credits/{uid}/balance`         -> number (int, >= 0)
 * - `creditLedger/{uid}/{pushKey}`  -> creditLedgerEntrySchema
 * - `processedStripeEvents/{eventId}` -> number (epoch ms, webhook idempotency guard)
 * - `processedStripeEventsByDay/{yyyymmdd}/{eventId}` -> true (day-mirror, reconciliation lookups)
 * - `creditLedgerByDay/{yyyymmdd}/{uid}/{pushKey}` -> creditLedgerEntrySchema (day-mirror, reconciliation lookups)
 *
 * Pack constants live here (not buried in a route) specifically so prices/
 * credit counts are a one-line edit away from a future price change —
 * nothing else in the codebase should hardcode a pack's credits or price.
 */
export const CREDIT_PACKS = [
  { id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' },
  { id: 'pack15', credits: 15, amountCents: 2000, label: '15 reports' },
] as const;

export type CreditPack = (typeof CREDIT_PACKS)[number];
export type CreditPackId = CreditPack['id'];

/** Enum of valid pack ids, derived from `CREDIT_PACKS` so the two can't drift. */
export const creditPackIdSchema = z.enum(
  CREDIT_PACKS.map((pack) => pack.id) as [CreditPackId, ...CreditPackId[]],
);

const creditPackSchema = z.object({
  id: creditPackIdSchema,
  credits: z.number().int().positive(),
  amountCents: z.number().int().positive(),
  label: z.string().min(1),
});

/**
 * GET /api/billing/credits response. `freeAccess` mirrors `reportsConfigSchema`'s
 * allowlist check (true = unlimited, `balance` is irrelevant); `packs` is
 * always the full `CREDIT_PACKS` list so the client never hardcodes pricing.
 */
export const creditsStatusSchema = z.object({
  freeAccess: z.boolean(),
  balance: z.number().int().min(0),
  packs: z.array(creditPackSchema),
});
export type CreditsStatus = z.infer<typeof creditsStatusSchema>;

/**
 * Phase 27: the closed set of checkout return destinations. Omitting
 * `returnTo` on the request preserves today's `/scout` behavior
 * byte-for-byte; the server resolves the actual destination from this enum
 * via a fixed template — never from a client-supplied URL (RESEARCH
 * Pitfall 4: never interpolate a raw client value into a redirect URL).
 */
export const checkoutReturnToSchema = z.enum(['scout', 'prep']);
export type CheckoutReturnTo = z.infer<typeof checkoutReturnToSchema>;

/**
 * The ONLY prep marker permitted to travel through Stripe `metadata` and
 * the `checkout_started`/`checkout_completed` canonical event payloads
 * (EVT-05, 27-CONTEXT.md "Placement UX"). The entryKey, opponent names, and
 * provider identities must never appear there.
 */
export const CHECKOUT_PREP_REASON = 'prep_purchase' as const;

/**
 * POST /api/billing/checkout request body. `attemptId` (BILL-03) is a
 * client-generated UUID, stable across retries of the SAME "buy credits"
 * click, fresh for every NEW click — passed through as the Stripe Checkout
 * Session's `idempotencyKey` so a retried create() never spawns a duplicate
 * session. Optional so an un-updated client (deploy-first) never 400s; the
 * server falls back to a per-request UUID when absent.
 *
 * `returnTo`/`entryKey` (Phase 27) extend the checkout flow with a
 * validated return destination so a prep-origin purchase returns to
 * `/tournaments/:entryKey/prep` instead of always returning to `/scout`.
 * The two fields are cross-validated: `returnTo: 'prep'` without an
 * `entryKey` has nowhere to return to, and an `entryKey` without
 * `returnTo: 'prep'` is meaningless and must not be silently accepted.
 */
export const checkoutRequestSchema = z
  .object({
    packId: creditPackIdSchema,
    attemptId: z.string().min(1).optional(),
    returnTo: checkoutReturnToSchema.optional(),
    entryKey: entryKeyInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.returnTo === 'prep' && !value.entryKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'entryKey is required when returnTo is "prep"',
        path: ['entryKey'],
      });
    }
    if (value.entryKey !== undefined && value.returnTo !== 'prep') {
      ctx.addIssue({
        code: 'custom',
        message: 'entryKey requires returnTo: "prep"',
        path: ['returnTo'],
      });
    }
  });
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** POST /api/billing/checkout response — the Stripe-hosted Checkout Session URL to redirect to. */
export const checkoutResponseSchema = z.object({
  url: z.string(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

/**
 * `creditLedger/{uid}/{pushKey}` — an audit trail entry for every credit
 * mutation. `ref` is the Stripe checkout session id for `purchase` entries,
 * or the report/request id for `spend`/`refund` entries (so a refund can be
 * traced back to the spend it reverses).
 */
export const creditLedgerEntrySchema = z.object({
  type: z.enum(['purchase', 'spend', 'refund']),
  /** Positive for purchase/refund, negative for spend. */
  amount: z.number().int(),
  /** Epoch ms. */
  createdAt: z.number(),
  ref: z.string(),
});
export type CreditLedgerEntry = z.infer<typeof creditLedgerEntrySchema>;
