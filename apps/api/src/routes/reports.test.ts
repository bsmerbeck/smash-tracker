import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { StartggConfig, ReportsConfig } from '../config/env.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

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

const VALID_REPORT = {
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
    expect(response.json()).toEqual({ enabled: true });
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
    expect(response.json()).toEqual({ enabled: false });
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
      report: VALID_REPORT,
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

    // Assert the RTDB write.
    const dump = database.dump() as Record<string, unknown>;
    const scoutReports = dump.scoutReports as Record<string, Record<string, unknown>>;
    const stored = Object.values(scoutReports[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c' },
      report: VALID_REPORT,
    });
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
