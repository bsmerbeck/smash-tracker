import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { ReportsConfig, StripeConfig } from '../config/env.js';
import type { StripeLikeClient } from './billing.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk-test-123',
  webhookSecret: 'whsec-test-456',
};

const REPORTS_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-anthropic-test',
  allowedUids: new Set(['someone-else']),
};

const FREE_REPORTS_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-anthropic-test',
  allowedUids: new Set([TEST_UID]),
};

function stubStripeClient(overrides: Partial<StripeLikeClient> = {}): StripeLikeClient {
  return {
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: 'https://checkout.stripe.com/session/test' })),
      },
    },
    webhooks: {
      constructEvent: vi.fn(() => {
        throw new Error('constructEvent stub not configured for this test');
      }),
    },
    ...overrides,
  };
}

function makeCheckoutCompletedEvent(overrides: {
  id?: string;
  uid?: string;
  packId?: string;
}): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_test_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        metadata: {
          uid: overrides.uid ?? TEST_UID,
          packId: overrides.packId ?? 'pack5',
        },
      },
    },
  } as unknown as Stripe.Event;
}

describe('/api/billing (unconfigured)', () => {
  it('answers 503 on GET /billing/credits when stripe config is missing', async () => {
    const { app } = buildTestApp({ reports: REPORTS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/credits',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 on POST /billing/checkout when stripe config is missing', async () => {
    const { app } = buildTestApp({ reports: REPORTS_CONFIG });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(),
      payload: { packId: 'pack5' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 on POST /billing/webhook when stripe config is missing', async () => {
    const { app } = buildTestApp({ reports: REPORTS_CONFIG });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'anything', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('GET /api/billing/credits (configured)', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient(),
    });
    const response = await app.inject({ method: 'GET', url: '/api/billing/credits' });
    expect(response.statusCode).toBe(401);
  });

  it('reports freeAccess: true and packs for an allowlisted uid, ignoring balance', async () => {
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: FREE_REPORTS_CONFIG,
      stripeClient: stubStripeClient(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/credits',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.freeAccess).toBe(true);
    expect(body.balance).toBe(0);
    expect(body.packs).toEqual([
      { id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' },
      { id: 'pack15', credits: 15, amountCents: 2000, label: '15 reports' },
    ]);
  });

  it('reports freeAccess: false and the current balance for a non-allowlisted uid', async () => {
    const { app, database } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient(),
    });
    database.seed(`credits/${TEST_UID}/balance`, 3);

    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/credits',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freeAccess: false, balance: 3 });
  });

  it('reports freeAccess: false when reportsConfig is entirely absent', async () => {
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      stripeClient: stubStripeClient(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/credits',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freeAccess: false, balance: 0 });
  });
});

describe('POST /api/billing/checkout (configured)', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { packId: 'pack5' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown packId with 400', async () => {
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(),
      payload: { packId: 'pack1000' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('looks up the pack server-side and creates a Checkout Session with the correct params, ignoring any client amount', async () => {
    const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({
      url: 'https://checkout.stripe.com/session/abc',
      params,
    }));
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      webBaseUrl: 'https://app.example.com',
      stripeClient: stubStripeClient({
        checkout: { sessions: { create } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(),
      // Even if a client tried to sneak in an amount, the body schema only
      // accepts packId — this also documents that intent.
      payload: { packId: 'pack15' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://checkout.stripe.com/session/abc' });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      mode: 'payment',
      client_reference_id: TEST_UID,
      metadata: { uid: TEST_UID, packId: 'pack15' },
      success_url: 'https://app.example.com/scout?billing=success',
      cancel_url: 'https://app.example.com/scout?billing=cancelled',
    });
    expect(params.line_items).toEqual([
      {
        price_data: {
          currency: 'usd',
          unit_amount: 2000,
          product_data: { name: 'grandfinals.gg — AI report credits (15 reports)' },
        },
        quantity: 1,
      },
    ]);
  });
});

describe('POST /api/billing/webhook (configured)', () => {
  it('answers 400 when the stripe-signature header is missing', async () => {
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 400 when signature verification fails', async () => {
    const constructEvent = vi.fn(() => {
      throw new Error('invalid signature');
    });
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient({ webhooks: { constructEvent } }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'bad-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({ foo: 'bar' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('credits the balance and appends a purchase ledger entry on checkout.session.completed', async () => {
    const event = makeCheckoutCompletedEvent({ id: 'evt_1', uid: TEST_UID, packId: 'pack5' });
    const constructEvent = vi.fn(() => event);
    const { app, database } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient({ webhooks: { constructEvent } }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'good-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({ irrelevant: 'raw body, verified via the stub' }),
    });

    expect(response.statusCode).toBe(200);

    const balanceSnapshot = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceSnapshot.val()).toBe(5);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    const entries = Object.values(ledger[TEST_UID]!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'purchase', amount: 5, ref: 'evt_1' });
  });

  it('does not double-credit a replayed event id', async () => {
    const event = makeCheckoutCompletedEvent({ id: 'evt_replay', uid: TEST_UID, packId: 'pack5' });
    const constructEvent = vi.fn(() => event);
    const { app, database } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient({ webhooks: { constructEvent } }),
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'good-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({ n: 1 }),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'good-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({ n: 1 }),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const balanceSnapshot = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceSnapshot.val()).toBe(5);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    expect(Object.values(ledger[TEST_UID]!)).toHaveLength(1);
  });

  it('answers 200 (acknowledged) for an unknown event type without crediting anything', async () => {
    const constructEvent = vi.fn(
      () =>
        ({
          id: 'evt_other',
          object: 'event',
          type: 'payment_intent.succeeded',
          data: { object: {} },
        }) as unknown as Stripe.Event,
    );
    const { app, database } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient({ webhooks: { constructEvent } }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'good-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(200);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.credits).toBeUndefined();
  });

  it('does not require Firebase auth (no Authorization header needed)', async () => {
    const event = makeCheckoutCompletedEvent({ id: 'evt_public', uid: TEST_UID });
    const constructEvent = vi.fn(() => event);
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient({ webhooks: { constructEvent } }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'good-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(200);
  });

  it('the raw-body content-type parser is scoped to the webhook route only — POST /billing/checkout still gets parsed JSON', async () => {
    const create = vi.fn(async () => ({ url: 'https://checkout.stripe.com/session/xyz' }));
    const constructEventImpl: StripeLikeClient['webhooks']['constructEvent'] = () =>
      makeCheckoutCompletedEvent({ id: 'evt_scope' });
    const constructEvent = vi.fn(constructEventImpl);
    const { app } = buildTestApp({
      stripe: STRIPE_CONFIG,
      reports: REPORTS_CONFIG,
      stripeClient: stubStripeClient({
        checkout: { sessions: { create } },
        webhooks: { constructEvent },
      }),
    });

    // If the webhook's raw-body parser had leaked to the whole plugin scope,
    // `request.body` here would be a raw Buffer instead of the parsed
    // `{ packId: 'pack5' }` object, and the zod body-schema validation for
    // this route (which runs against a parsed object) would reject it.
    const checkoutResponse = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(),
      payload: { packId: 'pack5' },
    });
    expect(checkoutResponse.statusCode).toBe(200);

    // And the webhook route itself still gets the raw bytes it needs.
    const webhookResponse = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'good-sig', 'content-type': 'application/json' },
      payload: JSON.stringify({ some: 'payload' }),
    });
    expect(webhookResponse.statusCode).toBe(200);
    expect(constructEvent).toHaveBeenCalledTimes(1);
    const [rawPayload] = constructEvent.mock.calls[0]!;
    expect(Buffer.isBuffer(rawPayload) || typeof rawPayload === 'string').toBe(true);
  });
});
