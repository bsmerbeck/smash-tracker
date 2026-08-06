import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'firebase-admin/database';
import type { Auth } from 'firebase-admin/auth';
import type { PrepPaidConfig, StartggConfig, ReportsConfig, StripeConfig } from '../config/env.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import type { ParryggClients } from '../parrygg/client.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import { FakeAuth } from '../test-support/fakeAuth.js';
import {
  authHeader,
  buildTestApp,
  TEST_EMAIL,
  TEST_TOKEN,
  TEST_UID,
} from '../test-support/testApp.js';
import { buildApp } from '../app.js';
import { runSweepStuckReportJobs } from '../jobs/sweepStuckReportJobs.js';

const STARTGG_CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

const REPORTS_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set([TEST_UID]),
};

function gqlResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify({ data }), init);
}

const RESOLVE_RESPONSE = {
  user: { id: 1111624, slug: 'user/07dc2239', player: { id: 1802316, gamerTag: 'Pandem1c' } },
};

const EMPTY_SETS_RESPONSE = {
  player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } },
};

function scoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return gqlResponse(RESOLVE_RESPONSE);
    }
    return gqlResponse(EMPTY_SETS_RESPONSE);
  }) as typeof fetch;
}

/**
 * What VALID_REPORT looks like once persisted (V9-B fix): the write path
 * strips null-valued fields before the RTDB write (RTDB would delete them
 * anyway — deleting on OUR side keeps the stored shape and the read-back
 * shape identical), so `headToHead: null` is simply absent. Defined as the
 * BASE shape; `VALID_REPORT` (the model's generation output, where the field
 * is required) composes it with the explicit null.
 */
const STORED_VALID_REPORT = {
  overview: 'A fast-falling Fox/Falco player.',
  gameplan: ['Punish landing lag.'],
  characterStrategy: {
    picks: ['Mario'],
    reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario.',
  },
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'Flat stages favor us.',
  },
  watchFor: ['Shine spikes off stage.'],
  confidenceNotes: 'No sampled sets — treat this as a cold read.',
};

const VALID_REPORT = { ...STORED_VALID_REPORT, headToHead: null };

/** Pre-V7-B.1 stored report shape: lacks `characterStrategy` entirely. */
const PRE_B1_REPORT = {
  overview: 'A fast-falling Fox/Falco player.',
  gameplan: ['Punish landing lag.'],
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'Flat stages favor us.',
  },
  headToHead: null,
  watchFor: ['Shine spikes off stage.'],
  confidenceNotes: 'No sampled sets — treat this as a cold read.',
};

function stubClient(
  impl: (params: unknown) => Promise<{ stop_reason: string | null; parsed_output: unknown }>,
): AnthropicLikeClient {
  return {
    messages: {
      parse: impl as AnthropicLikeClient['messages']['parse'],
    },
  };
}

describe('/api/reports (unconfigured)', () => {
  it('answers 503 on GET /reports/config when reports config is missing', async () => {
    const { app } = buildTestApp({ startgg: STARTGG_CONFIG, startggFetch: scoutFetchMock() });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/config',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 on POST /reports when start.gg config is missing (reports config alone is not enough)', async () => {
    const { app } = buildTestApp({
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 on GET /reports when both configs are missing', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('GET /api/reports/config (configured)', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({ method: 'GET', url: '/api/reports/config' });
    expect(response.statusCode).toBe(401);
  });

  it('returns enabled: true for an allowlisted uid', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/config',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, freeAccess: true });
  });

  it('returns enabled: false for a non-allowlisted uid (never 403s)', async () => {
    const emptyAllowlistConfig: ReportsConfig = {
      anthropicApiKey: 'sk-test-key',
      allowedUids: new Set(['someone-else']),
    };
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: emptyAllowlistConfig,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/config',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: false, freeAccess: false });
  });
});

describe('POST /api/reports (configured, allowlisted)', () => {
  it('requires auth', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 403 when the signed-in uid is not allowlisted', async () => {
    const emptyAllowlistConfig: ReportsConfig = {
      anthropicApiKey: 'sk-test-key',
      allowedUids: new Set(['someone-else']),
    };
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: emptyAllowlistConfig,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 400 for malformed scout input', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'not a valid start.gg reference' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when the player cannot be resolved', async () => {
    const fetchMock = (async () => gqlResponse({ user: null })) as typeof fetch;
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: fetchMock,
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/doesnotexist' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('passes through a 429 from start.gg', async () => {
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('ResolveBySlug')) {
        return gqlResponse(RESOLVE_RESPONSE);
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: fetchMock,
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(429);
  });

  it('happy path: generates a report, writes it to RTDB, and returns the stored record', async () => {
    let capturedParams: unknown;
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async (params) => {
        capturedParams = params;
        return { stop_reason: 'end_turn', parsed_output: VALID_REPORT };
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      report: STORED_VALID_REPORT,
    });
    expect(typeof body.id).toBe('string');
    expect(typeof body.createdAt).toBe('number');

    // Assert the Claude call shape: adaptive thinking, no temperature/top_p,
    // output_config.format present.
    expect(capturedParams).toMatchObject({
      model: 'claude-opus-4-8',
      thinking: { type: 'adaptive' },
    });
    expect(capturedParams).not.toHaveProperty('temperature');
    expect(capturedParams).not.toHaveProperty('top_p');

    // Assert the RTDB write, including the V9-B null-strip: `headToHead:
    // null` must NOT be persisted (RTDB deletes null keys on write anyway —
    // storing the already-stripped shape keeps write and read-back
    // identical, see routes/reports.ts).
    const dump = database.dump() as Record<string, unknown>;
    const scoutReports = dump.scoutReports as Record<string, Record<string, unknown>>;
    const stored = Object.values(scoutReports[TEST_UID]!)[0]! as Record<string, unknown>;
    expect(stored).toMatchObject({
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c' },
      report: STORED_VALID_REPORT,
    });
    expect(stored.report).not.toHaveProperty('headToHead');
    expect(body.report).not.toHaveProperty('headToHead');
  });

  it('maps a refusal to 502 with a human-readable message', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ statusCode: 502 });
    expect(response.json().message).toMatch(/declined/i);
  });

  it('maps a truncated (max_tokens) response to 502', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'max_tokens', parsed_output: null })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/truncated/i);
  });

  it('maps Anthropic.RateLimitError to 429', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => {
        throw new Anthropic.RateLimitError(
          429,
          { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
          'slow down',
          new Headers(),
        );
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(429);
  });

  it('maps other Anthropic API errors to 502', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => {
        throw new Anthropic.InternalServerError(
          500,
          { type: 'error', error: { type: 'api_error', message: 'boom' } },
          'boom',
          new Headers(),
        );
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(502);
  });
});

