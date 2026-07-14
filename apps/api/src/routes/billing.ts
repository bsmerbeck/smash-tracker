import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  checkoutRequestSchema,
  checkoutResponseSchema,
  creditsStatusSchema,
  errorResponseSchema,
  CREDIT_PACKS,
} from '@smash-tracker/shared';
import type { ReportsConfig, StripeConfig } from '../config/env.js';
import { addCredits, getBalance, markStripeEventProcessed } from '../billing/credits.js';

/**
 * Minimal structural seam over the `stripe` client — just the two calls this
 * plugin makes. Lets tests inject a stub instead of a real `Stripe` instance
 * (which would otherwise require a live secret key / network access).
 */
export interface StripeLikeClient {
  checkout: {
    sessions: {
      create: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ url: string | null }>;
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
      const freeAccess = reportsConfig?.allowedUids.has(request.uid) ?? false;
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
        },
      },
    },
    async (request, reply) => {
      const pack = CREDIT_PACKS.find((candidate) => candidate.id === request.body.packId);
      if (!pack) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Unknown credit pack',
          statusCode: 400,
        });
      }

      const session = await stripe.checkout.sessions.create({
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
        metadata: { uid: request.uid, packId: pack.id },
        success_url: `${webBaseUrl}/scout?billing=success`,
        cancel_url: `${webBaseUrl}/scout?billing=cancelled`,
      });

      if (!session.url) {
        throw new Error('Stripe Checkout Session was created without a url');
      }

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

      if (event.type !== 'checkout.session.completed') {
        // Unknown/irrelevant event types are acknowledged, not treated as errors.
        return reply.code(200).send();
      }

      const session = event.data.object as Stripe.Checkout.Session;
      const uid = session.metadata?.uid;
      const packId = session.metadata?.packId;
      const pack = CREDIT_PACKS.find((candidate) => candidate.id === packId);

      if (!uid || !pack) {
        request.log.error(
          { eventId: event.id, uid, packId },
          'Stripe checkout.session.completed missing uid/packId metadata or unknown pack',
        );
        return reply.code(200).send();
      }

      const shouldProcess = await markStripeEventProcessed(app.firebase.database, event.id);
      if (!shouldProcess) {
        // Replayed delivery of an event we've already credited — no-op.
        return reply.code(200).send();
      }

      await addCredits(app.firebase.database, uid, pack.credits, event.id);

      return reply.code(200).send();
    });
  });
};

export default billingRoutes;
