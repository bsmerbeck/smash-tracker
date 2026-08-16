import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  checkoutRequestSchema,
  checkoutResponseSchema,
  creditsStatusSchema,
  errorResponseSchema,
  CREDIT_PACKS,
  CHECKOUT_PREP_REASON,
  DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
  type CheckoutRequest,
} from '@smash-tracker/shared';
import type { ReportsConfig, StripeConfig } from '../config/env.js';
import { fulfillCheckoutSession, getBalance } from '../billing/credits.js';
import { createEvent } from '../events/ledger.js';
import { buildBillingEnvelope, buildDomainEnvelope } from '../events/envelope.js';
// Phase 30.3 (demo-account money safety, Gate 6): the SAME allowlist
// predicate the seven bearer-delivery chokepoints already consult
// (`research/demoAccount.ts`). Read via the `app.demoAccountConfig`
// decoration rather than a new route option, mirroring how
// `routes/shareMeta.ts`/`routes/shareOgImage.ts` reach it.
import { isDemoAccountSubject } from '../research/demoAccount.js';

/**
 * Minimal structural seam over the `stripe` client — just the two calls this
 * plugin makes. Lets tests inject a stub instead of a real `Stripe` instance
 * (which would otherwise require a live secret key / network access).
 */
export interface StripeLikeClient {
  checkout: {
    sessions: {
      create: (
        params: Stripe.Checkout.SessionCreateParams,
        options?: { idempotencyKey?: string },
      ) => Promise<{ id: string; url: string | null }>;
    };
  };
  webhooks: {
    constructEvent: (
      payload: string | Buffer,
      signature: string | string[],
      secret: string,
    ) => Stripe.Event;
  };
}

export interface BillingRoutesOptions {
  stripeConfig: StripeConfig | null;
  reportsConfig: ReportsConfig | null;
  /** SPA origin Checkout redirects back to (`env.WEB_BASE_URL`). */
  webBaseUrl: string;
  /** Overridable Stripe client (tests); a real `Stripe` instance is built when omitted. */
  stripeClient?: StripeLikeClient;
}

interface CheckoutReturnUrls {
  successUrl: string;
  cancelUrl: string;
  /** `CHECKOUT_PREP_REASON` when the prep destination was used, else `null`. */
  prepReason: typeof CHECKOUT_PREP_REASON | null;
}

/**
 * Phase 27 (EVT-05): resolves `POST /billing/checkout`'s `success_url`/
 * `cancel_url` from `body.returnTo` — a CLOSED enum validated by
 * `checkoutRequestSchema` (packages/shared/src/billing.ts) — never from a
 * client-supplied URL, path, or origin. `returnTo`/`entryKey` are never
 * interpolated directly; the prep branch builds both URLs from a FIXED
 * template (open-redirect prevention, 27-RESEARCH.md Pitfall 4). The
 * `entryKey`'s character set was already validated by the shared schema's
 * `entryKeyInputSchema`; `encodeURIComponent` here is defence in depth so it
 * can never expand into more than one path segment (e.g. an encoded `/`).
 *
 * Omitting `returnTo` (or passing `'scout'`) reproduces today's `/scout`
 * URLs byte-for-byte, and returns a `null` prep marker so callers never add
 * the prep marker to Stripe `metadata`/canonical events for a non-prep
 * checkout.
 */
function resolveCheckoutReturnUrls(webBaseUrl: string, body: CheckoutRequest): CheckoutReturnUrls {
  if (body.returnTo === 'prep' && body.entryKey) {
    const encodedEntryKey = encodeURIComponent(body.entryKey);
    return {
      successUrl: `${webBaseUrl}/tournaments/${encodedEntryKey}/prep?billing=success`,
      cancelUrl: `${webBaseUrl}/tournaments/${encodedEntryKey}/prep?billing=cancelled`,
      prepReason: CHECKOUT_PREP_REASON,
    };
  }

  return {
    successUrl: `${webBaseUrl}/scout?billing=success`,
    cancelUrl: `${webBaseUrl}/scout?billing=cancelled`,
    prepReason: null,
  };
}

/**
 * /api/billing — V7-C: Stripe-powered credit packs that gate AI report
 * generation (`routes/reports.ts`) for everyone except `REPORTS_ALLOWED_UIDS`
 * (unchanged free/unlimited allowlist). Requires `stripeConfig` (secret key +
 * webhook signing secret, both present — see `getStripeConfig`); when
 * missing, every `/billing*` route answers 503, same shape `reports.ts` and
 * `scout.ts` use for their own optional dependencies.
 *
 * `POST /billing/webhook` is the one PUBLIC route in this plugin (Stripe
 * calls it directly, no Firebase ID token) and needs the RAW request body to
 * verify `stripe-signature` — the raw-body content-type parser is registered
 * on `app` (this plugin's own encapsulated Fastify context via
 * `fastify.register`), so it does not leak to sibling plugins/routes that
 * still want normal JSON body parsing (see `billing.test.ts` for a test that
 * asserts exactly this).
 *
 * Phase 10 (BILL-01..05): Checkout creation carries a stable per-attempt
 * idempotency key and emits `checkout_started` (D); the webhook converges
 * `checkout.session.completed` (only when `payment_status === 'paid'`),
 * `checkout.session.async_payment_succeeded` (always), and
 * `checkout.session.async_payment_failed` (never) onto ONE atomic
 * fulfillment path (`fulfillCheckoutSession`, `billing/credits.ts`), and
 * emits `checkout_completed` (B) once per granting event.
 */