describe('POST /api/reports (V7-C: non-allowlisted, Stripe-gated)', () => {
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const STRIPE_CONFIG = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };

  it('still returns 403 for a non-allowlisted uid when Stripe is not configured (pre-V7-C behavior, unchanged)', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 402 when Stripe is configured but the caller has a zero credit balance', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().message).toMatch(/credits/i);
  });

  it('spends exactly one credit on a successful generation', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 3);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    const entries = Object.values(ledger[TEST_UID]!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'spend', amount: -1 });
  });

  it('refunds the credit when the scout lookup 404s', async () => {
    const fetchMock = (async () => gqlResponse({ user: null })) as typeof fetch;
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: fetchMock,
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/doesnotexist' },
    });

    expect(response.statusCode).toBe(404);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    const entries = Object.values(ledger[TEST_UID]!);
    expect(entries.map((e) => (e as { type: string }).type)).toEqual(['spend', 'refund']);
  });

  it('refunds the credit when generation fails (ReportGenerationError)', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });

    expect(response.statusCode).toBe(502);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('refunds the credit on a start.gg 429', async () => {
    const fetchMock = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('ResolveBySlug')) {
        return gqlResponse(RESOLVE_RESPONSE);
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: fetchMock,
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });

    expect(response.statusCode).toBe(429);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('does not spend a credit for a 400 (malformed input) — nothing was attempted', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'not a valid start.gg reference' },
    });

    expect(response.statusCode).toBe(400);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('allowlisted uids stay free/unlimited even when Stripe is configured and their credit balance is 0', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.exists()).toBe(false);
  });

  it('concurrent requests cannot both spend the last credit (RTDB transaction on the balance node)', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: { query: 'user/07dc2239' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: { query: 'user/07dc2239' },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    // Exactly one request should succeed (spends the single credit); the
    // other must see a zero balance and get 402 — never both succeeding.
    expect(statusCodes).toEqual([200, 402]);

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(0);
  });
});

describe('GET /api/reports (configured, allowlisted)', () => {
  it('returns 403 when not allowlisted', async () => {
    const emptyAllowlistConfig: ReportsConfig = {
      anthropicApiKey: 'sk-test-key',
      allowedUids: new Set(['someone-else']),
    };
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: emptyAllowlistConfig,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns an empty array when there are no reports', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('lists stored reports newest-first', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    database.seed(`scoutReports/${TEST_UID}`, {
      older: {
        createdAt: 1000,
        model: 'claude-opus-4-8',
        player: { id: 1, gamerTag: 'Old' },
        report: VALID_REPORT,
      },
      newer: {
        createdAt: 2000,
        model: 'claude-opus-4-8',
        player: { id: 2, gamerTag: 'New' },
        report: VALID_REPORT,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ id: 'newer', createdAt: 2000 });
    expect(body[1]).toMatchObject({ id: 'older', createdAt: 1000 });
  });

  it('V7-B.1 back-compat: a pre-B.1 stored record (no characterStrategy) still parses and round-trips', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    database.seed(`scoutReports/${TEST_UID}`, {
      legacy: {
        createdAt: 500,
        model: 'claude-opus-4-8',
        player: { id: 3, gamerTag: 'Legacy' },
        report: PRE_B1_REPORT,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'legacy', report: PRE_B1_REPORT });
    expect(body[0].report.characterStrategy).toBeUndefined();
  });
});

describe('GET /api/reports/:id (configured, allowlisted)', () => {
  it('returns 403 when not allowlisted', async () => {
    const emptyAllowlistConfig: ReportsConfig = {
      anthropicApiKey: 'sk-test-key',
      allowedUids: new Set(['someone-else']),
    };
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: emptyAllowlistConfig,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/some-id',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 for a report that does not exist', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/does-not-exist',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns the stored record for a known id', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    database.seed(`scoutReports/${TEST_UID}/report1`, {
      createdAt: 1234,
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      report: VALID_REPORT,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/report1',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'report1',
      createdAt: 1234,
      player: { gamerTag: 'Pandem1c' },
      report: VALID_REPORT,
    });
  });
});

// ---------------------------------------------------------------------------
// V9-B Feature 4: parry.gg-sourced report generation.
// ---------------------------------------------------------------------------

const PARRY_USER_ID = '019ce9ba-debd-7e11-84a2-77258f52644e';

function parryClients(overrides: {
  getUser?: () => { id: string; gamerTag: string } | null;
}): ParryggClients {
  return {
    users: {
      getUser: vi.fn(async () => {
        const found = overrides.getUser?.() ?? null;
        return {
          getUser: () => (found ? { toObject: () => ({ ...found, bioMd: '' }) } : undefined),
        };
      }),
      getUsers: vi.fn(async () => ({ getUsersList: () => [] })),
    } as unknown as ParryggClients['users'],
    matches: {
      getMatches: vi.fn(async () => ({ getMatchesList: () => [] })),
    } as unknown as ParryggClients['matches'],
  };
}

describe('POST /api/reports (parry.gg, V9-B, allowlisted)', () => {
  it('answers 503 for a parry.gg query when only start.gg is configured', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
    });
    expect(response.statusCode).toBe(503);
  });

  it('generates and stores a report for a parry.gg-scouted player', async () => {
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: { source: 'parrygg', parryUserId: PARRY_USER_ID, gamerTag: 'Pandem1c' },
      report: STORED_VALID_REPORT,
    });

    const dump = database.dump() as Record<string, unknown>;
    const scoutReports = dump.scoutReports as Record<string, Record<string, unknown>>;
    const stored = Object.values(scoutReports[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({
      player: { source: 'parrygg', parryUserId: PARRY_USER_ID },
    });
  });

  it('returns 404 when no parry.gg player resolves', async () => {
    const { app } = buildTestApp({
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({ getUser: () => null }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: `https://parry.gg/profile/${PARRY_USER_ID}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// V13: reports generated from combined start.gg + parry.gg scout data.
// ---------------------------------------------------------------------------

describe('POST /api/reports (V13 combined)', () => {
  const combinedPayload = {
    query: 'user/07dc2239',
    source: 'startgg' as const,
    combineWith: { query: PARRY_USER_ID, source: 'parrygg' as const },
  };

  it('generates and stores a report from a combined-source scout', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: combinedPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: {
        source: 'combined',
        id: 1802316,
        parryUserId: PARRY_USER_ID,
        gamerTag: 'Pandem1c',
      },
    });

    const dump = database.dump() as Record<string, unknown>;
    const scoutReports = dump.scoutReports as Record<string, Record<string, unknown>>;
    const stored = Object.values(scoutReports[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({
      player: { source: 'combined', id: 1802316, parryUserId: PARRY_USER_ID },
    });
  });

  it('falls back to the single source that resolves (parry.gg not found), no 400/404', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({ getUser: () => null }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: combinedPayload,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.player.id).toBe(1802316);
    expect(body.player.source).not.toBe('combined');
  });

  it('does not 400 on a malformed start.gg handle when the parry.gg side resolves', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        query: 'not a valid start.gg reference',
        source: 'startgg' as const,
        combineWith: { query: PARRY_USER_ID, source: 'parrygg' as const },
      },
    });
    // Malformed start.gg side is dropped; parry.gg carries the report.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ player: { source: 'parrygg' } });
  });

  it('refunds the credit when a combined scout resolves nothing on either site', async () => {
    const noPlayerFetch = (async () => gqlResponse({ user: null })) as typeof fetch;
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: noPlayerFetch,
      reports: {
        anthropicApiKey: 'sk-test-key',
        allowedUids: new Set(['someone-else']),
      },
      stripe: { secretKey: 'sk-test-123', webhookSecret: 'whsec-test-456' },
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({ getUser: () => null }),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: combinedPayload,
    });

    expect(response.statusCode).toBe(404);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// V9-B production fixes: RTDB null-stripping resilience + billing-enabled
// read access.
// ---------------------------------------------------------------------------

describe('GET /api/reports* — RTDB-stripped and corrupt stored records (V9-B fix)', () => {
  /**
   * The exact shape production RTDB hands back for a record persisted with
   * `headToHead: null` before the write-path fix: RTDB deletes null-valued
   * keys on write, so the field is ABSENT (not null).
   */
  const RTDB_STRIPPED_RECORD = {
    createdAt: 1000,
    model: 'claude-opus-4-8',
    player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
    report: STORED_VALID_REPORT, // no headToHead key at all
  };

  function appWithSeed(seed: Record<string, unknown>) {
    const built = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    built.database.seed(`scoutReports/${TEST_UID}`, seed);
    return built;
  }

  it('GET /reports round-trips a stored record whose headToHead was RTDB-stripped (absent)', async () => {
    const { app } = appWithSeed({ stripped: RTDB_STRIPPED_RECORD });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'stripped', report: STORED_VALID_REPORT });
    expect(body[0].report).not.toHaveProperty('headToHead');
  });

  it('GET /reports/:id round-trips the RTDB-stripped shape', async () => {
    const { app } = appWithSeed({ stripped: RTDB_STRIPPED_RECORD });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/stripped',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'stripped', report: STORED_VALID_REPORT });
  });

  it('GET /reports skips a corrupt record (missing report entirely) and still returns the valid ones', async () => {
    const { app } = appWithSeed({
      good: RTDB_STRIPPED_RECORD,
      corrupt: {
        createdAt: 2000,
        model: 'claude-opus-4-8',
        player: { id: 999, gamerTag: 'Broken' },
        // no `report` at all — one bad row must never 500 the whole library
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'good' });
  });

  /**
   * 2026-08-03 walkthrough P1: RTDB strips EMPTY ARRAYS on write exactly
   * like nulls. Five paid reports stored with stageStrategy.bans/picks []
   * came back with those keys ABSENT, failed the then-required-array read
   * schema, vanished from the library, and 500'd on direct reads — credits
   * already spent. The stored/read schema now defaults every array field to
   * [] when absent. The exact production shape: every array key missing.
   */
  const RTDB_EMPTY_ARRAYS_RECORD = {
    createdAt: 3000,
    model: 'claude-opus-4-8',
    player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
    report: {
      overview: 'Aggressive Peach with strong ledge traps.',
      // gameplan: [] — stripped by RTDB, key absent
      characterStrategy: { reasoning: 'Stick to Roy.' }, // picks [] stripped
      stageStrategy: { reasoning: 'No sampled stage data.' }, // bans+picks [] stripped
      // watchFor: [] — stripped
      confidenceNotes: 'Small sample.',
    },
  };

  it('GET /reports includes a record whose empty stage/gameplan arrays were RTDB-stripped, restoring []', async () => {
    const { app } = appWithSeed({ emptied: RTDB_EMPTY_ARRAYS_RECORD });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('emptied');
    expect(body[0].report.gameplan).toEqual([]);
    expect(body[0].report.watchFor).toEqual([]);
    expect(body[0].report.stageStrategy).toEqual({
      reasoning: 'No sampled stage data.',
      bans: [],
      picks: [],
    });
    expect(body[0].report.characterStrategy).toEqual({ reasoning: 'Stick to Roy.', picks: [] });
  });

  it('GET /reports/:id answers 200 (not 500) for the empty-array-stripped shape', async () => {
    const { app } = appWithSeed({ emptied: RTDB_EMPTY_ARRAYS_RECORD });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/emptied',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().report.stageStrategy.bans).toEqual([]);
    expect(response.json().report.stageStrategy.picks).toEqual([]);
  });

  it('a record WRITTEN with explicit empty arrays round-trips through the RTDB drop (full write-read parity)', async () => {
    const { app, database } = appWithSeed({});
    // Write through the fake's set(), which emulates the real SDK's
    // empty-array drop — this is the exact path the generation route takes.
    await database.ref(`scoutReports/${TEST_UID}/written`).set({
      createdAt: 4000,
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      report: {
        overview: 'Fresh generation with no stage data.',
        gameplan: [],
        characterStrategy: { picks: [], reasoning: 'Stay on main.' },
        stageStrategy: { bans: [], picks: [], reasoning: 'No stage sample.' },
        watchFor: [],
        confidenceNotes: 'No stage sample available.',
      },
    });

    const direct = await app.inject({
      method: 'GET',
      url: '/api/reports/written',
      headers: authHeader(),
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json().report.gameplan).toEqual([]);

    const list = await app.inject({ method: 'GET', url: '/api/reports', headers: authHeader() });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((r: { id: string }) => r.id)).toContain('written');
  });
});

describe('GET /api/reports* — billing-enabled read access (V9-B fix)', () => {
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const STRIPE_CONFIG = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };

  const SEEDED_RECORD = {
    createdAt: 1000,
    model: 'claude-opus-4-8',
    player: { id: 1802316, gamerTag: 'Pandem1c' },
    report: STORED_VALID_REPORT,
  };

  it('a billing-enabled non-allowlisted uid can list its reports (it can PAY to generate them via POST)', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`scoutReports/${TEST_UID}`, { r1: SEEDED_RECORD });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
  });

  it('a billing-enabled non-allowlisted uid can reopen a single report', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`scoutReports/${TEST_UID}`, { r1: SEEDED_RECORD });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/r1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'r1', player: { gamerTag: 'Pandem1c' } });
  });

  it('still 403s a non-allowlisted uid on both read routes when Stripe is NOT configured (pre-V7-C behavior, unchanged)', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    const list = await app.inject({ method: 'GET', url: '/api/reports', headers: authHeader() });
    expect(list.statusCode).toBe(403);

    const single = await app.inject({
      method: 'GET',
      url: '/api/reports/r1',
      headers: authHeader(),
    });
    expect(single.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Phase 10 BILL-06/MEAS-03: durable, idempotent report-job state machine.
// ---------------------------------------------------------------------------

describe('POST /api/reports — reportJobs state machine (BILL-06/MEAS-03)', () => {
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const STRIPE_CONFIG = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };

  function eventsNamed(database: { dump(): unknown }, eventName: string) {
    const dump = database.dump() as Record<string, unknown>;
    const ledger = (dump.eventLedger ?? {}) as Record<string, Record<string, unknown>>;
    return Object.values(ledger)
      .flatMap((day) => Object.values(day))
      .filter((event) => (event as { eventName: string }).eventName === eventName);
  }

  it('a second POST with a succeeded jobId returns the cached result without a second Anthropic call or a second credit spend', async () => {
    let callCount = 0;
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => {
        callCount += 1;
        return { stop_reason: 'end_turn', parsed_output: VALID_REPORT };
      }),
    });
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const jobId = 'job-idempotent-1';
    const first = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(first.statusCode).toBe(200);
    expect(callCount).toBe(1);

    const balanceAfterFirst = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceAfterFirst.val()).toBe(4);

    const second = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // No additional Anthropic call, no additional spend.
    expect(callCount).toBe(1);
    const balanceAfterSecond = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceAfterSecond.val()).toBe(4);
  });

  it('a POST with a jobId already `running` within the staleness window answers 409', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const jobId = 'job-running-1';
    database.seed(`reportJobs/${TEST_UID}/${jobId}`, {
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 0,
      creditRef: jobId,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(response.statusCode).toBe(409);
  });

  it('a stale `running` job (past the staleness window) is treated as abandoned and the retry proceeds', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const jobId = 'job-stale-1';
    database.seed(`reportJobs/${TEST_UID}/${jobId}`, {
      status: 'running',
      createdAt: Date.now() - 20 * 60 * 1000,
      updatedAt: Date.now() - 20 * 60 * 1000, // 20 min ago, past the 15 min staleness window
      attempt: 0,
      creditRef: jobId,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(response.statusCode).toBe(200);
  });

  it('a generation failure transitions the job to failed, refunds the balance, clears the running index, and emits exactly one report_failed + one credit_refunded', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const jobId = 'job-failure-1';

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(response.statusCode).toBe(502);

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);

    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'failed', creditRef: jobId });

    const runningIndex = await database
      .ref(`reportJobsByStatus/running/${TEST_UID}/${jobId}`)
      .get();
    expect(runningIndex.exists()).toBe(false);

    expect(eventsNamed(database, 'report_failed')).toHaveLength(1);
    expect(eventsNamed(database, 'credit_refunded')).toHaveLength(1);
  });

  it('a successful run emits exactly one report_started and one report_completed', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId: 'job-success-events-1' },
    });
    expect(response.statusCode).toBe(200);

    expect(eventsNamed(database, 'report_started')).toHaveLength(1);
    expect(eventsNamed(database, 'report_completed')).toHaveLength(1);
    expect(eventsNamed(database, 'report_failed')).toHaveLength(0);
  });

  it('sets reportJobsByStatus/running and reportJobsByDay while running, then clears/updates them on success', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const jobId = 'job-index-1';

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(response.statusCode).toBe(200);

    // Terminal: the running index is cleared after success.
    const runningIndex = await database
      .ref(`reportJobsByStatus/running/${TEST_UID}/${jobId}`)
      .get();
    expect(runningIndex.exists()).toBe(false);

    const dump = database.dump() as Record<string, unknown>;
    const byDay = dump.reportJobsByDay as Record<string, Record<string, unknown>>;
    const dayEntries = Object.values(byDay ?? {});
    const matching = dayEntries.flatMap((day) => (jobId in day ? [day[jobId]] : []));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ uid: TEST_UID, status: 'succeeded' });

    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'succeeded', resultRef: response.json().id });
  });

  it('creditRef is derived from the jobId, not a separate reports:${uid}: ref', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const jobId = 'job-creditref-1';

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId },
    });
    expect(response.statusCode).toBe(200);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    const entries = Object.values(ledger[TEST_UID]!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'spend', ref: jobId });
  });

  it('a request with no jobId (legacy client) falls back to a server-generated jobId and still works', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('paid prep activation gate (RPT-04)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const PREP_REQUEST_BODY = {
    reason: 'prep_report' as const,
    entryKey: 'evo-2026-ult',
    opponentName: 'rival',
  };

  it('answers 503 with the house error body for a prep-context request while the gate is off', async () => {
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      // prepPaid deliberately omitted — gate off (the default).
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_REQUEST_BODY,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: 'Service Unavailable',
      statusCode: 503,
    });
  });

  it('refuses an allowlisted uid too (owner battery item 9 — the gate precedes the allowlist branch)', async () => {
    // TEST_UID is allowlisted on REPORTS_CONFIG (module-level const above).
    const { app } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      // prepPaid deliberately omitted — gate off. No stripe config either;
      // an allowlisted uid would otherwise sail through the freeAccess
      // branch below the gate, which is exactly what this test guards.
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_REQUEST_BODY,
    });

    expect(response.statusCode).toBe(503);
  });

  it('produces zero writes and zero downstream calls while the gate is off', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const scoutFetch = vi.fn(scoutFetchMock());
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetch,
      reports: REPORTS_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(modelSpy),
    });
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_REQUEST_BODY,
    });

    expect(response.statusCode).toBe(503);

    const after = JSON.stringify(database.dump());
    expect(after).toEqual(before);

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.reportJobs).toBeUndefined();
    expect(dump.creditLedger).toBeUndefined();
    expect(dump.eventLedger).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(5);

    expect(modelSpy).not.toHaveBeenCalled();
    expect(scoutFetch).not.toHaveBeenCalled();
  });

  it('a request without reason behaves exactly as today whether the gate is on or off', async () => {
    for (const prepPaid of [null, PREP_PAID_CONFIG]) {
      const { app, database } = buildTestApp({
        startgg: STARTGG_CONFIG,
        startggFetch: scoutFetchMock(),
        reports: REPORTS_CONFIG,
        stripe: STRIPE_CONFIG,
        ...(prepPaid ? { prepPaid } : {}),
        reportsClient: stubClient(async () => ({
          stop_reason: 'end_turn',
          parsed_output: VALID_REPORT,
        })),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: { query: 'user/07dc2239' },
      });

      expect(response.statusCode).toBe(200);
      const dump = database.dump() as Record<string, unknown>;
      const reportJobs = dump.reportJobs as Record<string, unknown>;
      expect(Object.keys(reportJobs[TEST_UID] as object)).toHaveLength(1);
    }
  });

  it('GET /api/reports/config behaves identically with the gate on and off', async () => {
    for (const prepPaid of [null, PREP_PAID_CONFIG]) {
      const { app } = buildTestApp({
        startgg: STARTGG_CONFIG,
        startggFetch: scoutFetchMock(),
        reports: REPORTS_CONFIG,
        stripe: STRIPE_CONFIG,
        ...(prepPaid ? { prepPaid } : {}),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/reports/config',
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ enabled: true, freeAccess: true });
    }
  });

  it('GET /api/reports and GET /api/reports/:id behave identically with the gate on and off', async () => {
    for (const prepPaid of [null, PREP_PAID_CONFIG]) {
      const { app, database } = buildTestApp({
        startgg: STARTGG_CONFIG,
        startggFetch: scoutFetchMock(),
        reports: REPORTS_CONFIG,
        stripe: STRIPE_CONFIG,
        ...(prepPaid ? { prepPaid } : {}),
      });
      database.seed(`scoutReports/${TEST_UID}`, {
        onlyReport: {
          createdAt: Date.now(),
          model: 'claude-opus-4-8',
          player: { id: 1, gamerTag: 'Pandem1c' },
          report: STORED_VALID_REPORT,
        },
      });
      const id = 'onlyReport';

      const listResponse = await app.inject({
        method: 'GET',
        url: '/api/reports',
        headers: authHeader(),
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toHaveLength(1);

      const singleResponse = await app.inject({
        method: 'GET',
        url: `/api/reports/${id}`,
        headers: authHeader(),
      });
      expect(singleResponse.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 27 (Task 2/3): job terminal states + the prep-single report branch.
// ---------------------------------------------------------------------------

/** Seeds `prepBriefs/{uid}/{entryKey}` directly, matching `prepBriefRecordSchema`'s stored shape. */
function seedPrepBrief(
  database: FakeDatabase,
  uid: string,
  entryKey: string,
  params: {
    likelyOpponents?: Record<string, true>;
    scoutBindings?: Record<string, Record<string, unknown>>;
  } = {},
): void {
  database.seed(`prepBriefs/${uid}/${entryKey}`, {
    eventDate: 1_700_000_000_000,
    activatedAt: 1_700_000_000_000,
    lastOpenedAt: 1_700_000_000_000,
    ...(params.likelyOpponents ? { likelyOpponents: params.likelyOpponents } : {}),
    ...(params.scoutBindings ? { scoutBindings: params.scoutBindings } : {}),
  });
}

/**
 * Wraps `database.ref` to record the order writes are issued in — the
 * refund-ordering test below is the ONE place this is needed: proving
 * `failed` is written, then the refund transaction commits, then `refunded`
 * is written, never any other order.
 */
function trackWrites(database: FakeDatabase): string[] {
  const writes: string[] = [];
  const originalRef = database.ref.bind(database);
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    const ref = originalRef(path);
    return {
      ...ref,
      set: async (value: unknown) => {
        const status = (value as { status?: string } | null)?.status;
        writes.push(`set:${path ?? ''}${status ? `#${status}` : ''}`);
        return ref.set(value);
      },
      update: async (values: Record<string, unknown>) => {
        writes.push(`update:${path ?? ''}`);
        return ref.update(values);
      },
      transaction: async (fn: (current: unknown) => unknown) => {
        writes.push(`transaction:${path ?? ''}`);
        return ref.transaction(fn);
      },
    };
  });
  return writes;
}

/** Reads every `eventLedger` row for `eventName` out of a raw database dump. */
function findEvents(
  database: FakeDatabase,
  eventName: string,
): Array<{ payload: Record<string, unknown> }> {
  const dump = database.dump() as Record<string, unknown>;
  const eventLedger = (dump.eventLedger ?? {}) as Record<string, Record<string, unknown>>;
  const results: Array<{ payload: Record<string, unknown> }> = [];
  for (const dayBucket of Object.values(eventLedger)) {
    for (const event of Object.values(dayBucket)) {
      const e = event as { eventName?: string; payload?: Record<string, unknown> };
      if (e.eventName === eventName) {
        results.push({ payload: e.payload ?? {} });
      }
    }
  }
  return results;
}

describe('report job terminal states (RPT-03)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const BILLING_STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const ENTRY_KEY = 'evo-2026-ult';
  const OPPONENT_NAME = 'rival';
  const PARRY_BINDING_RECORD = {
    provider: 'parrygg',
    parryUserId: PARRY_USER_ID,
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1,
  };

  it('a prep job that fails after a credit was spent transitions failed -> refund -> refunded, in that order, refunding exactly once', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const writes = trackWrites(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: OPPONENT_NAME,
        jobId: 'prep-job-refund-order',
      },
    });

    expect(response.statusCode).toBe(502);

    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/prep-job-refund-order`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'refunded', reason: 'prep_report' });

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);

    const ledger = (database.dump() as Record<string, unknown>).creditLedger as Record<
      string,
      Record<string, unknown>
    >;
    const refundEntries = Object.values(ledger[TEST_UID]!).filter(
      (entry) => (entry as { type: string }).type === 'refund',
    );
    expect(refundEntries).toHaveLength(1);

    const failedIndex = writes.indexOf(`set:reportJobs/${TEST_UID}/prep-job-refund-order#failed`);
    const refundedIndex = writes.indexOf(
      `set:reportJobs/${TEST_UID}/prep-job-refund-order#refunded`,
    );
    // The credit's balance node sees TWO transactions in this flow — the
    // up-front spend, then the refund — so find the one that happens AFTER
    // the failed-status write, not the first one overall (which is the
    // spend).
    const refundTransactionIndex = writes.findIndex(
      (entry, index) =>
        index > failedIndex && entry.startsWith(`transaction:credits/${TEST_UID}/balance`),
    );
    expect(failedIndex).toBeGreaterThan(-1);
    expect(refundedIndex).toBeGreaterThan(-1);
    expect(refundTransactionIndex).toBeGreaterThan(-1);
    expect(failedIndex).toBeLessThan(refundTransactionIndex);
    expect(refundTransactionIndex).toBeLessThan(refundedIndex);
  });

  it('a prep job that fails for a free-access (allowlisted) uid stays failed and no refund occurs', async () => {
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: OPPONENT_NAME,
        jobId: 'prep-job-free',
      },
    });

    expect(response.statusCode).toBe(502);
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/prep-job-free`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'failed', reason: 'prep_report' });

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.creditLedger).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.exists()).toBe(false);
  });

  it('a legacy, non-prep job that fails stays failed exactly as today — never refunded, no reason key', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239', jobId: 'legacy-job-terminal' },
    });

    expect(response.statusCode).toBe(502);
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/legacy-job-terminal`).get();
    const job = jobSnapshot.val() as Record<string, unknown>;
    expect(job.status).toBe('failed');
    expect(job).not.toHaveProperty('reason');

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('the reportJobsByDay entry for a failed prep job records the failed terminal, not refunded', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: OPPONENT_NAME,
        jobId: 'prep-job-day-shard',
      },
    });
    expect(response.statusCode).toBe(502);

    const dump = database.dump() as Record<string, unknown>;
    const byDay = dump.reportJobsByDay as Record<string, Record<string, unknown>>;
    const entries = Object.values(byDay).flatMap((bucket) => Object.entries(bucket));
    const jobEntry = entries.find(([jobId]) => jobId === 'prep-job-day-shard');
    expect(jobEntry?.[1]).toMatchObject({ status: 'failed' });
  });
});