const billingRoutes: FastifyPluginAsyncZod<BillingRoutesOptions> = async (app, options) => {
  const { stripeConfig, reportsConfig, webBaseUrl } = options;

  if (!stripeConfig) {
    app.all('/billing*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Billing is not enabled on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const stripe: StripeLikeClient = options.stripeClient ?? new Stripe(stripeConfig.secretKey);

  // GET /api/billing/credits — authed.
  app.get(
    '/billing/credits',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: creditsStatusSchema,
        },
      },
    },
    async (request) => {
      // Phase 30.3 (Gate 6): an allowlisted demo account reports
      // `freeAccess: true` for the SAME reason an allowlisted uid does —
      // `POST /api/reports` never debits it (see `hasFreeReportAccess` in
      // `routes/reports.ts`). This is a read-only status projection; the
      // actual refusal lives on `POST /billing/checkout` below.
      const freeAccess =
        (reportsConfig?.allowedUids.has(request.uid) ?? false) ||
        isDemoAccountSubject(app.demoAccountConfig, request.uid);
      const balance = await getBalance(app.firebase.database, request.uid);
      return {
        freeAccess,
        balance,
        packs: CREDIT_PACKS.map((pack) => ({ ...pack })),
      };
    },
  );

  // POST /api/billing/checkout — authed. Creates a Stripe Checkout Session
  // for a credit pack, looked up server-side (NEVER trust a client-supplied
  // amount).
  app.post(
    '/billing/checkout',
    {
      preHandler: app.authenticate,
      schema: {
        body: checkoutRequestSchema,
        response: {
          200: checkoutResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Phase 30.3 (Gate 6, demo-account money safety): load-bearing
      // ordering — this is the FIRST statement in the handler, above the
      // pack lookup, the idempotency-key mint, the Stripe Checkout Session
      // create, and the `checkout_started` emission. A demo account must
      // never be able to reach Stripe at all, so the refusal precedes
      // every external call, every event envelope, every ledger row, and
      // every credit mutation — a refused request leaves the tree
      // byte-identical (`demoMoneyGuards.test.ts` proves the ordering with
      // a create() spy plus a whole-tree emptiness assertion).
      //
      // Deliberately NOT mirrored onto `POST /billing/webhook`: a demo uid
      // can never obtain a Checkout Session in the first place, so a
      // webhook naming one is unreachable — while refusing fulfillment
      // there would strand a genuinely PAID session with no credits, which
      // is the strictly worse failure. See this phase's SUMMARY for the
      // recorded rationale.
      //
      // Phase 30.3 (capture-evidence hardening, item 2): this refusal — and
      // ONLY this one — carries the stable `code`
      // `demo_account_checkout_forbidden`. The Gate-6 probe-capture operator
      // treats that identifier, not the 403 status and not the human
      // `message`, as proof that the APPLICATION refused: a CDN/WAF/proxy 403
      // also leaves the tree untouched and would otherwise seal a vacuous
      // probe. See `DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE` in
      // `packages/shared/src/error.ts` for why the code is confined to this
      // authenticated, self-addressed path and must NOT be added to the
      // deliberately indistinguishable coaching-delivery or public
      // bearer-token refusals.
      if (isDemoAccountSubject(app.demoAccountConfig, request.uid)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Credit purchases are not available for this account',
          statusCode: 403,
          code: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
        });
      }

      const pack = CREDIT_PACKS.find((candidate) => candidate.id === request.body.packId);
      if (!pack) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Unknown credit pack',
          statusCode: 400,
        });
      }

      // BILL-03: a stable per-attempt idempotency key — the client-supplied
      // attemptId when present (stable across retries of the SAME click),
      // else a per-request fallback UUID for un-updated clients.
      const idempotencyKey = request.body.attemptId ?? randomUUID();

      const { successUrl, cancelUrl, prepReason } = resolveCheckoutReturnUrls(
        webBaseUrl,
        request.body,
      );

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: 'usd',
                unit_amount: pack.amountCents,
                product_data: {
                  name: `grandfinals.gg — AI report credits (${pack.label})`,
                },
              },
              quantity: 1,
            },
          ],
          client_reference_id: request.uid,
          // EVT-05: only the enum prep marker ever crosses into Stripe
          // metadata — never the entryKey, an opponent name, or a provider
          // identity (27-CONTEXT.md "Placement UX").
          metadata: {
            uid: request.uid,
            packId: pack.id,
            ...(prepReason ? { prepReason } : {}),
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
        { idempotencyKey },
      );

      if (!session.url) {
        throw new Error('Stripe Checkout Session was created without a url');
      }

      void createEvent(
        app.firebase.database,
        buildDomainEnvelope({
          eventName: 'checkout_started',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: session.id,
          consentState: 'unknown',
          payload: { packId: pack.id, ...(prepReason ? { prepReason } : {}) },
        }),
      );

      return { url: session.url };
    },
  );

  // POST /api/billing/webhook — PUBLIC (Stripe calls this directly).
  // Registered in its own nested plugin scope so the raw-body content-type
  // parser below applies ONLY to this route, not to sibling JSON routes like
  // POST /billing/checkout above — Fastify content-type parsers are
  // encapsulated per-plugin-context, and `app.register` creates a new child
  // context (see billing.test.ts for a test asserting the isolation holds).
  await app.register(async (webhookScope: FastifyInstance) => {
    // Fastify parses JSON by default; `stripe.webhooks.constructEvent` needs
    // the RAW bytes to verify the signature, so re-register the
    // 'application/json' parser here to hand back the raw buffer untouched.
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // BILL-01/BILL-04/BILL-05: resolves uid/packId (for logging/eventing),
    // then delegates to the converged atomic `fulfillCheckoutSession` —
    // called from every branch below that should grant credits. Emits
    // `checkout_completed` (B) exactly once per granting event.
    async function fulfillAndAck(
      request: FastifyRequest,
      reply: FastifyReply,
      event: Stripe.Event,
      session: Stripe.Checkout.Session,
    ) {
      const uid = session.metadata?.uid;
      const packId = session.metadata?.packId;
      // 2026-08-03 walkthrough P2 (EVT-05): the prep marker must survive the
      // full checkout lifecycle — `checkout_started` carried it but the
      // webhook's `checkout_completed` dropped it, making completed prep
      // conversions indistinguishable from Scout-origin checkouts. Only the
      // exact validated enum passes through; anything else is omitted
      // (conditional-spread — never an undefined own-property).
      const sessionPrepReason = session.metadata?.prepReason;
      const prepReason = sessionPrepReason === CHECKOUT_PREP_REASON ? sessionPrepReason : undefined;
      const pack = CREDIT_PACKS.find((candidate) => candidate.id === packId);

      if (!uid || !pack) {
        request.log.error(
          { eventId: event.id, uid, packId },
          'Stripe checkout fulfillment missing uid/packId metadata or unknown pack',
        );
        return reply.code(200).send();
      }

      const { granted } = await fulfillCheckoutSession(app.firebase.database, session, event.id);
      if (granted) {
        void createEvent(
          app.firebase.database,
          buildBillingEnvelope({
            eventName: 'checkout_completed',
            source: 'stripe',
            actorId: uid,
            sessionId: uid,
            causationId: `${event.id}:checkout_completed`,
            consentState: 'unknown',
            payload: { packId: pack.id, ...(prepReason ? { prepReason } : {}) },
          }),
        );
      }

      return reply.code(200).send();
    }

    webhookScope.post('/billing/webhook', async (request, reply) => {
      const signature = request.headers['stripe-signature'];
      if (!signature) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing stripe-signature header',
          statusCode: 400,
        });
      }

      const rawBody = request.body;
      if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing request body',
          statusCode: 400,
        });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, stripeConfig.webhookSecret);
      } catch (err) {
        request.log.warn({ err }, 'Stripe webhook signature verification failed');
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid Stripe webhook signature',
          statusCode: 400,
        });
      }

      // BILL-04: sync (card) and async (e.g. bank debit/redirect) payment
      // methods converge on one fulfillment path — `checkout.session.completed`
      // fires for BOTH, but only actually means "paid" for sync methods
      // (`payment_status === 'paid'`); async methods settle later via
      // `async_payment_succeeded`/`async_payment_failed`.
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.payment_status !== 'paid') {
            // Async payment still pending settlement — a later
            // async_payment_succeeded/async_payment_failed event decides
            // the outcome. Acknowledge without granting.
            return reply.code(200).send();
          }
          return fulfillAndAck(request, reply, event, session);
        }
        case 'checkout.session.async_payment_succeeded': {
          const session = event.data.object as Stripe.Checkout.Session;
          return fulfillAndAck(request, reply, event, session);
        }
        case 'checkout.session.async_payment_failed': {
          const session = event.data.object as Stripe.Checkout.Session;
          request.log.warn(
            { eventId: event.id, sessionId: session.id },
            'Stripe checkout.session.async_payment_failed — no credits granted',
          );
          return reply.code(200).send();
        }
        default:
          // Unknown/irrelevant event types are acknowledged, not treated as errors.
          return reply.code(200).send();
      }
    });
  });
};

export default billingRoutes;