describe('prep single report (RPT-01)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const BILLING_STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const ENTRY_KEY = 'evo-2026-ult';
  const OPPONENT_NAME = 'rival';
  const PARRY_BINDING_RECORD = {
    provider: 'parrygg',
    parryUserId: PARRY_USER_ID,
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1,
  };
  const PREP_PAYLOAD = {
    reason: 'prep_report' as const,
    entryKey: ENTRY_KEY,
    opponentName: OPPONENT_NAME,
    jobId: 'prep-single-job',
  };

  function billableApp(overrides: Partial<Parameters<typeof buildTestApp>[0]> = {}) {
    return buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
      ...overrides,
    });
  }

  it('answers 404 before any spend, job write, or model call when the caller has no such brief', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    database.seed(`credits/${TEST_UID}/balance`, 3);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(database.dump())).toEqual(before);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('answers 400 before any spend, job write, or model call when the opponent is not currently curated', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, { likelyOpponents: { someoneElse: true } });
    database.seed(`credits/${TEST_UID}/balance`, 3);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(database.dump())).toEqual(before);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('answers 409 before any spend, job write, or model call when there is no confirmed, report-ready binding', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, { likelyOpponents: { [OPPONENT_NAME]: true } });
    database.seed(`credits/${TEST_UID}/balance`, 3);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(database.dump())).toEqual(before);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('a jobId with an RTDB-illegal character answers 400, never a 500 from database.ref() (28-review CR-01 item 4 follow-up)', async () => {
    const { app } = billableApp();

    for (const jobId of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'a\x01b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: { ...PREP_PAYLOAD, jobId },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('spends exactly one credit, creates one job carrying the prep reason, writes the index pointer, and returns the stored report', async () => {
    const { app, database } = billableApp();
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 3);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ report: STORED_VALID_REPORT });

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);

    const dump = database.dump() as Record<string, unknown>;
    const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
    expect(Object.keys(reportJobs[TEST_UID]!)).toEqual([PREP_PAYLOAD.jobId]);
    expect(reportJobs[TEST_UID]![PREP_PAYLOAD.jobId]).toMatchObject({
      status: 'succeeded',
      reason: 'prep_report',
    });

    const indexSnapshot = await database
      .ref(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/${OPPONENT_NAME}`)
      .get();
    expect(indexSnapshot.val()).toMatchObject({ jobId: PREP_PAYLOAD.jobId });
  });

  it('an allowlisted uid gets the same report with zero credit movement (owner battery item 9)', async () => {
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.exists()).toBe(false);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.creditLedger).toBeUndefined();
  });

  it('refunds the credit and reaches the refunded terminal when the live provider lookup fails at generation time', async () => {
    const { app, database } = billableApp({
      parryggClients: parryClients({ getUser: () => null }),
    });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(404);
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${PREP_PAYLOAD.jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'refunded', reason: 'prep_report' });
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('the index pointer resolves to the created job id and survives a subsequent successful re-read', async () => {
    const { app, database } = billableApp();
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 3);

    await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    const indexSnapshotBefore = await database
      .ref(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/${OPPONENT_NAME}`)
      .get();
    expect(indexSnapshotBefore.val()).toMatchObject({ jobId: PREP_PAYLOAD.jobId });

    const jobStatus = await database.ref(`reportJobs/${TEST_UID}/${PREP_PAYLOAD.jobId}`).get();
    expect(jobStatus.val()).toMatchObject({ status: 'succeeded' });

    const indexSnapshotAfter = await database
      .ref(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/${OPPONENT_NAME}`)
      .get();
    expect(indexSnapshotAfter.val()).toMatchObject({ jobId: PREP_PAYLOAD.jobId });
  });

  it('prep report_* event payloads carry exactly the enum reason and nothing else', async () => {
    const { app, database } = billableApp();
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 3);

    await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    for (const eventName of ['report_started', 'report_completed']) {
      const events = findEvents(database, eventName);
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]!.payload)).toEqual(['reason']);
      expect(events[0]!.payload.reason).toBe('prep_report');
    }
  });

  /**
   * 2026-08-03 walkthrough P2: retrying a refunded opponent at balance 0
   * returned the correct 402, but flipped the durable job from `refunded`
   * to `failed` ("Failed — refunding your credit…" forever) and emitted a
   * spurious extra report_failed with no matching credit_spent/refunded
   * pair. The insufficient-credit decision must leave the prior terminal
   * state, the ledger, and telemetry completely untouched.
   */
  it('a zero-credit retry of a REFUNDED job answers 402 and leaves the job, ledger, and events untouched', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    const refundedJob = {
      status: 'refunded',
      createdAt: 1_000,
      updatedAt: 2_000,
      attempt: 1,
      creditRef: PREP_PAYLOAD.jobId,
      reason: 'prep_report',
    };
    database.seed(`reportJobs/${TEST_UID}/${PREP_PAYLOAD.jobId}`, refundedJob);
    database.seed(`credits/${TEST_UID}/balance`, 0);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(402);
    // The prior terminal state is restored VERBATIM — not `failed`, not
    // `queued`, and updatedAt is not advanced.
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${PREP_PAYLOAD.jobId}`).get();
    expect(jobSnapshot.val()).toEqual(refundedJob);
    // No spurious telemetry, no ledger movement, no index pointer, no model call.
    expect(findEvents(database, 'report_failed')).toHaveLength(0);
    expect(findEvents(database, 'report_started')).toHaveLength(0);
    expect(JSON.stringify(database.dump())).toEqual(before);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('a zero-credit FRESH submission answers 402 with no job row, no index pointer, and no writes at all', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedPrepBrief(database, TEST_UID, ENTRY_KEY, {
      likelyOpponents: { [OPPONENT_NAME]: true },
      scoutBindings: { [OPPONENT_NAME]: PARRY_BINDING_RECORD },
    });
    database.seed(`credits/${TEST_UID}/balance`, 0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: PREP_PAYLOAD,
    });

    expect(response.statusCode).toBe(402);
    // No durable job row and no index pointer survive the 402 (the fake
    // leaves an empty parent node behind on remove; real RTDB prunes it —
    // the invariant is that the job path itself is gone).
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${PREP_PAYLOAD.jobId}`).get();
    expect(jobSnapshot.exists()).toBe(false);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.prepReportJobIndex).toBeUndefined();
    expect(findEvents(database, 'report_failed')).toHaveLength(0);
    expect(findEvents(database, 'report_started')).toHaveLength(0);
    expect(dump.creditLedger).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(0);
    expect(modelSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 27 (Task 1/2/3): the exactly-three-opponent bundle purchase, the
// pre-paid child execution path, and the read-only job-status endpoint.
// ---------------------------------------------------------------------------

const BUNDLE_OPPONENT_NAMES = ['rival1', 'rival2', 'rival3'];

/** Seeds a prep brief with all three bundle opponents curated and report-ready. */
function seedBundleBrief(
  database: FakeDatabase,
  uid: string,
  entryKey: string,
  opponentNames: string[] = BUNDLE_OPPONENT_NAMES,
  bindingRecord: Record<string, unknown> = {
    provider: 'parrygg',
    parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1,
  },
): void {
  database.seed(`prepBriefs/${uid}/${entryKey}`, {
    eventDate: 1_700_000_000_000,
    activatedAt: 1_700_000_000_000,
    lastOpenedAt: 1_700_000_000_000,
    likelyOpponents: Object.fromEntries(opponentNames.map((name) => [name, true])),
    scoutBindings: Object.fromEntries(opponentNames.map((name) => [name, bindingRecord])),
  });
}

/** Illegal-character set built from explicit char codes (RTDB-safety check, mirroring credits.test.ts). */
const RTDB_ILLEGAL_CHARACTER_CODES = new Set<number>([
  0x2e /* . */, 0x23 /* # */, 0x24 /* $ */, 0x5b /* [ */, 0x5d /* ] */, 0x2f /* / */,
  0x20 /* space */, 0x7f /* DEL */,
]);
for (let code = 0x00; code <= 0x1f; code += 1) {
  RTDB_ILLEGAL_CHARACTER_CODES.add(code);
}
function hasRtdbIllegalCharacter(value: string): boolean {
  return Array.from(value).some((char) => RTDB_ILLEGAL_CHARACTER_CODES.has(char.charCodeAt(0)));
}

describe('prep bundle submission (RPT-02, Task 1)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const BILLING_STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const ENTRY_KEY = 'evo-2026-ult';
  const BUNDLE_PAYLOAD = {
    reason: 'prep_bundle' as const,
    entryKey: ENTRY_KEY,
    bundleId: 'bundle-abc',
    opponentNames: BUNDLE_OPPONENT_NAMES,
  };

  function billableBundleApp(overrides: Partial<Parameters<typeof buildTestApp>[0]> = {}) {
    return buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      // The plugin-level guard (`!config || (!startggConfig && !parryggConfig)`)
      // 503s EVERY /reports* route, including the bundle branch, unless at
      // least one scouting engine is configured — parrygg here, unused by
      // the submission branch itself (it never calls resolveScout).
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      ...overrides,
    });
  }

  it('answers 404 before any charge when the caller has no such brief', async () => {
    const { app, database } = billableBundleApp();
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('answers 400 before any charge when an opponent is not currently curated', async () => {
    const { app, database } = billableBundleApp();
    seedBundleBrief(database, TEST_UID, ENTRY_KEY, ['rival1', 'rival2', 'someoneElse']);
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('a bundleId with an RTDB-illegal character answers 400 before any charge, never a 500 from database.ref() (28-review CR-01 item 4 follow-up)', async () => {
    const { app, database } = billableBundleApp();
    seedBundleBrief(database, TEST_UID, ENTRY_KEY, [...BUNDLE_OPPONENT_NAMES]);
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    for (const bundleId of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'a\x01b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: { ...BUNDLE_PAYLOAD, bundleId },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('answers 409 before any charge when an opponent has no confirmed, report-ready binding (owner battery item 6)', async () => {
    const { app, database } = billableBundleApp();
    database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
      eventDate: 1_700_000_000_000,
      activatedAt: 1_700_000_000_000,
      lastOpenedAt: 1_700_000_000_000,
      likelyOpponents: Object.fromEntries(BUNDLE_OPPONENT_NAMES.map((name) => [name, true])),
      // rival3 has no scoutBindings entry at all.
      scoutBindings: {
        rival1: {
          provider: 'parrygg',
          parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
          displayTag: 'Pandem1c',
          method: 'matchHistory',
          confirmedAt: 1,
        },
        rival2: {
          provider: 'parrygg',
          parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
          displayTag: 'Pandem1c',
          method: 'matchHistory',
          confirmedAt: 1,
        },
      },
    });
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('debits exactly three credits once, creates three deterministic queued jobs, writes three index pointers, and answers 202', async () => {
    const { app, database } = billableBundleApp();
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as {
      bundleId: string;
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };
    expect(body.bundleId).toBe(BUNDLE_PAYLOAD.bundleId);
    expect(body.jobs).toEqual([
      { opponentName: 'rival1', jobId: `${BUNDLE_PAYLOAD.bundleId}:1`, slot: 1 },
      { opponentName: 'rival2', jobId: `${BUNDLE_PAYLOAD.bundleId}:2`, slot: 2 },
      { opponentName: 'rival3', jobId: `${BUNDLE_PAYLOAD.bundleId}:3`, slot: 3 },
    ]);

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);

    for (const { opponentName, jobId } of body.jobs) {
      const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
      expect(jobSnapshot.val()).toMatchObject({
        status: 'queued',
        creditRef: jobId,
        reason: 'prep_bundle',
      });
      expect(hasRtdbIllegalCharacter(jobId)).toBe(false);

      const indexSnapshot = await database
        .ref(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/${opponentName}`)
        .get();
      expect(indexSnapshot.val()).toMatchObject({ jobId });
    }
  });

  it('answers 402 with zero debit/ledger/event/job/index writes when the balance is insufficient (owner battery item 2)', async () => {
    const { app, database } = billableBundleApp();
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 2);
    const before = JSON.parse(JSON.stringify(database.dump())) as Record<string, unknown>;

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(402);

    const after = JSON.parse(JSON.stringify(database.dump())) as Record<string, unknown>;
    const creditBundleOps = after.creditBundleOps as
      Record<string, Record<string, { status: string }>> | undefined;
    expect(creditBundleOps?.[TEST_UID]?.[BUNDLE_PAYLOAD.bundleId]?.status).toBe('insufficient');
    delete after.creditBundleOps;
    expect(after).toEqual(before);

    expect((after as { reportJobs?: unknown }).reportJobs).toBeUndefined();
    expect((after as { prepReportJobIndex?: unknown }).prepReportJobIndex).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);
  });

  it('re-submitting the SAME bundle id answers 202 with the same three job ids and does not debit again (owner battery item 1)', async () => {
    const { app, database } = billableBundleApp();
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const first = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);
  });

  it('two concurrent submissions of the same bundle id debit exactly three credits in total', async () => {
    const { app, database } = billableBundleApp();
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: BUNDLE_PAYLOAD,
      }),
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: BUNDLE_PAYLOAD,
      }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(first.json()).toEqual(second.json());

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);
  });

  it('an allowlisted uid receives the same 202 with zero credit movement and no operation marker debit (owner battery item 9)', async () => {
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.exists()).toBe(false);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.creditLedger).toBeUndefined();
    expect(dump.creditBundleOps).toBeUndefined();

    // Idempotent replay for an allowlisted uid too — resubmitting must never
    // reset an already-created child back to `queued`.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: BUNDLE_PAYLOAD,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(response.json());
  });
});

describe('bundle failure math (RPT-02/RPT-03, owner battery item 3)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const REPORTS_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set([TEST_UID]),
  };
  const BILLING_STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const ENTRY_KEY = 'evo-2026-ult';
  const PARRY_CLIENTS = parryClients({
    getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
  });

  /** A model client whose Nth call fails iff N is in `failSlots` (1-indexed, matching execution order). */
  function sequencedClient(failSlots: Set<number>) {
    let callCount = 0;
    const modelSpy = vi.fn(async () => {
      callCount += 1;
      return failSlots.has(callCount)
        ? { stop_reason: 'refusal' as const, parsed_output: null }
        : { stop_reason: 'end_turn' as const, parsed_output: VALID_REPORT };
    });
    return { client: stubClient(modelSpy), modelSpy };
  }

  async function runFailureMathCase(failureCount: number) {
    const failSlots = new Set(Array.from({ length: failureCount }, (_, index) => index + 1));
    const { client, modelSpy } = sequencedClient(failSlots);
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: client,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    const START_BALANCE = 10;
    database.seed(`credits/${TEST_UID}/balance`, START_BALANCE);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: `bundle-fm-${failureCount}`,
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    expect(submitResponse.statusCode).toBe(202);
    const { jobs } = submitResponse.json() as {
      bundleId: string;
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };

    for (const jobEntry of jobs) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: {
          reason: 'prep_report',
          entryKey: ENTRY_KEY,
          opponentName: jobEntry.opponentName,
          jobId: jobEntry.jobId,
        },
      });
      if (jobEntry.slot <= failureCount) {
        expect(response.statusCode).toBe(502);
      } else {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ report: STORED_VALID_REPORT });
      }
    }

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(START_BALANCE - 3 + failureCount);

    for (const jobEntry of jobs) {
      const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobEntry.jobId}`).get();
      const expectedStatus = jobEntry.slot <= failureCount ? 'refunded' : 'succeeded';
      expect(jobSnapshot.val()).toMatchObject({ status: expectedStatus, reason: 'prep_bundle' });
    }

    expect(modelSpy).toHaveBeenCalledTimes(3);

    return { database, jobs };
  }

  it('zero failures: all three children succeed and the balance ends at start minus three', async () => {
    await runFailureMathCase(0);
  });

  it('one failure: the balance ends at start minus two', async () => {
    await runFailureMathCase(1);
  });

  it('two failures: the balance ends at start minus one', async () => {
    await runFailureMathCase(2);
  });

  it('three failures: the balance ends exactly at the starting balance, with exactly three refund ledger entries, one per slot ref', async () => {
    const { database, jobs } = await runFailureMathCase(3);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = (dump.creditLedger as Record<string, Record<string, unknown>>)[TEST_UID]!;
    const refundEntries = Object.values(ledger).filter(
      (entry) => (entry as { type: string }).type === 'refund',
    ) as Array<{ ref: string }>;
    expect(refundEntries).toHaveLength(3);
    const refundRefs = refundEntries.map((entry) => entry.ref).sort();
    const expectedRefs = jobs.map((job) => job.jobId).sort();
    expect(refundRefs).toEqual(expectedRefs);
    expect(new Set(refundRefs).size).toBe(3);
  });

  it('a resolved (failed/refunded) child answers 409 and neither generates nor spends on re-execution — no free re-run', async () => {
    const { client, modelSpy } = sequencedClient(new Set([1]));
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: client,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: 'bundle-terminal',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    const { jobs } = submitResponse.json() as {
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };
    const firstChild = jobs[0]!;

    const firstAttempt = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: firstChild.opponentName,
        jobId: firstChild.jobId,
      },
    });
    expect(firstAttempt.statusCode).toBe(502);

    const balanceAfterFailure = await database.ref(`credits/${TEST_UID}/balance`).get();

    const secondAttempt = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: firstChild.opponentName,
        jobId: firstChild.jobId,
      },
    });

    expect(secondAttempt.statusCode).toBe(409);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    const balanceAfterSecondAttempt = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceAfterSecondAttempt.val()).toBe(balanceAfterFailure.val());
  });

  it('two concurrent executions of the same child id result in at most one report generation and exactly one refund on failure', async () => {
    const { client, modelSpy } = sequencedClient(new Set([1]));
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: client,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: 'bundle-concurrent',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    const { jobs } = submitResponse.json() as {
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };
    const firstChild = jobs[0]!;
    const executePayload = {
      reason: 'prep_report' as const,
      entryKey: ENTRY_KEY,
      opponentName: firstChild.opponentName,
      jobId: firstChild.jobId,
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: executePayload,
      }),
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: executePayload,
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([409, 502]);
    expect(modelSpy).toHaveBeenCalledTimes(1);

    const dump = database.dump() as Record<string, unknown>;
    const ledger = (dump.creditLedger as Record<string, Record<string, unknown>>)[TEST_UID]!;
    const refundEntries = Object.values(ledger).filter(
      (entry) => (entry as { type: string }).type === 'refund',
    );
    expect(refundEntries).toHaveLength(1);
  });

  it("a child of an allowlisted uid's bundle that fails performs no refund", async () => {
    const { client } = sequencedClient(new Set([1]));
    const { app, database } = buildTestApp({
      reports: REPORTS_ALLOWLIST_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: client,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: 'bundle-allowlisted',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    const { jobs } = submitResponse.json() as {
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };
    const firstChild = jobs[0]!;

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: firstChild.opponentName,
        jobId: firstChild.jobId,
      },
    });

    expect(response.statusCode).toBe(502);
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${firstChild.jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'failed', reason: 'prep_bundle' });
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.creditLedger).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.exists()).toBe(false);
  });

  it('a guessed bundle-shaped job id for a bundle that was never submitted falls through to the ordinary single-report path and spends a credit normally', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: 'rival1',
        jobId: 'never-submitted-bundle:1',
      },
    });

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(4);
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/never-submitted-bundle:1`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'succeeded', reason: 'prep_report' });
  });

  it('a bundle child swept by the stuck-job sweep keeps its `reason` and still 409s a replayed slot instead of spending/generating again (260806-hzx) — without the sweep fix this would spend a fourth credit and generate on an already-refunded slot', async () => {
    const { client, modelSpy } = sequencedClient(new Set());
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: client,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: 'bundle-swept',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    expect(submitResponse.statusCode).toBe(202);
    const { jobs } = submitResponse.json() as {
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };
    const firstChild = jobs[0]!;

    const balanceAfterSubmit = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceAfterSubmit.val()).toBe(7);

    // Force the first child into a stale `running` state — as if a request
    // crashed mid-generation — well past the sweep's 15-minute staleness
    // window, so this case does not depend on wall-clock timing.
    const now = Date.now();
    database.seed(`reportJobs/${TEST_UID}/${firstChild.jobId}`, {
      status: 'running',
      reason: 'prep_bundle',
      createdAt: now - 40 * 60 * 1000,
      updatedAt: now - 40 * 60 * 1000,
      attempt: 0,
      creditRef: firstChild.jobId,
    });
    database.seed(`reportJobsByStatus/running/${TEST_UID}/${firstChild.jobId}`, true);

    const sweepResult = await runSweepStuckReportJobs(database as never, { now });
    expect(sweepResult).toEqual({ swept: 1, refunded: 1 });

    const sweptJob = await database.ref(`reportJobs/${TEST_UID}/${firstChild.jobId}`).get();
    expect(sweptJob.val()).toMatchObject({ status: 'failed', reason: 'prep_bundle' });

    const balanceAfterSweep = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceAfterSweep.val()).toBe(8);

    // The 409 below is reachable ONLY because `reason` survived the sweep
    // — without Task 1's fix, `existingJob.reason` reads back undefined,
    // `preSpent` is false, and this retry spends a fourth credit and
    // generates a fresh report on a slot the bundle already paid for and
    // was refunded.
    const retryResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: firstChild.opponentName,
        jobId: firstChild.jobId,
      },
    });
    expect(retryResponse.statusCode).toBe(409);
    expect(retryResponse.json()).toMatchObject({
      message: 'This bundle report already resolved and must be purchased again',
    });

    const balanceAfterRetry = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balanceAfterRetry.val()).toBe(8);
    expect(modelSpy).toHaveBeenCalledTimes(0);
  });
});

describe('prep job status endpoint (RPT-03)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const BILLING_STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const ENTRY_KEY = 'evo-2026-ult';
  const PARRY_CLIENTS = parryClients({
    getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
  });

  it('returns one entry per index pointer, carrying opponent name, job id, status, updatedAt, and resultRef when succeeded', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: PARRY_CLIENTS,
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: 'bundle-status',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    const { jobs } = submitResponse.json() as {
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };

    // Execute only the first child, leaving the other two `queued`.
    await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: jobs[0]!.opponentName,
        jobId: jobs[0]!.jobId,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      jobs: Array<{
        opponentName: string;
        jobId: string;
        status: string;
        updatedAt: number;
        resultRef?: string;
      }>;
    };
    expect(body.jobs).toHaveLength(3);
    expect(body.jobs.map((entry) => entry.opponentName)).toEqual(['rival1', 'rival2', 'rival3']);
    const succeededEntry = body.jobs.find((entry) => entry.opponentName === 'rival1')!;
    expect(succeededEntry.status).toBe('succeeded');
    expect(typeof succeededEntry.resultRef).toBe('string');
    const queuedEntry = body.jobs.find((entry) => entry.opponentName === 'rival2')!;
    expect(queuedEntry.status).toBe('queued');
    expect(queuedEntry.resultRef).toBeUndefined();
  });

  it('returns an empty list for a brief with no submitted jobs', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);

    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobs: [] });
  });

  it('returns an empty list for an entry key the caller does not own — no existence leak', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
    });
    database.seed(`prepReportJobIndex/someone-else/${ENTRY_KEY}/rival1`, {
      jobId: 'foreign-job-1',
      updatedAt: Date.now(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobs: [] });
  });

  it('returns the same data whether the activation gate is on or off, and refuses a NEW purchase while off (owner battery item 8)', async () => {
    const { database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`reportJobs/${TEST_UID}/gate-off-job`, {
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      attempt: 0,
      creditRef: 'gate-off-job',
      reason: 'prep_report',
      resultRef: 'some-report-id',
    });
    database.seed(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/rival1`, {
      jobId: 'gate-off-job',
      updatedAt: 2,
    });

    // A SECOND app instance pointed at the SAME database, built WITHOUT the
    // paid-prep config — simulating the owner flipping the gate off after
    // this job was already created.
    const auth = new FakeAuth();
    auth.registerToken(TEST_TOKEN, { uid: TEST_UID, email: TEST_EMAIL });
    const gateOffApp = buildApp({
      firebase: {
        app: {} as never,
        auth: auth as unknown as Auth,
        database: database as unknown as Database,
      },
      logger: false,
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      // prepPaid deliberately omitted — the gate is off.
    });

    const statusResponse = await gateOffApp.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toEqual({
      jobs: [
        {
          opponentName: 'rival1',
          jobId: 'gate-off-job',
          status: 'succeeded',
          updatedAt: 2,
          resultRef: 'some-report-id',
        },
      ],
    });

    const newPurchaseResponse = await gateOffApp.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: ENTRY_KEY,
        opponentName: 'rival2',
        jobId: 'new-attempt-while-gate-off',
      },
    });
    expect(newPurchaseResponse.statusCode).toBe(503);
  });

  it('skips an index pointer whose job node has disappeared, returning 200 with the remaining entries', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
    });
    database.seed(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/rival1`, {
      jobId: 'missing-job',
      updatedAt: 1,
    });
    database.seed(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/rival2`, {
      jobId: 'present-job',
      updatedAt: 2,
    });
    database.seed(`reportJobs/${TEST_UID}/present-job`, {
      status: 'queued',
      createdAt: 1,
      updatedAt: 2,
      attempt: 0,
      creditRef: 'present-job',
      reason: 'prep_report',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { jobs: Array<{ opponentName: string; jobId: string }> };
    expect(body.jobs).toEqual([
      { opponentName: 'rival2', jobId: 'present-job', status: 'queued', updatedAt: 2 },
    ]);
  });

  it('performs zero writes', async () => {
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: BILLING_STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/rival1`, {
      jobId: 'some-job',
      updatedAt: 1,
    });
    database.seed(`reportJobs/${TEST_UID}/some-job`, {
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
      attempt: 0,
      creditRef: 'some-job',
      reason: 'prep_report',
    });
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('is refused for a caller who cannot read reports, using the same rule the existing read routes use', async () => {
    const { app } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      // stripe deliberately omitted — canReadReports is false for a
      // non-allowlisted uid with no billing configured.
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(403);
  });
});
