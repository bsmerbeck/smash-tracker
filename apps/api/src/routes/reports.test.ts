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
  buildTestApp as buildBareTestApp,
  TEST_EMAIL,
  TEST_TOKEN,
  TEST_UID,
} from '../test-support/testApp.js';
import {
  seedViableEvidence,
  VIABLE_CLAIM_SELECTION,
  VIABLE_OPPONENT_SETS_RESPONSE,
  VIABLE_SELECTED_CLAIM_IDS,
  viableParryMatchesList,
} from '../test-support/viableEvidenceFixture.js';
import {
  buildClaimSet,
  CLAIM_SCHEMA_VERSION,
  evidenceSnapshotRecordSchema,
  MIN_VIABLE_CLAIMS,
  reportJobSchema,
  scoutReportRecordSchema,
  serializeCitationToken,
  storedScoutReportSchema,
  validateReportOutput,
  type ReportSurface,
  type ScoutBinding,
  type ScoutReportData,
} from '@smash-tracker/shared';
import { buildApp } from '../app.js';
import { runSweepStuckReportJobs } from '../jobs/sweepStuckReportJobs.js';
import { assembleReportPayload, REPORT_MODEL } from '../reports/generate.js';
import { projectScoutSelection } from '../reports/claimSelection.js';
import { buildScoutReport } from '../startgg/scout.js';
import { buildParryScoutReport } from '../parrygg/scout.js';
import { FakeDatabase as FakeDatabaseImpl } from '../test-support/fakeDatabase.js';

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

/**
 * Phase 39 (plan 39-06, review C3-B1): the scouted opponent's public history
 * is now VIABLE by default — three characters across two known stages
 * (`test-support/viableEvidenceFixture.ts`) — so every generation-success
 * case in this file assembles enough claims to clear `MIN_VIABLE_CLAIMS`
 * once plan 39-07's validator seam and D-21 fail-fast land.
 */
function scoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return gqlResponse(RESOLVE_RESPONSE);
    }
    return gqlResponse(VIABLE_OPPONENT_SETS_RESPONSE);
  }) as typeof fetch;
}

/** The explicit EMPTY opponent-history stub for thin-evidence cases (plans 39-07/39-08) — pair it with `buildBareTestApp`. */
function emptyScoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return gqlResponse(RESOLVE_RESPONSE);
    }
    return gqlResponse(EMPTY_SETS_RESPONSE);
  }) as typeof fetch;
}

/**
 * C3-B1: THE VIABLE-EVIDENCE WRAPPER. Every `buildTestApp(...)` call site in
 * this file — INCLUDING the ones inside the LOCKED `paid prep activation
 * gate (RPT-04)` and `bundle failure math (RPT-02/RPT-03, owner battery item
 * 3)` describe blocks — resolves this name at MODULE scope to this wrapper,
 * so those locked bodies run against a viable workspace without one byte
 * inside them changing. Do NOT "tidy" this back to a direct import of
 * `test-support/testApp.ts`'s `buildTestApp`: that would silently return
 * every generation-success case here to a zero-evidence workspace, which
 * plan 39-07's D-21 fail-fast turns into a refund. `testApp.ts` itself is
 * deliberately NOT modified (a default seed there would reach every API
 * suite). Thin-evidence cases use `buildBareTestApp` directly.
 */
function buildTestApp(options: Parameters<typeof buildBareTestApp>[0] = {}) {
  const built = buildBareTestApp(options);
  seedViableEvidence(built.database, TEST_UID, {
    opponentTag: RESOLVE_RESPONSE.user.player.gamerTag,
  });
  return built;
}

/**
 * C4-M1: the claim ids the module-level selection names — exactly the
 * contiguous LOWEST ids `c01`..`c{K}`, `K` the largest `MIN_VIABLE_CLAIMS`
 * among this file's generation surfaces (scout, prep single, bundle child),
 * read from the shared export inside the fixture module, never a literal.
 */
const SELECTED_CLAIM_IDS = VIABLE_SELECTED_CLAIM_IDS;

/**
 * Phase 39 (plan 39-06): the model's output is a claim SELECTION over the
 * fixed claim-id vocabulary (`reports/claimSelection.ts`), not a free-prose
 * report — the shared `VIABLE_CLAIM_SELECTION` (lint-clean connectives; the
 * union of its section ids is exactly `SELECTED_CLAIM_IDS`).
 */
const VALID_REPORT = VIABLE_CLAIM_SELECTION;

/**
 * What VALID_REPORT becomes once stored: `projectScoutSelection`'s output
 * over the claims that SURVIVED validation (plan 39-07 re-pointed the
 * projection from the issued claims to the surviving ones — review C1-B1).
 * Prose fields carry the selection's own connectives; `stageStrategy` is
 * ENGINE-derived from SURVIVING stage claims only — `VALID_REPORT` selects
 * `c01`..`c03`, none of which is a `stage_record` claim, so bans/picks are
 * empty (under 39-06's interim issued-claims projection they were one stage
 * each); `confidenceNotes` is empty (D-03); there is no `characterStrategy`
 * and no `headToHead` own-property. The `C3-B1` describe block at the end of
 * this file RE-DERIVES this constant from the projection under every
 * workspace shape and asserts it matches — it is never trusted as
 * hand-written.
 */
const STORED_VALID_REPORT = {
  overview: VALID_REPORT.sections.overview.connective,
  gameplan: [VALID_REPORT.sections.gameplan.connective],
  stageStrategy: {
    bans: [] as string[],
    picks: [] as string[],
    reasoning: VALID_REPORT.sections.gameplan.connective,
  },
  watchFor: [VALID_REPORT.sections.watchFor.connective],
  confidenceNotes: '',
};

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
    });
    // Plan 39-07: the surviving-claims projection stores empty stage lists,
    // which RTDB (and the fake) drop on write — the stored schema's
    // `.default([])` restores them, so compare the READ-BACK shape.
    expect(storedScoutReportSchema.parse(stored.report)).toMatchObject(STORED_VALID_REPORT);
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
        report: STORED_VALID_REPORT,
      },
      newer: {
        createdAt: 2000,
        model: 'claude-opus-4-8',
        player: { id: 2, gamerTag: 'New' },
        report: STORED_VALID_REPORT,
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
      report: STORED_VALID_REPORT,
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
      report: STORED_VALID_REPORT,
    });
  });
});

// ---------------------------------------------------------------------------
// V9-B Feature 4: parry.gg-sourced report generation.
// ---------------------------------------------------------------------------

const PARRY_USER_ID = '019ce9ba-debd-7e11-84a2-77258f52644e';

/**
 * Phase 39 (plan 39-06, C3-B1): `matches.getMatches` now returns the VIABLE
 * public history for `PARRY_USER_ID` by default; `matches: 'empty'` asks for
 * the empty list back (thin-evidence cases, plans 39-07/39-08). The
 * `users.getUser` behaviour is unchanged — `getUser: () => null` still fails
 * to resolve.
 */
function parryClients(overrides: {
  getUser?: () => { id: string; gamerTag: string } | null;
  matches?: 'viable' | 'empty';
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
      getMatches: vi.fn(async () => ({
        getMatchesList: () =>
          overrides.matches === 'empty' ? [] : viableParryMatchesList(PARRY_USER_ID),
      })),
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

// ---------------------------------------------------------------------------
// Phase 29 (RTEN-05A/RTEN-04, plan 29-11): the research-subject refusal.
// ---------------------------------------------------------------------------

describe('research-subject report refusal (RTEN-05A/RTEN-04, plan 29-11)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set([TEST_UID]),
  };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const STRIPE_CONFIG: StripeConfig = {
    secretKey: 'sk-test-123',
    webhookSecret: 'whsec-test-456',
  };
  const RESEARCH_TENANT_ID = 'research-tenant-29-11';
  const ORDINARY_TENANT_ID = 'ordinary-tenant-29-11';
  const PREP_REQUEST_BODY = {
    reason: 'prep_report' as const,
    entryKey: 'evo-2026-ult',
    opponentName: 'rival',
  };

  function seedResearchTenant(database: FakeDatabase, tenantId: string): void {
    database.seed(`clientTenants/${tenantId}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
  }

  function seedOrdinaryTenant(database: FakeDatabase, tenantId: string): void {
    database.seed(`clientTenants/${tenantId}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'coaching',
    });
  }

  function seedMembership(database: FakeDatabase, tenantId: string, uid: string): void {
    database.seed(`clientMembers/${tenantId}/${uid}`, { role: 'custodian', joinedAt: 1 });
  }

  /** B-event emission (`void createEvent(...)`) is fire-and-forget — flush before asserting on telemetry trees. Mirrors `billing/credits.test.ts`'s own `flush()`. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Makes the membership read at `clientMembers/{tenantId}/{TEST_UID}` throw, delegating every other path to the real FakeDatabase — simulates a genuine infrastructure failure, distinct from a well-formed id with no membership record. */
  function makeMembershipReadThrow(database: FakeDatabase, tenantId: string): void {
    const originalRef = database.ref.bind(database);
    vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
      if (path === `clientMembers/${tenantId}/${TEST_UID}`) {
        return {
          ...originalRef(path),
          get: async () => {
            throw new Error('simulated membership read failure');
          },
        };
      }
      return originalRef(path);
    });
  }

  it("answers the activation gate's 503 for a research-subject request while the gate is off, with nothing written", async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
      // prepPaid deliberately omitted — gate off.
    });
    seedResearchTenant(database, RESEARCH_TENANT_ID);
    seedMembership(database, RESEARCH_TENANT_ID, TEST_UID);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(), 'x-active-subject': `client:${RESEARCH_TENANT_ID}` },
      payload: PREP_REQUEST_BODY,
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('refuses a research-classified request with zero database residue and zero rows across all three telemetry trees, queue drained', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    seedResearchTenant(database, RESEARCH_TENANT_ID);
    seedMembership(database, RESEARCH_TENANT_ID, TEST_UID);
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(), 'x-active-subject': `client:${RESEARCH_TENANT_ID}` },
      payload: PREP_REQUEST_BODY,
    });
    await flush();

    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(database.dump())).toEqual(before);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.reportJobs).toBeUndefined();
    expect(dump.creditLedger).toBeUndefined();
    expect(dump.eventLedger).toBeUndefined();
    expect(dump.eventDedup).toBeUndefined();
    expect(dump.outboxPending).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(5);
  });

  it('refuses an indeterminate-classified request identically (a rejecting membership read never becomes a charge or a free ride)', async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    database.seed(`credits/${TEST_UID}/balance`, 5);
    makeMembershipReadThrow(database, RESEARCH_TENANT_ID);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(), 'x-active-subject': `client:${RESEARCH_TENANT_ID}` },
      payload: PREP_REQUEST_BODY,
    });
    await flush();

    expect(response.statusCode).toBe(403);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.reportJobs).toBeUndefined();
    expect(dump.eventLedger).toBeUndefined();
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(5);
  });

  it('behaves byte-identically for a coach generating a report while a member of an ORDINARY client tenant — spends and emits like today', async () => {
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
    seedOrdinaryTenant(database, ORDINARY_TENANT_ID);
    seedMembership(database, ORDINARY_TENANT_ID, TEST_UID);
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(), 'x-active-subject': `client:${ORDINARY_TENANT_ID}` },
      payload: { query: 'user/07dc2239' },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(4);
    const dump = database.dump() as Record<string, unknown>;
    const ledger = (dump.eventLedger ?? {}) as Record<string, Record<string, unknown>>;
    const creditSpentEvents = Object.values(ledger).flatMap((dayBucket) =>
      Object.values(dayBucket).filter(
        (entry) => (entry as { eventName?: string }).eventName === 'credit_spent',
      ),
    );
    expect(creditSpentEvents).toHaveLength(1);
  });

  it("a non-member naming a real research tenant gets today's behavior, not the refusal (no-oracle)", async () => {
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    seedResearchTenant(database, RESEARCH_TENANT_ID);
    // Deliberately no membership record for TEST_UID.

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(), 'x-active-subject': `client:${RESEARCH_TENANT_ID}` },
      payload: { query: 'user/07dc2239' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('positive control: an ordinary request (no header) spends and emits — proves the zero-event assertions above are not vacuous', async () => {
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
    database.seed(`credits/${TEST_UID}/balance`, 5);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(4);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.eventLedger).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-06, review C3-B1 / C4-M1): the viable-evidence fixture is
// PROVEN, not assumed. Every app below is built EXACTLY as the named locked
// case builds its own — through this file's module-level `buildTestApp`
// wrapper and stubs, with nothing seeded in the test body — and the claims
// the assembled payload issues are read back off the ONE model call. This
// block lives OUTSIDE both locked describes and adds no test to them.
// ---------------------------------------------------------------------------

describe('C3-B1 viable-evidence fixture: locked-block reachability and original-cause preservation (plan 39-06)', () => {
  const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
  const STRIPE_CONFIG: StripeConfig = { secretKey: 'sk-test-123', webhookSecret: 'whsec-test-456' };
  const NON_ALLOWLIST_CONFIG: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(['someone-else']),
  };
  const ENTRY_KEY = 'evo-2026-ult';
  const BUNDLE_BINDING: ScoutBinding = {
    provider: 'parrygg',
    parryUserId: PARRY_USER_ID,
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1,
  };

  /**
   * The claim ids the assembled payload issued, read off the model call's
   * user message — the one place the route hands the assembled payload
   * across a seam a test can observe without mocking a module.
   */
  function issuedClaimIdsFromModelCall(params: unknown): string[] {
    const content = (params as { messages: Array<{ content: string }> }).messages[0]!.content;
    const payload = JSON.parse(content) as { claims: Array<{ id: string }> };
    return payload.claims.map((claim) => claim.id);
  }

  function capturingClient(failCalls: ReadonlySet<number> = new Set()) {
    const calls: unknown[] = [];
    const modelSpy = vi.fn(async (params: unknown) => {
      calls.push(params);
      return failCalls.has(calls.length)
        ? { stop_reason: 'refusal' as const, parsed_output: null }
        : { stop_reason: 'end_turn' as const, parsed_output: VALID_REPORT };
    });
    return { client: stubClient(modelSpy), calls, modelSpy };
  }

  /**
   * Block A's shape — `a request without reason behaves exactly as today
   * whether the gate is on or off` (locked, `paid prep activation gate
   * (RPT-04)`): module-level `buildTestApp` + `scoutFetchMock()` +
   * REPORTS_CONFIG + a stripe config, nothing seeded in the body. Seeds and
   * stubs: the wrapper seeds the own history (three opponent characters x two
   * stages, at the floor, all against the scouted tag); `scoutFetchMock()`
   * returns the viable public history. Families licensed: stage_record +
   * stage_pick_rate (6+6), character_matchup_record (3), my_character_record,
   * head_to_head_record, recent_form, cohort_disclosure, opponent_character_usage
   * (3), matchup_advisor_pick (3) — 25 rows, 25 claims, all well above the
   * scout minimum. The gate-on half of that locked case is the same shape.
   */
  it('block A: the locked legacy-scout shape issues at least MIN_VIABLE_CLAIMS.scout claims, and every selected id is among them', async () => {
    for (const prepPaid of [null, PREP_PAID_CONFIG]) {
      const { client, calls } = capturingClient();
      const { app } = buildTestApp({
        startgg: STARTGG_CONFIG,
        startggFetch: scoutFetchMock(),
        reports: REPORTS_CONFIG,
        stripe: STRIPE_CONFIG,
        ...(prepPaid ? { prepPaid } : {}),
        reportsClient: client,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: { query: 'user/07dc2239' },
      });
      expect(response.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      const issued = issuedClaimIdsFromModelCall(calls[0]);
      expect(issued.length).toBeGreaterThanOrEqual(MIN_VIABLE_CLAIMS.scout);
      for (const id of SELECTED_CLAIM_IDS) {
        expect(issued).toContain(id);
      }
    }
  });

  /**
   * The parry.gg-scouted shape (`generates and stores a report for a
   * parry.gg-scouted player`): no start.gg config, `parryClients({ getUser })`
   * whose default `getMatches` is the viable public history. Same families
   * as block A (the tag matches, so head-to-head is present too).
   */
  it('parry-scouted shape: issues at least MIN_VIABLE_CLAIMS.scout claims, and every selected id is among them', async () => {
    const { client, calls } = capturingClient();
    const { app } = buildTestApp({
      reports: REPORTS_CONFIG,
      reportsClient: client,
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
    const issued = issuedClaimIdsFromModelCall(calls[0]);
    expect(issued.length).toBeGreaterThanOrEqual(MIN_VIABLE_CLAIMS.scout);
    for (const id of SELECTED_CLAIM_IDS) {
      expect(issued).toContain(id);
    }
  });

  /** Builds an app EXACTLY as the locked `runFailureMathCase` does, submits the bundle, and returns the child jobs. */
  async function bundleMathShape(failCalls: ReadonlySet<number>) {
    const { client, calls, modelSpy } = capturingClient(failCalls);
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      reportsClient: client,
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedBundleBrief(database, TEST_UID, ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const submit = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: ENTRY_KEY,
        bundleId: 'bundle-c3b1',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    expect(submit.statusCode).toBe(202);
    const { jobs } = submit.json() as {
      jobs: Array<{ opponentName: string; jobId: string; slot: number }>;
    };
    return { app, database, jobs, calls, modelSpy };
  }

  /**
   * Block B's shape — `runFailureMathCase` (locked, `bundle failure math`):
   * `parryClients({ getUser })` + `seedBundleBrief`, NO start.gg config. The
   * wrapper's own history is against the scouted TAG, and a bound prep child
   * matches head-to-head by IDENTITY (the binding's parry id) or the curated
   * name ('rival1'..'rival3') — never by that tag — so head-to-head is ABSENT
   * here: 24 rows (block A's families minus head_to_head_record), still far
   * above the bundle-child minimum.
   */
  it('block B: the locked bundle-math shape issues at least MIN_VIABLE_CLAIMS.prep_bundle_child claims per child, and every selected id is among them', async () => {
    const { app, jobs, calls } = await bundleMathShape(new Set());
    for (const job of jobs) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: {
          reason: 'prep_report',
          entryKey: ENTRY_KEY,
          opponentName: job.opponentName,
          jobId: job.jobId,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ report: STORED_VALID_REPORT });
    }
    expect(calls).toHaveLength(jobs.length);
    for (const call of calls) {
      const issued = issuedClaimIdsFromModelCall(call);
      expect(issued.length).toBeGreaterThanOrEqual(MIN_VIABLE_CLAIMS.prep_bundle_child);
      for (const id of SELECTED_CLAIM_IDS) {
        expect(issued).toContain(id);
      }
    }
  });

  it('original cause preserved: a locked-shaped refusal (stop_reason refusal, parsed_output null) against the VIABLE fixture still reaches the model, refunds once, and records no validation cause', async () => {
    const { app, database, jobs, modelSpy } = await bundleMathShape(new Set([1]));
    const firstChild = jobs[0]!;
    const balanceBefore = (await database.ref(`credits/${TEST_UID}/balance`).get()).val();

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
    // The model WAS reached — the failure is the refusal, never thin evidence.
    expect(modelSpy).toHaveBeenCalledTimes(1);
    const job = (await database.ref(`reportJobs/${TEST_UID}/${firstChild.jobId}`).get()).val() as {
      status: string;
      failureReason?: string;
    };
    expect(job.status).toBe('refunded');
    expect(job.failureReason).not.toBe('validation');
    // Money oracle: the balance and the refund ledger — never the deduped
    // `credit_refunded` event.
    const balanceAfter = (await database.ref(`credits/${TEST_UID}/balance`).get()).val();
    expect(balanceAfter).toBe((balanceBefore as number) + 1);
    const ledger = (database.dump() as { creditLedger: Record<string, Record<string, unknown>> })
      .creditLedger[TEST_UID]!;
    const refunds = Object.values(ledger).filter(
      (entry) => (entry as { type: string; ref: string }).type === 'refund',
    ) as Array<{ ref: string }>;
    expect(refunds.map((entry) => entry.ref)).toEqual([firstChild.jobId]);
  });

  it('FALSIFIER: the bare harness with the empty opponent stub issues FEWER than the scout minimum — the fixture, not the harness, is what makes block A viable', async () => {
    // Plan 39-07 (D-21): below the minimum the route now FAILS FAST with no
    // model call, so the issued count is read from the same assembly the
    // route runs rather than off a model call that no longer happens.
    const { client, calls } = capturingClient();
    const { app } = buildBareTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: emptyScoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: client,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    expect(response.statusCode).toBe(502);
    expect(calls).toHaveLength(0);
    const scout = await buildScoutReport(
      'server-data-token',
      { id: RESOLVE_RESPONSE.user.player.id, gamerTag: RESOLVE_RESPONSE.user.player.gamerTag },
      emptyScoutFetchMock(),
    );
    const payload = await assembleReportPayload(
      TEST_UID,
      scout,
      new FakeDatabaseImpl() as unknown as Database,
    );
    expect(payload.claimSet.claims.length).toBeLessThan(MIN_VIABLE_CLAIMS.scout);
    expect(EMPTY_SETS_RESPONSE.player.sets.nodes).toHaveLength(0);
  });

  /**
   * The stored fixture is RE-DERIVED from the projection under each shape,
   * and the selection is validated against the real snapshot the shape
   * assembles — so `STORED_VALID_REPORT` is never a hand-written guess, and
   * `VALID_REPORT`'s prose is lint-clean (no stripped section, no dropped
   * claim) under plan 39-04's validator ahead of plan 39-07 wiring it in.
   */
  async function assembleShape(shape: 'startgg' | 'parry' | 'bundle') {
    const database = new FakeDatabaseImpl();
    seedViableEvidence(database, TEST_UID, { opponentTag: RESOLVE_RESPONSE.user.player.gamerTag });
    let scout: ScoutReportData;
    if (shape === 'startgg') {
      scout = await buildScoutReport(
        'server-data-token',
        { id: RESOLVE_RESPONSE.user.player.id, gamerTag: RESOLVE_RESPONSE.user.player.gamerTag },
        scoutFetchMock(),
      );
    } else {
      scout = await buildParryScoutReport(
        'parry-key',
        { parryUserId: PARRY_USER_ID, gamerTag: 'Pandem1c' },
        parryClients({}),
      );
    }
    return assembleReportPayload(
      TEST_UID,
      scout,
      database as unknown as Database,
      shape === 'bundle'
        ? { binding: BUNDLE_BINDING, curatedCanonicalName: BUNDLE_OPPONENT_NAMES[0] }
        : undefined,
    );
  }

  const SHAPES: ReadonlyArray<{ shape: 'startgg' | 'parry' | 'bundle'; surface: ReportSurface }> = [
    { shape: 'startgg', surface: 'scout' },
    { shape: 'parry', surface: 'scout' },
    { shape: 'bundle', surface: 'prep_bundle_child' },
  ];

  for (const { shape, surface } of SHAPES) {
    it(`${shape} shape: projectScoutSelection re-derives STORED_VALID_REPORT, and the validator passes the selection with nothing dropped or stripped`, async () => {
      const payload = await assembleShape(shape);
      const claims = payload.claimSet.claims;
      const outcome = validateReportOutput({
        snapshot: payload.snapshot,
        issuedClaims: claims,
        output: VALID_REPORT,
        surface,
      });
      // Plan 39-07: the route projects over the SURVIVING claims (review
      // C1-B1), so the re-derivation does too.
      const survivingIds = new Set(outcome.survivingClaimIds);
      const survivingClaims = claims.filter((claim) => survivingIds.has(claim.id));
      const {
        claimSchemaVersion,
        claims: storedClaims,
        sections,
        actions,
        ...legacyFields
      } = projectScoutSelection({
        selection: VALID_REPORT,
        claims: survivingClaims,
        strippedSectionIds: outcome.strippedSectionIds,
      });
      // The legacy fields are EXACTLY the module-level stored fixture...
      expect(legacyFields).toEqual(STORED_VALID_REPORT);
      // ...and the additive claim fields carry the surviving claims and the
      // selection's sections (no action was selected, so no actions map).
      expect(claimSchemaVersion).toBe(CLAIM_SCHEMA_VERSION);
      expect(Object.keys(storedClaims ?? {})).toEqual(survivingClaims.map((claim) => claim.id));
      expect(Object.keys(sections ?? {})).toEqual(['overview', 'gameplan', 'watchFor']);
      expect(actions).toBeUndefined();
      expect(outcome.status).toBe('passed');
      expect(outcome.droppedClaimCount).toBe(0);
      expect(outcome.strippedSectionIds).toEqual([]);
      expect([...outcome.survivingClaimIds].sort()).toEqual([...SELECTED_CLAIM_IDS].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-07): the snapshot, the validator seam and the D-21
// fail-fast on the job path. EVERY block below is NEW — no assertion lands
// inside a locked describe. Money oracle throughout: the credit BALANCE and
// the `refund` entries of `creditLedger/{uid}` — NEVER the `credit_refunded`
// event count, which `createEvent` dedupes on the causation id built from
// the credit ref (a double refund still emits ONE event while the balance
// gains two).
// ---------------------------------------------------------------------------

const P39_NON_ALLOWLIST_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set(['someone-else']),
};
const P39_STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk-test-123',
  webhookSecret: 'whsec-test-456',
};
const P39_PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
const P39_ENTRY_KEY = 'evo-2026-ult';
const P39_PARRY_BINDING = {
  provider: 'parrygg',
  parryUserId: PARRY_USER_ID,
  displayTag: 'Pandem1c',
  method: 'matchHistory',
  confirmedAt: 1,
};
const SNAPSHOT_ID_SHAPE = /^[0-9a-f]{64}$/;
/** A connective carrying an unlicensed number — plan 39-04's R4 strips the section's prose, never its claims. */
const UNLICENSED_NUMBER_CONNECTIVE = 'Keep the opening 97 games steady.';
/** A connective naming the unknown bucket as real — R7 (lexical) withholds that section's PROSE only and never drops a claim (owner decision D-22). */
const UNKNOWN_BUCKET_CONNECTIVE = 'Ban the Unknown Stage early.';

interface ModelFacingClaimView {
  id: string;
  predicate: string;
  value: { kind: string; wins?: number; losses?: number };
  displayName: { stage?: string };
}

/** The engine-issued claims the route handed the model, read off the stub's own call. */
function modelFacingClaims(params: unknown): ModelFacingClaimView[] {
  const content = (params as { messages: Array<{ content: string }> }).messages[0]!.content;
  return (JSON.parse(content) as { claims: ModelFacingClaimView[] }).claims;
}

/** A claim selection over explicit per-section claim ids, reusing VALID_REPORT's lint-clean connectives unless overridden. */
function selectionOf(
  claimIds: { overview: string[]; gameplan: string[]; watchFor: string[] },
  connectives: Partial<Record<'overview' | 'gameplan' | 'watchFor', string>> = {},
  actions: Partial<
    Record<'action1' | 'action2' | 'action3', { actionId: string; claimId: string | null } | null>
  > = {},
) {
  return {
    sections: {
      overview: {
        claimIds: claimIds.overview,
        connective: connectives.overview ?? VALID_REPORT.sections.overview.connective,
      },
      gameplan: {
        claimIds: claimIds.gameplan,
        connective: connectives.gameplan ?? VALID_REPORT.sections.gameplan.connective,
      },
      watchFor: {
        claimIds: claimIds.watchFor,
        connective: connectives.watchFor ?? VALID_REPORT.sections.watchFor.connective,
      },
    },
    action1: actions.action1 ?? null,
    action2: actions.action2 ?? null,
    action3: actions.action3 ?? null,
  };
}

function refundLedgerRefs(database: FakeDatabase): string[] {
  const dump = database.dump() as { creditLedger?: Record<string, Record<string, unknown>> };
  return Object.values(dump.creditLedger?.[TEST_UID] ?? {})
    .filter((entry) => (entry as { type: string }).type === 'refund')
    .map((entry) => (entry as { ref: string }).ref);
}

async function balanceOf(database: FakeDatabase): Promise<unknown> {
  return (await database.ref(`credits/${TEST_UID}/balance`).get()).val();
}

async function jobRecord(database: FakeDatabase, jobId: string): Promise<Record<string, unknown>> {
  return (await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get()).val() as Record<
    string,
    unknown
  >;
}

function snapshotNodes(database: FakeDatabase): Record<string, unknown> {
  const dump = database.dump() as { evidenceSnapshots?: Record<string, Record<string, unknown>> };
  return dump.evidenceSnapshots?.[TEST_UID] ?? {};
}

function storedScoutReports(database: FakeDatabase): Array<Record<string, unknown>> {
  const dump = database.dump() as { scoutReports?: Record<string, Record<string, unknown>> };
  return Object.values(dump.scoutReports?.[TEST_UID] ?? {}) as Array<Record<string, unknown>>;
}

/** A billable legacy start.gg scout app over the VIABLE workspace whose model returns `respond(params)`. */
function legacyBillableApp(respond: (params: unknown) => unknown) {
  const modelSpy = vi.fn(async (params: unknown) => ({
    stop_reason: 'end_turn' as const,
    parsed_output: respond(params),
  }));
  const built = buildTestApp({
    startgg: STARTGG_CONFIG,
    startggFetch: scoutFetchMock(),
    reports: P39_NON_ALLOWLIST_CONFIG,
    stripe: P39_STRIPE_CONFIG,
    reportsClient: stubClient(modelSpy),
  });
  built.database.seed(`credits/${TEST_UID}/balance`, 1);
  return { ...built, modelSpy };
}

async function postLegacy(app: ReturnType<typeof buildTestApp>['app'], jobId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/reports',
    headers: authHeader(),
    payload: { query: 'user/07dc2239', jobId },
  });
}

describe('evidence snapshot + validator seam on the LEGACY scout path (plan 39-07, RPT-07/D-05/D-06/D-07)', () => {
  it('writes the snapshot at evidenceSnapshots/{uid}/{64-hex id} BEFORE the model is called (the stub observes it)', async () => {
    let observedAtModelCall: Record<string, unknown> | null = null;
    let db: FakeDatabase | null = null;
    const { app, database } = legacyBillableApp(() => {
      observedAtModelCall = snapshotNodes(db!);
      return VALID_REPORT;
    });
    db = database;

    const response = await postLegacy(app, 'p39-snapshot-order');
    expect(response.statusCode).toBe(200);
    const ids = Object.keys(observedAtModelCall ?? {});
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(SNAPSHOT_ID_SHAPE);
    // The node the model call observed IS the node the stored report cites.
    const body = response.json() as { report: { validation: { snapshotId: string } } };
    expect(body.report.validation.snapshotId).toBe(ids[0]);
    // Content-addressed, never keyed by the job id.
    expect(ids[0]).not.toContain('p39-snapshot-order');
  });

  it('a second submission over identical evidence reuses the SAME content-addressed node and leaves its content byte-identical', async () => {
    const { app, database } = legacyBillableApp(() => VALID_REPORT);
    database.seed(`credits/${TEST_UID}/balance`, 2);

    expect((await postLegacy(app, 'p39-snap-a')).statusCode).toBe(200);
    const first = snapshotNodes(database);
    const firstBytes = JSON.stringify(first);
    expect(Object.keys(first)).toHaveLength(1);

    expect((await postLegacy(app, 'p39-snap-b')).statusCode).toBe(200);
    const second = snapshotNodes(database);
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(JSON.stringify(second)).toBe(firstBytes);
    // Both stored reports cite the one snapshot.
    const cited = storedScoutReports(database).map(
      (record) => (record.report as { validation: { snapshotId: string } }).validation.snapshotId,
    );
    expect(cited).toEqual([Object.keys(first)[0], Object.keys(first)[0]]);
  });

  it('a validation-FAILING response yields a failed job with failureReason validation, exactly one refund effect, no stored report, and one report_failed_validation', async () => {
    // Two surviving claims — one below MIN_VIABLE_CLAIMS.scout — plus an
    // UNISSUED in-vocabulary id (rule R1) that is dropped.
    const { app, database, modelSpy } = legacyBillableApp(() =>
      selectionOf({ overview: ['c01'], gameplan: ['c02'], watchFor: ['c32'] }),
    );

    const response = await postLegacy(app, 'p39-legacy-invalid');
    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(1);

    const job = await jobRecord(database, 'p39-legacy-invalid');
    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('validation');
    expect(job).not.toHaveProperty('reason');
    expect(await balanceOf(database)).toBe(1);
    expect(refundLedgerRefs(database)).toEqual(['p39-legacy-invalid']);
    expect(storedScoutReports(database)).toHaveLength(0);
    expect(findEvents(database, 'report_failed')).toHaveLength(1);
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
    expect(findEvents(database, 'report_completed')).toHaveLength(0);
  });

  it('a validation-PASSING response stores validation.snapshotId equal to the written snapshot id, keyed claims/sections maps, and a keyed action slot', async () => {
    const { app, database } = legacyBillableApp(() =>
      selectionOf(
        { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] },
        {},
        { action1: null, action2: null, action3: null },
      ),
    );

    const response = await postLegacy(app, 'p39-legacy-valid');
    expect(response.statusCode).toBe(200);
    const [snapshotId] = Object.keys(snapshotNodes(database));
    const [stored] = storedScoutReports(database);
    const report = stored!.report as Record<string, unknown>;
    expect(report.validation).toEqual({
      status: 'passed',
      policyVersion: expect.any(Number),
      snapshotId,
      claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    });
    expect(report.claimSchemaVersion).toBe(CLAIM_SCHEMA_VERSION);
    expect(Array.isArray(report.claims)).toBe(false);
    expect(Object.keys(report.claims as Record<string, unknown>).sort()).toEqual([
      'c01',
      'c02',
      'c03',
    ]);
    expect(Array.isArray(report.sections)).toBe(false);
    expect(Object.keys(report.sections as Record<string, unknown>)).toEqual([
      'overview',
      'gameplan',
      'watchFor',
    ]);
    expect(report).not.toHaveProperty('droppedClaimCount');
    expect(report).not.toHaveProperty('strippedSectionCount');
    expect(storedScoutReportSchema.safeParse(report).success).toBe(true);
    const job = await jobRecord(database, 'p39-legacy-valid');
    expect(job.status).toBe('succeeded');
    expect(job).not.toHaveProperty('failureReason');
    expect(refundLedgerRefs(database)).toEqual([]);
  });

  it("C1-B1 / D-22: stageStrategy is projected from SURVIVING stage claims — an unknown-bucket prose hit in the stage claim's section withholds that prose but no longer drops the claim, so its stage name is still projected", async () => {
    const stageNameOf = (claims: ModelFacingClaimView[]) => {
      const stageClaim = claims.find(
        (claim) =>
          claim.predicate === 'stage_record' &&
          claim.value.kind === 'record' &&
          (claim.value.wins ?? 0) !== (claim.value.losses ?? 0) &&
          claim.displayName.stage !== undefined,
      );
      expect(stageClaim).toBeDefined();
      return stageClaim!;
    };
    let stageClaim: ModelFacingClaimView | null = null;

    // Control: the stage claim survives, so its stage name IS projected.
    const control = legacyBillableApp((params) => {
      stageClaim = stageNameOf(modelFacingClaims(params));
      return selectionOf({
        overview: ['c01'],
        gameplan: ['c02'],
        watchFor: ['c03', stageClaim.id],
      });
    });
    expect((await postLegacy(control.app, 'p39-stage-kept')).statusCode).toBe(200);
    const kept = storedScoutReportSchema.parse(storedScoutReports(control.database)[0]!.report);
    const stageName = stageClaim!.displayName.stage!;
    expect([...kept.stageStrategy.bans, ...kept.stageStrategy.picks]).toContain(stageName);

    // Owner decision D-22 (2026-09-26, updated from the pre-D-22 "dropped"
    // expectation): the stage claim sits alone in a section whose prose
    // names the unknown bucket. Before D-22 that R7 lexical hit DROPPED the
    // claim; now it withholds the section's PROSE only — the claim is
    // engine-authored and judged on its own ids — so the claim is stored,
    // its stage name is still projected, nothing counts as dropped, and the
    // withheld prose is disclosed through strippedSectionCount. No model
    // selection over engine-issued claims can drop a stage claim any more
    // (only an unissued id is dropped, R1), so C1-B1's "dropped claim adds
    // no stage name" half is the projection's own surviving-claims input.
    const withheld = legacyBillableApp((params) => {
      const claim = stageNameOf(modelFacingClaims(params));
      return selectionOf(
        { overview: ['c01', 'c03'], gameplan: ['c02'], watchFor: [claim.id] },
        { watchFor: UNKNOWN_BUCKET_CONNECTIVE },
      );
    });
    expect((await postLegacy(withheld.app, 'p39-stage-withheld')).statusCode).toBe(200);
    const storedWithheld = storedScoutReports(withheld.database)[0]!.report as Record<
      string,
      unknown
    >;
    const parsed = storedScoutReportSchema.parse(storedWithheld);
    expect([...parsed.stageStrategy.bans, ...parsed.stageStrategy.picks]).toContain(stageName);
    expect(Object.keys(parsed.claims ?? {})).toContain(stageClaim!.id);
    expect(storedWithheld).not.toHaveProperty('droppedClaimCount');
    expect(parsed.strippedSectionCount).toBe(1);
    expect(parsed.sections?.watchFor?.connective).toBe('');
    // Delivered AND charged (D-20/D-22): withheld prose never refunds.
    expect(refundLedgerRefs(withheld.database)).toEqual([]);
  });

  it('C3-M1/D-20: one stripped section stores strippedSectionCount 1 and emits exactly one report_prose_stripped whose payload carries no count', async () => {
    const { app, database } = legacyBillableApp(() =>
      selectionOf(
        { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] },
        { overview: UNLICENSED_NUMBER_CONNECTIVE },
      ),
    );
    expect((await postLegacy(app, 'p39-stripped-one')).statusCode).toBe(200);
    const report = storedScoutReports(database)[0]!.report as Record<string, unknown>;
    expect(report.strippedSectionCount).toBe(1);
    expect((report.sections as Record<string, { connective: string }>).overview!.connective).toBe(
      '',
    );
    expect(report.overview).toBe('');
    const events = findEvents(database, 'report_prose_stripped');
    expect(events).toHaveLength(1);
    // Aggregate-only ledger: an occurrence signal, never a count.
    expect(events[0]!.payload).toEqual({});
    expect(Object.values(events[0]!.payload)).not.toContain(1);
    // Delivered AND charged (D-20): no refund on stripped prose.
    expect(refundLedgerRefs(database)).toEqual([]);
    expect(await balanceOf(database)).toBe(0);
  });

  it('C3-M1/D-20: a report with zero stripped sections carries NO strippedSectionCount key and emits no report_prose_stripped', async () => {
    const { app, database } = legacyBillableApp(() => VALID_REPORT);
    expect((await postLegacy(app, 'p39-stripped-none')).statusCode).toBe(200);
    const report = storedScoutReports(database)[0]!.report as Record<string, unknown>;
    expect(report).not.toHaveProperty('strippedSectionCount');
    expect(findEvents(database, 'report_prose_stripped')).toHaveLength(0);
  });

  it('C2-H2: a record the stored schema REJECTS (an empty action id the projection copies through) refunds once through failJob — no 500, no job left running', async () => {
    const { app, database } = legacyBillableApp(() =>
      selectionOf(
        { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] },
        {},
        { action1: { actionId: '', claimId: 'c01' } },
      ),
    );
    const response = await postLegacy(app, 'p39-schema-reject');
    expect(response.statusCode).toBe(502);
    const job = await jobRecord(database, 'p39-schema-reject');
    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('validation');
    expect(refundLedgerRefs(database)).toEqual(['p39-schema-reject']);
    expect(await balanceOf(database)).toBe(1);
    expect(storedScoutReports(database)).toHaveLength(0);
    const running = await database
      .ref(`reportJobsByStatus/running/${TEST_UID}/p39-schema-reject`)
      .get();
    expect(running.exists()).toBe(false);
  });

  it('C2-H2: a selection that makes the validator THROW (a malformed sections object) takes the same single-refund branch — never an uncaught error', async () => {
    const { app, database } = legacyBillableApp(() => ({
      sections: null,
      action1: null,
      action2: null,
      action3: null,
    }));
    const response = await postLegacy(app, 'p39-validator-throw');
    expect(response.statusCode).toBe(502);
    const job = await jobRecord(database, 'p39-validator-throw');
    expect(job).toMatchObject({ status: 'failed', failureReason: 'validation' });
    expect(refundLedgerRefs(database)).toEqual(['p39-validator-throw']);
    expect(await balanceOf(database)).toBe(1);
  });

  /**
   * C2-H2 strip/drop LATTICE (property-style, scout surface): each of the
   * three sections stripped or not (8 combinations) x the surviving-claim
   * count driven below, exactly at and above MIN_VIABLE_CLAIMS.scout. EVERY
   * cell ends in exactly one of {a stored record storedScoutReportSchema
   * accepts + report_completed} or {one failJob, failureReason validation,
   * EXACTLY ONE refund effect}, and no cell throws. The all-three-stripped
   * cells at/above the minimum must land in the STORED branch: plan 39-04
   * removed the total-prose-loss failure (review C2-H3) — prose is never a
   * failure axis, the surviving claim count is.
   */
  it('C2-H2 lattice: every (strip combination x claim-count band) cell ends in exactly one of stored-valid or one-refund, and none throws', async () => {
    const min = MIN_VIABLE_CLAIMS.scout;
    const bands: Array<{
      name: string;
      ids: { overview: string[]; gameplan: string[]; watchFor: string[] };
    }> = [
      { name: 'below', ids: { overview: ['c01'], gameplan: ['c02'], watchFor: [] } },
      { name: 'at', ids: { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] } },
      { name: 'above', ids: { overview: ['c01', 'c04'], gameplan: ['c02'], watchFor: ['c03'] } },
    ];
    const sectionNames = ['overview', 'gameplan', 'watchFor'] as const;
    let cells = 0;
    for (const band of bands) {
      const survivors = [...band.ids.overview, ...band.ids.gameplan, ...band.ids.watchFor].length;
      for (let mask = 0; mask < 8; mask += 1) {
        const strip = sectionNames.filter((_, index) => (mask & (1 << index)) !== 0);
        const connectives = Object.fromEntries(
          strip.map((section) => [section, UNLICENSED_NUMBER_CONNECTIVE]),
        );
        const { app, database } = legacyBillableApp(() => selectionOf(band.ids, connectives));
        const jobId = `p39-lattice-${band.name}-${mask}`;
        const response = await postLegacy(app, jobId);
        cells += 1;
        const job = await jobRecord(database, jobId);
        const stored = storedScoutReports(database);
        const refunds = refundLedgerRefs(database);
        if (survivors >= min) {
          expect(response.statusCode, `${jobId}`).toBe(200);
          expect(stored, jobId).toHaveLength(1);
          const report = storedScoutReportSchema.parse(stored[0]!.report);
          expect(report.strippedSectionCount ?? 0, jobId).toBe(strip.length);
          expect(findEvents(database, 'report_completed'), jobId).toHaveLength(1);
          expect(job.status, jobId).toBe('succeeded');
          expect(refunds, jobId).toEqual([]);
          expect(await balanceOf(database), jobId).toBe(0);
        } else {
          expect(response.statusCode, jobId).toBe(502);
          expect(stored, jobId).toHaveLength(0);
          expect(job, jobId).toMatchObject({ status: 'failed', failureReason: 'validation' });
          expect(refunds, jobId).toEqual([jobId]);
          expect(await balanceOf(database), jobId).toBe(1);
          expect(findEvents(database, 'report_completed'), jobId).toHaveLength(0);
        }
      }
    }
    expect(cells).toBe(24);
  });
});

describe('D-21 thin-evidence FAIL FAST on the LEGACY scout path (plan 39-07) — opposite fixture: bare harness + empty stubs', () => {
  it('makes ZERO model calls, refunds exactly once, records failureReason validation on the FINAL job record, stores nothing, fires report_failed_validation once, and still writes the snapshot', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    // C3-B1: the OPPOSITE fixture — the aliased bare harness (nothing seeded)
    // plus the explicit empty opponent-history stub. The module-level viable
    // wrapper every other case depends on is untouched.
    const { app, database } = buildBareTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: emptyScoutFetchMock(),
      reports: P39_NON_ALLOWLIST_CONFIG,
      stripe: P39_STRIPE_CONFIG,
      reportsClient: stubClient(modelSpy),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postLegacy(app, 'p39-thin-legacy');

    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(0);
    const job = await jobRecord(database, 'p39-thin-legacy');
    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('validation');
    expect(await balanceOf(database)).toBe(1);
    expect(refundLedgerRefs(database)).toEqual(['p39-thin-legacy']);
    expect(storedScoutReports(database)).toHaveLength(0);
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
    expect(findEvents(database, 'report_claims_dropped')).toHaveLength(0);
    expect(findEvents(database, 'report_prose_stripped')).toHaveLength(0);
    // The fail-fast path still records its evidence, content-addressed.
    const ids = Object.keys(snapshotNodes(database));
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(SNAPSHOT_ID_SHAPE);
    expect(evidenceSnapshotRecordSchema.safeParse(snapshotNodes(database)[ids[0]!]).success).toBe(
      true,
    );
  });
});

describe('C1-H1: failureReason survives BOTH of failJob’s terminal writes (plan 39-07) — read from the FINAL record', () => {
  it('a SPENT prep_report validation failure: the final read-back carries status refunded AND failureReason validation together', async () => {
    const { app, database } = buildTestApp({
      reports: P39_NON_ALLOWLIST_CONFIG,
      stripe: P39_STRIPE_CONFIG,
      prepPaid: P39_PREP_PAID_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: selectionOf({ overview: ['c01'], gameplan: ['c02'], watchFor: ['c32'] }),
      })),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      }),
    });
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_report',
        entryKey: P39_ENTRY_KEY,
        opponentName: 'rival',
        jobId: 'p39-c1h1-spent',
      },
    });
    expect(response.statusCode).toBe(502);

    // Read AFTER the whole failJob call completed — the SECOND (refunded)
    // write is authoritative because `.set()` replaces the node.
    const job = await jobRecord(database, 'p39-c1h1-spent');
    expect(job.status).toBe('refunded');
    expect(job.failureReason).toBe('validation');
    expect(job.reason).toBe('prep_report');
    expect(await balanceOf(database)).toBe(1);
    expect(refundLedgerRefs(database)).toEqual(['p39-c1h1-spent']);
  });

  it('a ZERO-SPEND post_event_synthesis validation failure (Phase 28 CR-02 refunded-without-refund branch): the final read-back carries status refunded AND failureReason validation together', async () => {
    const { app, database } = buildBareTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: P39_PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      // Every focus area cites a pair outside the real evidence — the
      // synthesis surface's total citation drop (its validation failure).
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: {
          summary: 'A strong showing overall.',
          focusAreas: [
            {
              title: 'Neutral game',
              evidence: `Good read here ${serializeCitationToken({ sourceVodRef: 'no-such-match', seconds: 9999, label: 'note' })}`,
              drills: ['drill'],
            },
          ],
        },
      })),
    });
    database.seed(`tournamentEntries/${TEST_UID}/${P39_ENTRY_KEY}`, {
      eventName: 'EVO 2026',
      firstSetAt: 1_700_000_000_000,
      lastSetAt: 1_700_000_000_000,
      setsPlayed: 2,
      source: 'manual',
    });
    database.seed(`prepBriefs/${TEST_UID}/${P39_ENTRY_KEY}`, {
      eventDate: 1_700_000_000_000,
      activatedAt: 1_700_000_000_000,
      lastOpenedAt: 1_700_000_000_000,
      reviewAt: 1_700_000_000_000,
    });
    database.seed(`matches/${TEST_UID}/m1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 1_700_000_000_000,
      win: true,
      eventName: 'EVO 2026',
      source: 'startgg',
      vodTimestamps: [{ seconds: 42, note: 'clean punish' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { reason: 'post_event_synthesis', entryKey: P39_ENTRY_KEY },
    });
    expect(response.statusCode).toBe(502);

    const dump = database.dump() as { reportJobs: Record<string, Record<string, unknown>> };
    const jobId = Object.keys(dump.reportJobs[TEST_UID]!)[0]!;
    const job = await jobRecord(database, jobId);
    expect(job.status).toBe('refunded');
    expect(job.failureReason).toBe('validation');
    expect(job.reason).toBe('post_event_synthesis');
    // Zero spend: no credit moved (the known residual — a free-access uid
    // rests at `refunded` without a refund — is unchanged, not "fixed").
    expect((database.dump() as { creditLedger?: unknown }).creditLedger).toBeUndefined();
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
  });
});

describe('C4-H1: the D-21 fail-fast sits BELOW the queued->running claim — two concurrent executions of one bundle child refund ONCE (plan 39-07)', () => {
  it('two near-simultaneous executions of the SAME thin prep_bundle child: exactly one 409, the balance back at its pre-failure value, and exactly ONE refund ledger entry', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = buildBareTestApp({
      reports: P39_NON_ALLOWLIST_CONFIG,
      stripe: P39_STRIPE_CONFIG,
      prepPaid: P39_PREP_PAID_CONFIG,
      reportsClient: stubClient(modelSpy),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients({
        getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
        matches: 'empty',
      }),
    });
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);

    const submit = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: {
        reason: 'prep_bundle',
        entryKey: P39_ENTRY_KEY,
        bundleId: 'bundle-c4h1',
        opponentNames: BUNDLE_OPPONENT_NAMES,
      },
    });
    expect(submit.statusCode).toBe(202);
    const child = (submit.json() as { jobs: Array<{ opponentName: string; jobId: string }> })
      .jobs[0]!;
    const balanceBeforeFailure = await balanceOf(database);
    expect(balanceBeforeFailure).toBe(7);

    // Barrier: HOLD the winner between its committed claim and its terminal
    // job write (the `failed` set inside failJob), so the loser's execution
    // runs while the winner's record still reads `running`. Released when
    // the loser answers — or, if a SECOND terminal write arrives (the
    // double-refund failure this test exists to catch), immediately, so the
    // test fails on its assertions instead of hanging.
    const childPath = `reportJobs/${TEST_UID}/${child.jobId}`;
    let releaseWinner: () => void = () => {};
    const winnerHeld = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let terminalWrites = 0;
    const originalRef = database.ref.bind(database);
    vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
      const ref = originalRef(path);
      if (path !== childPath) {
        return ref;
      }
      return {
        ...ref,
        set: async (value: unknown) => {
          const status = (value as { status?: string } | null)?.status;
          if (status === 'failed') {
            terminalWrites += 1;
            if (terminalWrites === 1) {
              await winnerHeld;
            } else {
              releaseWinner();
            }
          }
          return ref.set(value);
        },
      };
    });

    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: {
          reason: 'prep_report',
          entryKey: P39_ENTRY_KEY,
          opponentName: child.opponentName,
          jobId: child.jobId,
        },
      });
    const first = post();
    const second = post();
    const settled = [first, second].map((pending) =>
      pending.then((response) => {
        if (response.statusCode === 409) {
          releaseWinner();
        }
        return response;
      }),
    );
    const responses = await Promise.all(settled);

    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([409, 502]);
    expect(modelSpy).toHaveBeenCalledTimes(0);
    // One bundle debit (10 -> 7), one refund (-> 8): the balance is back at
    // exactly its pre-failure value plus the ONE returned slot credit.
    expect(await balanceOf(database)).toBe((balanceBeforeFailure as number) + 1);
    // The ledger — NOT the `credit_refunded` event, which createEvent dedupes
    // on `${creditRef}:credit_refunded`, so a double refund would still show
    // ONE event while the balance gained two.
    expect(refundLedgerRefs(database)).toEqual([child.jobId]);
    const job = await jobRecord(database, child.jobId);
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'prep_bundle',
      failureReason: 'validation',
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-07, Task 2): the SAME seam on `prep_report` and the
// `prep_bundle` child. There is ONE `runReportGeneration` call site shared
// by the legacy, prep-single and bundle-child request shapes, so these are
// per-surface PROOFS of one edit, not a second implementation.
// ---------------------------------------------------------------------------

/** A selection with exactly two surviving claims — below MIN_VIABLE_CLAIMS on every prep surface — plus one unissued id (R1). */
const BELOW_MINIMUM_SELECTION = selectionOf({
  overview: ['c01'],
  gameplan: ['c02'],
  watchFor: ['c32'],
});

function spendLedgerRefs(database: FakeDatabase): string[] {
  const dump = database.dump() as { creditLedger?: Record<string, Record<string, unknown>> };
  return Object.values(dump.creditLedger?.[TEST_UID] ?? {})
    .filter((entry) => (entry as { type: string }).type === 'spend')
    .map((entry) => (entry as { ref: string }).ref)
    .sort();
}

/** A billable prep app. `fixture: 'viable'` is the module-level wrapper; `'thin'` is the bare harness + the empty parry history (the opposite fixture, C3-B1). */
function prepBillableApp(
  fixture: 'viable' | 'thin',
  respond: (callIndex: number) => { stop_reason: string; parsed_output: unknown },
) {
  let calls = 0;
  const modelSpy = vi.fn(async () => {
    calls += 1;
    return respond(calls);
  });
  const options = {
    reports: P39_NON_ALLOWLIST_CONFIG,
    stripe: P39_STRIPE_CONFIG,
    prepPaid: P39_PREP_PAID_CONFIG,
    reportsClient: stubClient(modelSpy),
    parrygg: { apiKey: 'parry-key' },
    parryggClients: parryClients({
      getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
      ...(fixture === 'thin' ? { matches: 'empty' as const } : {}),
    }),
  };
  const built = fixture === 'viable' ? buildTestApp(options) : buildBareTestApp(options);
  return { ...built, modelSpy };
}

async function postPrepSingle(
  app: ReturnType<typeof buildTestApp>['app'],
  jobId: string,
  opponentName = 'rival',
) {
  return app.inject({
    method: 'POST',
    url: '/api/reports',
    headers: authHeader(),
    payload: { reason: 'prep_report', entryKey: P39_ENTRY_KEY, opponentName, jobId },
  });
}

async function submitBundle(app: ReturnType<typeof buildTestApp>['app'], bundleId: string) {
  const submit = await app.inject({
    method: 'POST',
    url: '/api/reports',
    headers: authHeader(),
    payload: {
      reason: 'prep_bundle',
      entryKey: P39_ENTRY_KEY,
      bundleId,
      opponentNames: BUNDLE_OPPONENT_NAMES,
    },
  });
  expect(submit.statusCode).toBe(202);
  return (submit.json() as { jobs: Array<{ opponentName: string; jobId: string; slot: number }> })
    .jobs;
}

describe('validator seam on prep_report and the prep_bundle child (plan 39-07 Task 2)', () => {
  it('a prep_report whose generation FAILS validation: failureReason validation, one refund, no stored report, report_failed_validation in addition to report_failed', async () => {
    const { app, database, modelSpy } = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: BELOW_MINIMUM_SELECTION,
    }));
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postPrepSingle(app, 'p39-prep-invalid');
    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    const job = await jobRecord(database, 'p39-prep-invalid');
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'prep_report',
      failureReason: 'validation',
    });
    // `reason` (job KIND) and `failureReason` (CAUSE) both survive the fake
    // database round trip and the job schema, independently.
    const parsed = reportJobSchema.parse(job);
    expect(parsed.reason).toBe('prep_report');
    expect(parsed.failureReason).toBe('validation');
    expect(await balanceOf(database)).toBe(1);
    expect(refundLedgerRefs(database)).toEqual(['p39-prep-invalid']);
    expect(storedScoutReports(database)).toHaveLength(0);
    expect(findEvents(database, 'report_failed')).toHaveLength(1);
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
    expect(findEvents(database, 'report_failed_validation')[0]!.payload).toEqual({
      reason: 'prep_report',
    });
  });

  it('report_failed_validation fires ONLY for the validation cause — a refusal emits report_failed alone', async () => {
    const { app, database } = prepBillableApp('viable', () => ({
      stop_reason: 'refusal',
      parsed_output: null,
    }));
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    expect((await postPrepSingle(app, 'p39-prep-refusal')).statusCode).toBe(502);
    const job = await jobRecord(database, 'p39-prep-refusal');
    expect(job.status).toBe('refunded');
    expect(job).not.toHaveProperty('failureReason');
    expect(findEvents(database, 'report_failed')).toHaveLength(1);
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(0);
  });

  it('a prep_bundle child that FAILS validation consumes no additional credit and no additional bundle slot', async () => {
    const { app, database } = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: BELOW_MINIMUM_SELECTION,
    }));
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(app, 'bundle-p39-invalid');
    const spendsAfterSubmit = spendLedgerRefs(database);
    expect(spendsAfterSubmit).toHaveLength(3);
    const opsAfterSubmit = JSON.stringify(
      (database.dump() as Record<string, unknown>).creditBundleOps ?? null,
    );

    const child = jobs[0]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);
    expect(response.statusCode).toBe(502);

    // No re-spend, no fourth slot, no new bundle-op marker — only the ONE
    // refund of this child's pre-paid slot.
    expect(spendLedgerRefs(database)).toEqual(spendsAfterSubmit);
    expect(
      JSON.stringify((database.dump() as Record<string, unknown>).creditBundleOps ?? null),
    ).toBe(opsAfterSubmit);
    expect(await balanceOf(database)).toBe(7 + 1);
    expect(refundLedgerRefs(database)).toEqual([child.jobId]);
    const bundleJobIds = Object.keys(
      (database.dump() as { reportJobs: Record<string, Record<string, unknown>> }).reportJobs[
        TEST_UID
      ]!,
    ).filter((jobId) => jobId.startsWith('bundle-p39-invalid'));
    expect(bundleJobIds.sort()).toEqual(jobs.map((job) => job.jobId).sort());
    expect(await jobRecord(database, child.jobId)).toMatchObject({
      status: 'refunded',
      reason: 'prep_bundle',
      failureReason: 'validation',
    });
  });

  it('report_claims_dropped fires exactly once for a STORED prep report with a positive dropped count, and not at all when the count is zero', async () => {
    for (const { jobId, selection, expectedDropped } of [
      {
        jobId: 'p39-prep-dropped',
        // c01..c03 survive (at the minimum); c32 was never issued (R1).
        selection: selectionOf({ overview: ['c01'], gameplan: ['c02'], watchFor: ['c03', 'c32'] }),
        expectedDropped: 1,
      },
      { jobId: 'p39-prep-clean', selection: VALID_REPORT, expectedDropped: 0 },
    ]) {
      const { app, database } = prepBillableApp('viable', () => ({
        stop_reason: 'end_turn',
        parsed_output: selection,
      }));
      seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
        likelyOpponents: { rival: true },
        scoutBindings: { rival: P39_PARRY_BINDING },
      });
      database.seed(`credits/${TEST_UID}/balance`, 1);

      expect((await postPrepSingle(app, jobId)).statusCode).toBe(200);
      const report = storedScoutReports(database)[0]!.report as Record<string, unknown>;
      const events = findEvents(database, 'report_claims_dropped');
      if (expectedDropped > 0) {
        expect(report.droppedClaimCount).toBe(expectedDropped);
        expect(events).toHaveLength(1);
        // Occurrence signal — never a count in the payload.
        expect(events[0]!.payload).toEqual({ reason: 'prep_report' });
      } else {
        expect(report).not.toHaveProperty('droppedClaimCount');
        expect(events).toHaveLength(0);
      }
      // Delivered either way: charged, never refunded.
      expect(refundLedgerRefs(database)).toEqual([]);
    }
  });

  it('report_prose_stripped fires exactly once for a STORED prep report with a positive strippedSectionCount, and not at all when the count is zero', async () => {
    for (const { jobId, selection, expectedStripped } of [
      {
        jobId: 'p39-prep-stripped',
        selection: selectionOf(
          { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] },
          { gameplan: UNLICENSED_NUMBER_CONNECTIVE },
        ),
        expectedStripped: 1,
      },
      { jobId: 'p39-prep-unstripped', selection: VALID_REPORT, expectedStripped: 0 },
    ]) {
      const { app, database } = prepBillableApp('viable', () => ({
        stop_reason: 'end_turn',
        parsed_output: selection,
      }));
      seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
        likelyOpponents: { rival: true },
        scoutBindings: { rival: P39_PARRY_BINDING },
      });
      database.seed(`credits/${TEST_UID}/balance`, 1);

      expect((await postPrepSingle(app, jobId)).statusCode).toBe(200);
      const report = storedScoutReports(database)[0]!.report as Record<string, unknown>;
      const events = findEvents(database, 'report_prose_stripped');
      if (expectedStripped > 0) {
        expect(report.strippedSectionCount).toBe(expectedStripped);
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toEqual({ reason: 'prep_report' });
      } else {
        expect(report).not.toHaveProperty('strippedSectionCount');
        expect(events).toHaveLength(0);
      }
    }
  });
});

describe('D-21 thin-evidence FAIL FAST on prep_report and the prep_bundle child (plan 39-07 Task 2) — opposite fixture: bare harness + empty parry history', () => {
  it('a prep_report against an unseeded workspace makes ZERO model calls, refunds exactly once, and records failureReason validation on the FINAL record', async () => {
    const { app, database, modelSpy } = prepBillableApp('thin', () => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postPrepSingle(app, 'p39-thin-prep');
    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(0);
    expect(await jobRecord(database, 'p39-thin-prep')).toMatchObject({
      status: 'refunded',
      reason: 'prep_report',
      failureReason: 'validation',
    });
    expect(await balanceOf(database)).toBe(1);
    expect(refundLedgerRefs(database)).toEqual(['p39-thin-prep']);
    expect(storedScoutReports(database)).toHaveLength(0);
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
    expect(Object.keys(snapshotNodes(database))).toHaveLength(1);
  });

  it('a prep_bundle child against an unseeded workspace makes ZERO model calls, refunds its slot once, and consumes no additional credit or bundle slot', async () => {
    const { app, database, modelSpy } = prepBillableApp('thin', () => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(app, 'bundle-p39-thin');
    const spendsAfterSubmit = spendLedgerRefs(database);

    const child = jobs[1]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);
    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(0);
    expect(spendLedgerRefs(database)).toEqual(spendsAfterSubmit);
    expect(await balanceOf(database)).toBe(7 + 1);
    expect(refundLedgerRefs(database)).toEqual([child.jobId]);
    expect(await jobRecord(database, child.jobId)).toMatchObject({
      status: 'refunded',
      reason: 'prep_bundle',
      failureReason: 'validation',
    });
    expect(Object.keys(snapshotNodes(database))).toHaveLength(1);

    // A resolved child is never re-runnable on the returned credit.
    const replay = await postPrepSingle(app, child.jobId, child.opponentName);
    expect(replay.statusCode).toBe(409);
    expect(await balanceOf(database)).toBe(7 + 1);
    expect(refundLedgerRefs(database)).toEqual([child.jobId]);
  });
});

/**
 * SUPPLEMENTS — never replaces — the locked `bundle failure math
 * (RPT-02/RPT-03, owner battery item 3)` block above, whose own scenarios
 * (0/1/2/3 failing children, refusal cause) this mirrors. The cause changes;
 * the money does not: for every failing-child count the balance, the refund
 * ledger refs and the terminal statuses are IDENTICAL whether the children
 * fail by refusal (a pre-existing cause) or by validation.
 */
describe('bundle failure math is cause-independent: validation vs a pre-existing cause (plan 39-07 Task 2)', () => {
  async function runCauseCase(cause: 'refusal' | 'validation', failureCount: number) {
    const { app, database, modelSpy } = prepBillableApp('viable', (callIndex) => {
      if (callIndex > failureCount) {
        return { stop_reason: 'end_turn', parsed_output: VALID_REPORT };
      }
      return cause === 'refusal'
        ? { stop_reason: 'refusal', parsed_output: null }
        : { stop_reason: 'end_turn', parsed_output: BELOW_MINIMUM_SELECTION };
    });
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    const START_BALANCE = 10;
    database.seed(`credits/${TEST_UID}/balance`, START_BALANCE);
    const bundleId = `bundle-cause-${failureCount}`;
    const jobs = await submitBundle(app, bundleId);
    for (const job of jobs) {
      const response = await postPrepSingle(app, job.jobId, job.opponentName);
      expect(response.statusCode).toBe(job.slot <= failureCount ? 502 : 200);
    }
    expect(modelSpy).toHaveBeenCalledTimes(3);
    const statuses: string[] = [];
    const failureReasons: Array<string | null> = [];
    for (const job of jobs) {
      const record = await jobRecord(database, job.jobId);
      statuses.push(record.status as string);
      failureReasons.push((record.failureReason as string | undefined) ?? null);
    }
    return {
      balance: await balanceOf(database),
      expectedBalance: START_BALANCE - 3 + failureCount,
      refundSlots: refundLedgerRefs(database)
        .map((ref) => ref.slice(bundleId.length))
        .sort(),
      spendCount: spendLedgerRefs(database).length,
      statuses,
      failureReasons,
      reportFailed: findEvents(database, 'report_failed').length,
      reportFailedValidation: findEvents(database, 'report_failed_validation').length,
    };
  }

  for (const failureCount of [0, 1, 2, 3]) {
    it(`${failureCount} failing children: validation and refusal produce the identical balance, refund slots and terminal statuses`, async () => {
      const refusal = await runCauseCase('refusal', failureCount);
      const validation = await runCauseCase('validation', failureCount);

      expect(refusal.balance).toBe(refusal.expectedBalance);
      expect(validation.balance).toBe(validation.expectedBalance);
      expect(validation.balance).toBe(refusal.balance);
      expect(validation.refundSlots).toEqual(refusal.refundSlots);
      expect(validation.refundSlots).toHaveLength(failureCount);
      expect(validation.spendCount).toBe(refusal.spendCount);
      expect(validation.statuses).toEqual(refusal.statuses);
      expect(validation.reportFailed).toBe(refusal.reportFailed);
      // Only the cause differs.
      expect(refusal.failureReasons.every((value) => value === null)).toBe(true);
      expect(validation.failureReasons.filter((value) => value === 'validation')).toHaveLength(
        failureCount,
      );
      expect(refusal.reportFailedValidation).toBe(0);
      expect(validation.reportFailedValidation).toBe(failureCount);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-07, Task 3): the money-path REAFFIRMATION battery — the
// properties v2.5's money safety rests on, re-proven on the tree this plan
// commits. NEW block; the locked blocks it sits beside are run, never edited.
// ---------------------------------------------------------------------------

const PREP_KIND_REASONS = new Set(['prep_report', 'prep_bundle', 'post_event_synthesis']);

/** Counts terminal (`failed`/`refunded`) writes to ONE job node, optionally failing the scout-report store write. */
function instrumentJobWrites(
  database: FakeDatabase,
  jobPath: string,
  options: { failScoutReportStore?: boolean } = {},
): { failed: number; refunded: number } {
  const counts = { failed: 0, refunded: 0 };
  const originalRef = database.ref.bind(database);
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    const ref = originalRef(path);
    if (path === jobPath) {
      return {
        ...ref,
        set: async (value: unknown) => {
          const status = (value as { status?: string } | null)?.status;
          if (status === 'failed') counts.failed += 1;
          if (status === 'refunded') counts.refunded += 1;
          return ref.set(value);
        },
      };
    }
    if (options.failScoutReportStore && path === `scoutReports/${TEST_UID}`) {
      return {
        ...ref,
        push: () => {
          const child = ref.push();
          return {
            ...child,
            set: async () => {
              throw new Error('simulated scout-report store failure');
            },
          };
        },
      };
    }
    return ref;
  });
  return counts;
}

/** Every job record in the database, for the job-KIND position check. */
function allJobRecords(database: FakeDatabase): Array<Record<string, unknown>> {
  const dump = database.dump() as { reportJobs?: Record<string, Record<string, unknown>> };
  return Object.values(dump.reportJobs ?? {}).flatMap(
    (jobs) => Object.values(jobs) as Array<Record<string, unknown>>,
  );
}

describe('money-path reaffirmation battery (plan 39-07 Task 3)', () => {
  it('1. the activation gate is still the FIRST statement: a reason-bearing request with the gate absent answers 503 with NO job record, NO credit spend, NO model call and NO snapshot', async () => {
    const cases = [
      {
        reason: 'prep_report',
        payload: {
          reason: 'prep_report',
          entryKey: P39_ENTRY_KEY,
          opponentName: 'rival',
          jobId: 'p39-gate-prep',
        },
      },
      {
        reason: 'prep_bundle',
        payload: {
          reason: 'prep_bundle',
          entryKey: P39_ENTRY_KEY,
          bundleId: 'bundle-p39-gate',
          opponentNames: BUNDLE_OPPONENT_NAMES,
        },
      },
      {
        reason: 'post_event_synthesis',
        payload: { reason: 'post_event_synthesis', entryKey: P39_ENTRY_KEY },
      },
    ];
    for (const { reason, payload } of cases) {
      for (const reports of [P39_NON_ALLOWLIST_CONFIG, REPORTS_CONFIG]) {
        const modelSpy = vi.fn(async () => ({
          stop_reason: 'end_turn' as const,
          parsed_output: VALID_REPORT,
        }));
        // Gate ABSENT: no `prepPaid` option at all (production ships UNSET).
        const { app, database } = buildTestApp({
          reports,
          stripe: P39_STRIPE_CONFIG,
          reportsClient: stubClient(modelSpy),
          parrygg: { apiKey: 'parry-key' },
          parryggClients: parryClients({
            getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
          }),
        });
        seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
        database.seed(`credits/${TEST_UID}/balance`, 5);

        const response = await app.inject({
          method: 'POST',
          url: '/api/reports',
          headers: authHeader(),
          payload,
        });

        const dump = database.dump() as Record<string, unknown>;
        expect(response.statusCode, reason).toBe(503);
        expect(dump.reportJobs, reason).toBeUndefined();
        expect(dump.creditLedger, reason).toBeUndefined();
        expect(dump.creditBundleOps, reason).toBeUndefined();
        expect(await balanceOf(database), reason).toBe(5);
        expect(modelSpy, reason).toHaveBeenCalledTimes(0);
        expect(dump.evidenceSnapshots, reason).toBeUndefined();
      }
    }
  });

  it('2. every reachable failure cause on the job path writes exactly ONE terminal record and exactly ONE refund effect per attempt', async () => {
    type Cause = {
      name: string;
      expectedStatus: number;
      fixture?: 'thin';
      failStore?: boolean;
      startggFetch?: typeof fetch;
      respond: () => Promise<{ stop_reason: string; parsed_output: unknown }>;
    };
    const rateLimit = new Anthropic.RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers(),
    );
    const apiError = new Anthropic.InternalServerError(
      500,
      { type: 'error', error: { type: 'api_error', message: 'boom' } },
      'boom',
      new Headers(),
    );
    const causes: Cause[] = [
      {
        name: 'refusal',
        expectedStatus: 502,
        respond: async () => ({ stop_reason: 'refusal', parsed_output: null }),
      },
      {
        name: 'truncated',
        expectedStatus: 502,
        respond: async () => ({ stop_reason: 'max_tokens', parsed_output: null }),
      },
      {
        name: 'unparseable',
        expectedStatus: 502,
        respond: async () => ({ stop_reason: 'end_turn', parsed_output: null }),
      },
      {
        name: 'rate-limited',
        expectedStatus: 429,
        respond: async () => {
          throw rateLimit;
        },
      },
      {
        name: 'provider-error',
        expectedStatus: 502,
        respond: async () => {
          throw apiError;
        },
      },
      {
        name: 'unexpected-throw (catch-all, rethrown)',
        expectedStatus: 500,
        respond: async () => {
          throw new Error('simulated unexpected client failure');
        },
      },
      {
        name: 'validation',
        expectedStatus: 502,
        respond: async () => ({ stop_reason: 'end_turn', parsed_output: BELOW_MINIMUM_SELECTION }),
      },
      {
        name: 'stored-schema reject',
        expectedStatus: 502,
        respond: async () => ({
          stop_reason: 'end_turn',
          parsed_output: selectionOf(
            { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] },
            {},
            { action1: { actionId: '', claimId: 'c01' } },
          ),
        }),
      },
      {
        name: 'D-21 thin evidence',
        expectedStatus: 502,
        fixture: 'thin',
        respond: async () => ({ stop_reason: 'end_turn', parsed_output: VALID_REPORT }),
      },
      {
        name: 'store failure (catch, rethrown)',
        expectedStatus: 500,
        failStore: true,
        respond: async () => ({ stop_reason: 'end_turn', parsed_output: VALID_REPORT }),
      },
      {
        name: 'scout not found',
        expectedStatus: 404,
        startggFetch: (async () => gqlResponse({ user: null })) as unknown as typeof fetch,
        respond: async () => ({ stop_reason: 'end_turn', parsed_output: VALID_REPORT }),
      },
    ];

    for (const cause of causes) {
      const options = {
        startgg: STARTGG_CONFIG,
        startggFetch:
          cause.startggFetch ??
          (cause.fixture === 'thin' ? emptyScoutFetchMock() : scoutFetchMock()),
        reports: P39_NON_ALLOWLIST_CONFIG,
        stripe: P39_STRIPE_CONFIG,
        reportsClient: stubClient(cause.respond),
      };
      const { app, database } =
        cause.fixture === 'thin' ? buildBareTestApp(options) : buildTestApp(options);
      database.seed(`credits/${TEST_UID}/balance`, 1);
      const jobId = `p39-battery-${cause.name.replace(/[^a-z0-9]+/gi, '-')}`;
      const counts = instrumentJobWrites(database, `reportJobs/${TEST_UID}/${jobId}`, {
        failScoutReportStore: cause.failStore,
      });

      const response = await postLegacy(app, jobId);
      vi.mocked(database.ref).mockRestore();

      expect(response.statusCode, cause.name).toBe(cause.expectedStatus);
      // Exactly ONE terminal write (a legacy job's terminal is always
      // `failed`, never `refunded`) and exactly ONE refund effect.
      expect(counts.failed, cause.name).toBe(1);
      expect(counts.refunded, cause.name).toBe(0);
      expect(refundLedgerRefs(database), cause.name).toEqual([jobId]);
      expect(await balanceOf(database), cause.name).toBe(1);
      expect(findEvents(database, 'report_failed'), cause.name).toHaveLength(1);
      expect((await jobRecord(database, jobId)).status, cause.name).toBe('failed');
    }
  });

  it('3. a validation failure and a truncation failure produce IDENTICAL refund effects for the same job shape (legacy and prep_report)', async () => {
    async function legacyRun(respond: () => { stop_reason: string; parsed_output: unknown }) {
      const built = buildTestApp({
        startgg: STARTGG_CONFIG,
        startggFetch: scoutFetchMock(),
        reports: P39_NON_ALLOWLIST_CONFIG,
        stripe: P39_STRIPE_CONFIG,
        reportsClient: stubClient(async () => respond()),
      });
      built.database.seed(`credits/${TEST_UID}/balance`, 1);
      const response = await postLegacy(built.app, 'p39-same-shape');
      const job = await jobRecord(built.database, 'p39-same-shape');
      return {
        statusCode: response.statusCode,
        balance: await balanceOf(built.database),
        refunds: refundLedgerRefs(built.database),
        status: job.status,
        failureReason: job.failureReason ?? null,
      };
    }
    async function prepRun(respond: () => { stop_reason: string; parsed_output: unknown }) {
      const { app, database } = prepBillableApp('viable', respond);
      seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
        likelyOpponents: { rival: true },
        scoutBindings: { rival: P39_PARRY_BINDING },
      });
      database.seed(`credits/${TEST_UID}/balance`, 1);
      const response = await postPrepSingle(app, 'p39-same-shape');
      const job = await jobRecord(database, 'p39-same-shape');
      return {
        statusCode: response.statusCode,
        balance: await balanceOf(database),
        refunds: refundLedgerRefs(database),
        status: job.status,
        failureReason: job.failureReason ?? null,
      };
    }
    const truncation = () => ({ stop_reason: 'max_tokens', parsed_output: null });
    const validation = () => ({ stop_reason: 'end_turn', parsed_output: BELOW_MINIMUM_SELECTION });

    for (const run of [legacyRun, prepRun]) {
      const truncated = await run(truncation);
      const invalid = await run(validation);
      expect(invalid.statusCode).toBe(truncated.statusCode);
      expect(invalid.balance).toBe(truncated.balance);
      expect(invalid.balance).toBe(1);
      expect(invalid.refunds).toEqual(truncated.refunds);
      expect(invalid.refunds).toEqual(['p39-same-shape']);
      expect(invalid.status).toBe(truncated.status);
      // The cause differs; the money does not.
      expect(truncated.failureReason).toBeNull();
      expect(invalid.failureReason).toBe('validation');
    }
  });

  it('4. failureReason never lands in the job-KIND position: every failed, refunded or swept job’s reason is a prep kind or absent — never a failure cause', async () => {
    // The job-kind enum itself refuses a failure cause.
    expect(
      reportJobSchema.safeParse({
        status: 'failed',
        createdAt: 1,
        updatedAt: 1,
        attempt: 0,
        creditRef: 'x',
        reason: 'validation',
      }).success,
    ).toBe(false);

    const records: Array<Record<string, unknown>> = [];

    // A legacy validation failure, a D-21 thin prep failure, and a bundle
    // child validation failure.
    const legacy = legacyBillableApp(() => BELOW_MINIMUM_SELECTION);
    await postLegacy(legacy.app, 'p39-kind-legacy');
    records.push(...allJobRecords(legacy.database));

    const thin = prepBillableApp('thin', () => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedPrepBrief(thin.database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    thin.database.seed(`credits/${TEST_UID}/balance`, 1);
    await postPrepSingle(thin.app, 'p39-kind-thin');
    records.push(...allJobRecords(thin.database));

    const bundle = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: BELOW_MINIMUM_SELECTION,
    }));
    seedBundleBrief(bundle.database, TEST_UID, P39_ENTRY_KEY);
    bundle.database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(bundle.app, 'bundle-p39-kind');
    await postPrepSingle(bundle.app, jobs[0]!.jobId, jobs[0]!.opponentName);
    records.push(...allJobRecords(bundle.database));

    // A swept stale prep job that carried a failure cause.
    const sweepDb = new FakeDatabaseImpl();
    sweepDb.seed(`reportJobs/${TEST_UID}/p39-kind-swept`, {
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      attempt: 0,
      creditRef: 'p39-kind-swept',
      reason: 'prep_report',
      failureReason: 'validation',
    });
    sweepDb.seed(`reportJobsByStatus/running/${TEST_UID}/p39-kind-swept`, true);
    await runSweepStuckReportJobs(sweepDb as unknown as Database, { now: 10 * 60 * 60 * 1000 });
    records.push(...allJobRecords(sweepDb));

    const failedOrSwept = records.filter(
      (record) => record.status === 'failed' || record.status === 'refunded',
    );
    expect(failedOrSwept.length).toBeGreaterThanOrEqual(4);
    for (const record of records) {
      if (record.reason !== undefined) {
        expect(PREP_KIND_REASONS.has(record.reason as string)).toBe(true);
      }
      expect(record.reason).not.toBe('validation');
    }
    expect(failedOrSwept.filter((record) => record.failureReason === 'validation')).toHaveLength(
      failedOrSwept.length,
    );
  });
});

// ---------------------------------------------------------------------------
// Post-plan fix (39-08, WINDOWS.md fixme #7): the 200 body on the three
// scout-shaped surfaces is the PARSED (schema-applied) record, never the raw
// in-memory one. `persistSection` omits an empty `claimIds` on write (RTDB
// would drop it) and `storedReportSectionSchema.claimIds` defaults to `[]`
// only in the PARSE direction; the response serializer ENCODES, so a raw
// body with an omitted `claimIds` failed serialization with a 500 AFTER the
// job succeeded, the report was stored and the credit was spent.
// ---------------------------------------------------------------------------

/** A viable selection (MIN_VIABLE_CLAIMS surviving claims) that leaves `watchFor` with NO claim ids. */
function emptySectionSelection() {
  const ids = [...SELECTED_CLAIM_IDS];
  return selectionOf({ overview: ids.slice(0, 1), gameplan: ids.slice(1), watchFor: [] });
}

/** The one stored scout report as `{ id, ...record }` (id = its push key). */
function storedScoutReportWithId(database: FakeDatabase): Record<string, unknown> {
  const dump = database.dump() as { scoutReports?: Record<string, Record<string, unknown>> };
  const entries = Object.entries(dump.scoutReports?.[TEST_UID] ?? {});
  expect(entries).toHaveLength(1);
  const [id, record] = entries[0]!;
  return { id, ...(record as Record<string, unknown>) };
}

/** The shared post-success money/state assertions for a scout-shaped 200. */
async function expectDeliveredOnce(
  database: FakeDatabase,
  response: Awaited<ReturnType<typeof postLegacy>>,
  jobId: string,
) {
  // Money/state first: before the fix these all held while the status was
  // 500 — the report was delivered and charged, the user saw an error.
  const stored = storedScoutReportWithId(database);
  const job = await jobRecord(database, jobId);
  expect(job.status).toBe('succeeded');
  expect(job.resultRef).toBe(stored.id);
  expect(job).not.toHaveProperty('failureReason');
  expect(refundLedgerRefs(database)).toEqual([]);
  expect(findEvents(database, 'report_completed')).toHaveLength(1);
  expect(findEvents(database, 'report_failed')).toHaveLength(0);
  expect(response.statusCode).toBe(200);
  // The guard: the 200 body IS the parsed stored record — schema defaults
  // applied — so a raw-record response cannot regress unseen.
  expect(response.json()).toEqual(scoutReportRecordSchema.parse(stored));
}

describe('post-plan fix (39-08): a 200 is the PARSED record — an empty-section selection is delivered, not a 500 after spend', () => {
  it('legacy scout: an empty watchFor section answers 200 with claimIds [] — one spend, zero refunds, job succeeded, stored once', async () => {
    const { app, database, modelSpy } = legacyBillableApp(() => emptySectionSelection());

    const response = await postLegacy(app, 'p39fix-legacy-empty');
    expect(modelSpy).toHaveBeenCalledTimes(1);
    expect(spendLedgerRefs(database)).toEqual(['p39fix-legacy-empty']);
    expect(await balanceOf(database)).toBe(0);
    await expectDeliveredOnce(database, response, 'p39fix-legacy-empty');
    const body = response.json() as {
      report: { sections: Record<string, { claimIds: string[] }> };
    };
    expect(body.report.sections.watchFor!.claimIds).toEqual([]);
  });

  it('prep_report: an empty watchFor section answers 200 with claimIds [] — one spend, zero refunds, job succeeded, stored once', async () => {
    const { app, database, modelSpy } = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: emptySectionSelection(),
    }));
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postPrepSingle(app, 'p39fix-prep-empty');
    expect(modelSpy).toHaveBeenCalledTimes(1);
    expect(spendLedgerRefs(database)).toEqual(['p39fix-prep-empty']);
    expect(await balanceOf(database)).toBe(0);
    expect((await jobRecord(database, 'p39fix-prep-empty')).reason).toBe('prep_report');
    await expectDeliveredOnce(database, response, 'p39fix-prep-empty');
    const body = response.json() as {
      report: { sections: Record<string, { claimIds: string[] }> };
    };
    expect(body.report.sections.watchFor!.claimIds).toEqual([]);
  });

  it('prep_bundle child: an empty watchFor section answers 200 with claimIds [] — no re-spend beyond the bundle debit, zero refunds, job succeeded, stored once', async () => {
    const { app, database, modelSpy } = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: emptySectionSelection(),
    }));
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(app, 'bundle-p39fix-empty');
    const spendsAfterSubmit = spendLedgerRefs(database);
    expect(spendsAfterSubmit).toHaveLength(3);
    const balanceAfterSubmit = await balanceOf(database);
    expect(balanceAfterSubmit).toBe(7);

    const child = jobs[0]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    // The ONE bundle debit is the only spend; the child neither re-spends nor refunds.
    expect(spendLedgerRefs(database)).toEqual(spendsAfterSubmit);
    expect(await balanceOf(database)).toBe(balanceAfterSubmit);
    expect((await jobRecord(database, child.jobId)).reason).toBe('prep_bundle');
    await expectDeliveredOnce(database, response, child.jobId);
    const body = response.json() as {
      report: { sections: Record<string, { claimIds: string[] }> };
    };
    expect(body.report.sections.watchFor!.claimIds).toEqual([]);
  });

  it('guard: a fully-cited selection on every scout-shaped surface also answers with exactly schema.parse(stored)', async () => {
    const legacy = legacyBillableApp(() => VALID_REPORT);
    await expectDeliveredOnce(
      legacy.database,
      await postLegacy(legacy.app, 'p39fix-legacy-full'),
      'p39fix-legacy-full',
    );

    const prep = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedPrepBrief(prep.database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    prep.database.seed(`credits/${TEST_UID}/balance`, 1);
    await expectDeliveredOnce(
      prep.database,
      await postPrepSingle(prep.app, 'p39fix-prep-full'),
      'p39fix-prep-full',
    );

    const bundle = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedBundleBrief(bundle.database, TEST_UID, P39_ENTRY_KEY);
    bundle.database.seed(`credits/${TEST_UID}/balance`, 10);
    const child = (await submitBundle(bundle.app, 'bundle-p39fix-full'))[0]!;
    await expectDeliveredOnce(
      bundle.database,
      await postPrepSingle(bundle.app, child.jobId, child.opponentName),
      child.jobId,
    );
  });
});

// ---------------------------------------------------------------------------
// Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25): the job record
// carries `wasCharged` — the SAME `spent` fact the money path acts on —
// written at spend time and carried on every later whole-node `.set()`, so
// the web's refund wording can never claim a refund on a job that was never
// charged, even after the viewer's free-access status changes. Additive and
// RTDB-safe (a boolean, never null). Money is unchanged: every case below
// also pins balance + `spend`/`refund` ledger refs.
// ---------------------------------------------------------------------------

interface RecordedJobWrite {
  op: 'set' | 'update' | 'transaction';
  path: string;
  value?: unknown;
}

/** Records every write with its path AND value, so a test can find WHEN `wasCharged` first lands on the job node. */
function recordWritesWithValues(database: FakeDatabase): RecordedJobWrite[] {
  const writes: RecordedJobWrite[] = [];
  const originalRef = database.ref.bind(database);
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    const ref = originalRef(path);
    return {
      ...ref,
      set: async (value: unknown) => {
        writes.push({ op: 'set', path: path ?? '', value });
        return ref.set(value);
      },
      update: async (values: Record<string, unknown>) => {
        writes.push({ op: 'update', path: path ?? '', value: values });
        return ref.update(values);
      },
      transaction: async (fn: (current: unknown) => unknown) => {
        writes.push({ op: 'transaction', path: path ?? '' });
        return ref.transaction(fn);
      },
    };
  });
  return writes;
}

/** The index of the first write that puts `wasCharged === expected` on `reportJobs/{uid}/{jobId}` (a set/update of the node itself). */
function firstWasChargedWrite(
  writes: RecordedJobWrite[],
  jobId: string,
  expected: boolean,
): number {
  const jobPath = `reportJobs/${TEST_UID}/${jobId}`;
  return writes.findIndex(
    (write) =>
      write.path === jobPath &&
      (write.op === 'set' || write.op === 'update') &&
      (write.value as { wasCharged?: unknown } | null)?.wasCharged === expected,
  );
}

function firstRunningWrite(writes: RecordedJobWrite[], jobId: string): number {
  const jobPath = `reportJobs/${TEST_UID}/${jobId}`;
  return writes.findIndex(
    (write) =>
      write.path === jobPath &&
      (write.op === 'transaction' ||
        (write.op === 'set' && (write.value as { status?: string }).status === 'running')),
  );
}

function spendTransactionIndex(writes: RecordedJobWrite[]): number {
  return writes.findIndex(
    (write) => write.op === 'transaction' && write.path === `credits/${TEST_UID}/balance`,
  );
}

/** A free-access (allowlisted) prep app over the viable workspace. */
function prepFreeAccessApp(respond: () => { stop_reason: string; parsed_output: unknown }) {
  const modelSpy = vi.fn(async () => respond());
  const built = buildTestApp({
    reports: REPORTS_CONFIG,
    prepPaid: P39_PREP_PAID_CONFIG,
    reportsClient: stubClient(modelSpy),
    parrygg: { apiKey: 'parry-key' },
    parryggClients: parryClients({
      getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
    }),
  });
  return { ...built, modelSpy };
}

describe('post-plan fix (39-10): wasCharged is persisted on the job at spend time and survives every terminal write', () => {
  it('legacy scout, billable: wasCharged true lands on the job AFTER the spend and BEFORE running; the succeeded record keeps it; money unchanged (one spend, zero refunds)', async () => {
    const { app, database } = legacyBillableApp(() => VALID_REPORT);
    const writes = recordWritesWithValues(database);

    const response = await postLegacy(app, 'wc-legacy-paid');

    expect(response.statusCode).toBe(200);
    const spendAt = spendTransactionIndex(writes);
    const chargedAt = firstWasChargedWrite(writes, 'wc-legacy-paid', true);
    const runningAt = firstRunningWrite(writes, 'wc-legacy-paid');
    expect(spendAt).toBeGreaterThan(-1);
    expect(chargedAt).toBeGreaterThan(spendAt);
    expect(chargedAt).toBeLessThan(runningAt);
    expect(await jobRecord(database, 'wc-legacy-paid')).toMatchObject({
      status: 'succeeded',
      wasCharged: true,
    });
    expect(spendLedgerRefs(database)).toEqual(['wc-legacy-paid']);
    expect(refundLedgerRefs(database)).toEqual([]);
    expect(await balanceOf(database)).toBe(0);
  });

  it('legacy scout, free-access: wasCharged false is written before running and kept on the succeeded record; no ledger movement', async () => {
    const built = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: VALID_REPORT,
      })),
    });
    const writes = recordWritesWithValues(built.database);

    const response = await postLegacy(built.app, 'wc-legacy-free');

    expect(response.statusCode).toBe(200);
    const chargedAt = firstWasChargedWrite(writes, 'wc-legacy-free', false);
    expect(chargedAt).toBeGreaterThan(-1);
    expect(chargedAt).toBeLessThan(firstRunningWrite(writes, 'wc-legacy-free'));
    expect(await jobRecord(built.database, 'wc-legacy-free')).toMatchObject({
      status: 'succeeded',
      wasCharged: false,
    });
    expect((built.database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
  });

  it('legacy scout, billable model refusal: the failed terminal carries wasCharged true; exactly one refund, balance restored', async () => {
    const refusing = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: P39_NON_ALLOWLIST_CONFIG,
      stripe: P39_STRIPE_CONFIG,
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
    });
    refusing.database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postLegacy(refusing.app, 'wc-legacy-refusal');

    expect(response.statusCode).toBe(502);
    expect(await jobRecord(refusing.database, 'wc-legacy-refusal')).toMatchObject({
      status: 'failed',
      wasCharged: true,
    });
    expect(spendLedgerRefs(refusing.database)).toEqual(['wc-legacy-refusal']);
    expect(refundLedgerRefs(refusing.database)).toEqual(['wc-legacy-refusal']);
    expect(await balanceOf(refusing.database)).toBe(1);
  });

  it('prep_report, billable validation failure: the AUTHORITATIVE refunded write carries wasCharged true beside failureReason (C1-H1 shape); one spend, one refund', async () => {
    const { app, database } = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: BELOW_MINIMUM_SELECTION,
    }));
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const writes = recordWritesWithValues(database);

    const response = await postPrepSingle(app, 'wc-prep-paid');

    expect(response.statusCode).toBe(502);
    const chargedAt = firstWasChargedWrite(writes, 'wc-prep-paid', true);
    expect(chargedAt).toBeGreaterThan(spendTransactionIndex(writes));
    expect(chargedAt).toBeLessThan(firstRunningWrite(writes, 'wc-prep-paid'));
    const job = await jobRecord(database, 'wc-prep-paid');
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'prep_report',
      failureReason: 'validation',
      wasCharged: true,
    });
    expect(spendLedgerRefs(database)).toEqual(['wc-prep-paid']);
    expect(refundLedgerRefs(database)).toEqual(['wc-prep-paid']);
    expect(await balanceOf(database)).toBe(1);
  });

  it('prep_report, free-access failure: rests at failed with wasCharged false; no spend, no refund, no ledger', async () => {
    const { app, database } = prepFreeAccessApp(() => ({
      stop_reason: 'refusal',
      parsed_output: null,
    }));
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });

    const response = await postPrepSingle(app, 'wc-prep-free');

    expect(response.statusCode).toBe(502);
    expect(await jobRecord(database, 'wc-prep-free')).toMatchObject({
      status: 'failed',
      reason: 'prep_report',
      wasCharged: false,
    });
    expect((database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
  });

  it('prep_bundle, billable: the three queued children carry wasCharged true from the bundle debit; an executed child keeps it on its succeeded record; the one 3-credit debit is the only spend', async () => {
    const { app, database } = prepBillableApp('viable', () => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);

    const jobs = await submitBundle(app, 'bundle-wc-paid');

    for (const child of jobs) {
      expect(await jobRecord(database, child.jobId)).toMatchObject({
        status: 'queued',
        reason: 'prep_bundle',
        wasCharged: true,
      });
    }
    expect(await balanceOf(database)).toBe(7);
    const spends = spendLedgerRefs(database);
    expect(spends).toHaveLength(3);

    const child = jobs[0]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);
    expect(response.statusCode).toBe(200);
    expect(await jobRecord(database, child.jobId)).toMatchObject({
      status: 'succeeded',
      reason: 'prep_bundle',
      wasCharged: true,
    });
    expect(spendLedgerRefs(database)).toEqual(spends);
    expect(refundLedgerRefs(database)).toEqual([]);
    expect(await balanceOf(database)).toBe(7);
  });

  it('prep_bundle, free-access: the three queued children carry wasCharged false; no ledger movement', async () => {
    const { app, database } = prepFreeAccessApp(() => ({
      stop_reason: 'end_turn',
      parsed_output: VALID_REPORT,
    }));
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);

    const jobs = await submitBundle(app, 'bundle-wc-free');

    expect(jobs).toHaveLength(3);
    for (const child of jobs) {
      expect(await jobRecord(database, child.jobId)).toMatchObject({
        status: 'queued',
        reason: 'prep_bundle',
        wasCharged: false,
      });
    }
    expect((database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
  });

  it('the stale-job sweep carries wasCharged forward on its failed terminal (and refunds only the charged and legacy jobs)', async () => {
    const database = new FakeDatabaseImpl();
    const now = Date.now();
    for (const [jobId, wasCharged] of [
      ['wc-swept-paid', true],
      ['wc-swept-free', false],
    ] as const) {
      database.seed(`reportJobs/${TEST_UID}/${jobId}`, {
        status: 'running',
        reason: 'prep_report',
        createdAt: now - 40 * 60 * 1000,
        updatedAt: now - 40 * 60 * 1000,
        attempt: 0,
        creditRef: jobId,
        wasCharged,
      });
      database.seed(`reportJobsByStatus/running/${TEST_UID}/${jobId}`, true);
    }
    database.seed(`reportJobs/${TEST_UID}/wc-swept-legacy`, {
      status: 'running',
      createdAt: now - 40 * 60 * 1000,
      updatedAt: now - 40 * 60 * 1000,
      attempt: 0,
      creditRef: 'wc-swept-legacy',
    });
    database.seed(`reportJobsByStatus/running/${TEST_UID}/wc-swept-legacy`, true);

    const result = await runSweepStuckReportJobs(database as never, { now });

    expect(result).toEqual({ swept: 3, refunded: 2 });
    expect(await jobRecord(database, 'wc-swept-paid')).toMatchObject({
      status: 'failed',
      wasCharged: true,
    });
    expect(await jobRecord(database, 'wc-swept-free')).toMatchObject({
      status: 'failed',
      wasCharged: false,
    });
    expect(await jobRecord(database, 'wc-swept-legacy')).not.toHaveProperty('wasCharged');
  });
});

// ---------------------------------------------------------------------------
// Code review (owner decision D-23, 2026-09-26; review SH-CR-03): only
// EVIDENCED (non-abstained) claims count toward MIN_VIABLE_CLAIMS on the
// pre-call fail-fast. An all-abstention workspace issues plenty of claims —
// every one "not enough data yet" — and must refund BEFORE the model call on
// every surface that shares `runReportGeneration` (scout, prep_report and
// the prep_bundle child; synthesis is proven in reportsSynthesis.test.ts).
// Money is proven by the balance and the `refund` ledger entries.
// ---------------------------------------------------------------------------

/** The viable start.gg sets payload cut to ONE game on each of the first two characters — the scouted opponent's usage rows (2 known games) and the advisor rows all fall below the floor. */
const ALL_ABSTENTION_SETS_RESPONSE = (() => {
  const nodes = (
    VIABLE_OPPONENT_SETS_RESPONSE as {
      player: {
        sets: {
          nodes: Array<{ games: Array<{ selections: Array<{ character: { id: number } }> }> }>;
        };
      };
    }
  ).player.sets.nodes;
  const firstPerCharacter = new Map<number, (typeof nodes)[number]>();
  for (const node of nodes) {
    const characterId = node.games[0]!.selections[0]!.character.id;
    if (!firstPerCharacter.has(characterId)) {
      firstPerCharacter.set(characterId, node);
    }
  }
  return {
    player: {
      sets: { pageInfo: { totalPages: 1 }, nodes: [...firstPerCharacter.values()].slice(0, 2) },
    },
  };
})();

function allAbstentionScoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return gqlResponse(RESOLVE_RESPONSE);
    }
    return gqlResponse(ALL_ABSTENTION_SETS_RESPONSE);
  }) as typeof fetch;
}

const STARTGG_BINDING = {
  provider: 'startgg',
  startggUserSlug: 'user/07dc2239',
  displayTag: 'Pandem1c',
  method: 'matchHistory',
  confirmedAt: 1,
};

/** A billable BARE app (no own history) whose opponent public history is the all-abstention cut; the model spy must never be called. */
function allAbstentionBillableApp() {
  const modelSpy = vi.fn(async () => ({
    stop_reason: 'end_turn' as const,
    parsed_output: VALID_REPORT,
  }));
  const built = buildBareTestApp({
    startgg: STARTGG_CONFIG,
    startggFetch: allAbstentionScoutFetchMock(),
    reports: P39_NON_ALLOWLIST_CONFIG,
    stripe: P39_STRIPE_CONFIG,
    prepPaid: P39_PREP_PAID_CONFIG,
    reportsClient: stubClient(modelSpy),
  });
  return { ...built, modelSpy };
}

/** The persisted snapshot's rows, rebuilt into the claim set the route issued — proves the precondition (plenty of claims, none evidenced) from what the route actually wrote. */
function issuedFromStoredSnapshot(database: FakeDatabase) {
  const nodes = Object.values(snapshotNodes(database)) as Array<{
    rows: Parameters<typeof buildClaimSet>[0]['rows'];
  }>;
  expect(nodes).toHaveLength(1);
  return buildClaimSet({ rows: nodes[0]!.rows, surface: 'scout' }).claims;
}

describe('D-23: only EVIDENCED claims clear MIN_VIABLE_CLAIMS on the pre-call fail-fast (code review SH-CR-03)', () => {
  it('legacy scout: an all-abstention workspace issuing >= MIN claims refunds exactly once, BEFORE any model call', async () => {
    const { app, database, modelSpy } = allAbstentionBillableApp();
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postLegacy(app, 'd23-legacy');

    expect(response.statusCode).toBe(502);
    const issued = issuedFromStoredSnapshot(database);
    expect(issued.length).toBeGreaterThanOrEqual(MIN_VIABLE_CLAIMS.scout);
    expect(issued.filter((claim) => claim.value.kind !== 'abstained')).toEqual([]);
    expect(modelSpy).not.toHaveBeenCalled();
    expect(await jobRecord(database, 'd23-legacy')).toMatchObject({
      status: 'failed',
      failureReason: 'validation',
      wasCharged: true,
    });
    expect(spendLedgerRefs(database)).toEqual(['d23-legacy']);
    expect(refundLedgerRefs(database)).toEqual(['d23-legacy']);
    expect(await balanceOf(database)).toBe(1);
    expect(storedScoutReports(database)).toEqual([]);
  });

  it('prep_report: the same all-abstention workspace refunds exactly once before any model call and rests at refunded', async () => {
    const { app, database, modelSpy } = allAbstentionBillableApp();
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: STARTGG_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postPrepSingle(app, 'd23-prep');

    expect(response.statusCode).toBe(502);
    expect(modelSpy).not.toHaveBeenCalled();
    expect(await jobRecord(database, 'd23-prep')).toMatchObject({
      status: 'refunded',
      reason: 'prep_report',
      failureReason: 'validation',
      wasCharged: true,
    });
    expect(spendLedgerRefs(database)).toEqual(['d23-prep']);
    expect(refundLedgerRefs(database)).toEqual(['d23-prep']);
    expect(await balanceOf(database)).toBe(1);
  });

  it('prep_bundle child: an all-abstention child refunds its one slot exactly once before any model call', async () => {
    const { app, database, modelSpy } = allAbstentionBillableApp();
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY, BUNDLE_OPPONENT_NAMES, STARTGG_BINDING);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(app, 'bundle-d23');
    expect(await balanceOf(database)).toBe(7);

    const child = jobs[0]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).not.toHaveBeenCalled();
    expect(await jobRecord(database, child.jobId)).toMatchObject({
      status: 'refunded',
      reason: 'prep_bundle',
      failureReason: 'validation',
      wasCharged: true,
    });
    expect(refundLedgerRefs(database)).toEqual([child.jobId]);
    expect(await balanceOf(database)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Code review API-CR-01: a pre-paid bundle child TRUSTS the spend fact its
// bundle recorded at purchase (`wasCharged` on the stored child job) and
// carries it through the queued rewrite, the running claim and every
// terminal write — it never re-derives `spent` from the uid's free-access
// status at execution time, which can change between purchase and run (the
// REPORTS_ALLOWED_UIDS list and the demo allowlist are both live inputs).
// Recomputing is only the fallback for a pre-39-10 child that carries no
// fact. Money: balance + `refund` ledger entries, never `credit_refunded`.
// ---------------------------------------------------------------------------

/** A prep app whose free-access list the test can change between purchase and execution; the model refuses, so every executed child FAILS. */
function mutableAccessPrepApp(initialAllowed: string[]) {
  const reportsConfig: ReportsConfig = {
    anthropicApiKey: 'sk-test-key',
    allowedUids: new Set(initialAllowed),
  };
  const modelSpy = vi.fn(async () => ({ stop_reason: 'refusal' as const, parsed_output: null }));
  const built = buildTestApp({
    reports: reportsConfig,
    stripe: P39_STRIPE_CONFIG,
    prepPaid: P39_PREP_PAID_CONFIG,
    reportsClient: stubClient(modelSpy),
    parrygg: { apiKey: 'parry-key' },
    parryggClients: parryClients({
      getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }),
    }),
  });
  return { ...built, modelSpy, allowedUids: reportsConfig.allowedUids as Set<string> };
}

describe('code review API-CR-01: a bundle child trusts the spend fact recorded at purchase', () => {
  it('bought while FREE, then free access is LOST before the child runs: the failed child is never refunded (no credit minted) and keeps wasCharged false on every write', async () => {
    const { app, database, modelSpy, allowedUids } = mutableAccessPrepApp([TEST_UID]);
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const jobs = await submitBundle(app, 'bundle-cr01-free');
    expect(await jobRecord(database, jobs[0]!.jobId)).toMatchObject({ wasCharged: false });
    expect(await balanceOf(database)).toBe(5);

    allowedUids.delete(TEST_UID);
    const writes = recordWritesWithValues(database);
    const child = jobs[0]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    expect(firstWasChargedWrite(writes, child.jobId, true)).toBe(-1);
    expect(await jobRecord(database, child.jobId)).toMatchObject({
      status: 'failed',
      reason: 'prep_bundle',
      wasCharged: false,
    });
    expect(spendLedgerRefs(database)).toEqual([]);
    expect(refundLedgerRefs(database)).toEqual([]);
    expect(await balanceOf(database)).toBe(5);
  });

  it('PAID, then free access is GAINED before the child runs: the failed child is refunded exactly once and keeps wasCharged true', async () => {
    const { app, database, modelSpy, allowedUids } = mutableAccessPrepApp(['someone-else']);
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(app, 'bundle-cr01-paid');
    expect(await balanceOf(database)).toBe(7);

    allowedUids.add(TEST_UID);
    const writes = recordWritesWithValues(database);
    const child = jobs[0]!;
    const response = await postPrepSingle(app, child.jobId, child.opponentName);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    expect(firstWasChargedWrite(writes, child.jobId, false)).toBe(-1);
    expect(await jobRecord(database, child.jobId)).toMatchObject({
      status: 'refunded',
      reason: 'prep_bundle',
      wasCharged: true,
    });
    expect(refundLedgerRefs(database)).toEqual([child.jobId]);
    expect(await balanceOf(database)).toBe(8);
  });

  it('the queued rewrite of a pre-paid child carries the recorded fact, so the node never sits without it', async () => {
    const { app, database, allowedUids } = mutableAccessPrepApp(['someone-else']);
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 10);
    const jobs = await submitBundle(app, 'bundle-cr01-queued');
    allowedUids.add(TEST_UID);
    const writes = recordWritesWithValues(database);
    const child = jobs[0]!;

    await postPrepSingle(app, child.jobId, child.opponentName);

    const jobPath = `reportJobs/${TEST_UID}/${child.jobId}`;
    const queuedRewrite = writes.find(
      (write) =>
        write.path === jobPath &&
        write.op === 'set' &&
        (write.value as { status?: string }).status === 'queued',
    );
    expect(queuedRewrite?.value).toMatchObject({ status: 'queued', wasCharged: true });
  });

  it('fallback: a pre-39-10 child with NO recorded fact still derives it from free access (a non-free uid is refunded once)', async () => {
    const { app, database } = mutableAccessPrepApp(['someone-else']);
    seedBundleBrief(database, TEST_UID, P39_ENTRY_KEY);
    database.seed(`credits/${TEST_UID}/balance`, 7);
    const now = Date.now();
    database.seed(`reportJobs/${TEST_UID}/legacy-child-1`, {
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      creditRef: 'legacy-child-1',
      reason: 'prep_bundle',
    });

    const response = await postPrepSingle(app, 'legacy-child-1', BUNDLE_OPPONENT_NAMES[0]);

    expect(response.statusCode).toBe(502);
    expect(await jobRecord(database, 'legacy-child-1')).toMatchObject({
      status: 'refunded',
      wasCharged: true,
    });
    expect(refundLedgerRefs(database)).toEqual(['legacy-child-1']);
    expect(await balanceOf(database)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Code review API-WR-01: a throw between the spend and the `running` claim
// (scout resolution, payload assembly — the window Phase 39 filled with the
// row builder, the claim builder, the action ranker and the canonical
// digest) must fail the job and refund through the existing `failJob`,
// EXACTLY ONCE, instead of stranding a spent credit on a `queued` job the
// stuck-job sweep (running index only) never visits.
// ---------------------------------------------------------------------------

describe('code review API-WR-01: a throw after the spend and before running refunds exactly once', () => {
  it('legacy scout: payload assembly throws on a corrupt own-history row — the job fails, one refund, balance restored, and the error still surfaces', async () => {
    const { app, database, modelSpy } = legacyBillableApp(() => VALID_REPORT);
    database.seed(`matches/${TEST_UID}/corrupt-row`, { fighter_id: 'not-a-number' });

    const response = await postLegacy(app, 'wr01-legacy-assembly');

    expect(response.statusCode).toBe(500);
    expect(modelSpy).not.toHaveBeenCalled();
    expect(await jobRecord(database, 'wr01-legacy-assembly')).toMatchObject({
      status: 'failed',
      wasCharged: true,
    });
    expect(spendLedgerRefs(database)).toEqual(['wr01-legacy-assembly']);
    expect(refundLedgerRefs(database)).toEqual(['wr01-legacy-assembly']);
    expect(await balanceOf(database)).toBe(1);
  });

  it('prep_report (parry.gg binding): the provider lookup THROWS inside the resolver — the job refunds once and rests at refunded', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const clients = parryClients({ getUser: () => ({ id: PARRY_USER_ID, gamerTag: 'Pandem1c' }) });
    (clients.matches as unknown as { getMatches: () => Promise<never> }).getMatches = vi.fn(
      async () => {
        throw new Error('parry.gg transport exploded');
      },
    );
    const { app, database } = buildTestApp({
      reports: P39_NON_ALLOWLIST_CONFIG,
      stripe: P39_STRIPE_CONFIG,
      prepPaid: P39_PREP_PAID_CONFIG,
      reportsClient: stubClient(modelSpy),
      parrygg: { apiKey: 'parry-key' },
      parryggClients: clients,
    });
    seedPrepBrief(database, TEST_UID, P39_ENTRY_KEY, {
      likelyOpponents: { rival: true },
      scoutBindings: { rival: P39_PARRY_BINDING },
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postPrepSingle(app, 'wr01-prep-parry');

    expect(response.statusCode).toBe(500);
    expect(modelSpy).not.toHaveBeenCalled();
    expect(await jobRecord(database, 'wr01-prep-parry')).toMatchObject({
      status: 'refunded',
      reason: 'prep_report',
      wasCharged: true,
    });
    expect(refundLedgerRefs(database)).toEqual(['wr01-prep-parry']);
    expect(await balanceOf(database)).toBe(1);
  });

  it('exactly once: a resolver that ALREADY failed the job before rethrowing (start.gg non-429 error) is not refunded a second time', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: VALID_REPORT,
    }));
    const { app, database } = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: (async () => new Response('upstream down', { status: 500 })) as typeof fetch,
      reports: P39_NON_ALLOWLIST_CONFIG,
      stripe: P39_STRIPE_CONFIG,
      reportsClient: stubClient(modelSpy),
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await postLegacy(app, 'wr01-startgg-once');

    expect(response.statusCode).toBe(500);
    expect(await jobRecord(database, 'wr01-startgg-once')).toMatchObject({ status: 'failed' });
    expect(refundLedgerRefs(database)).toEqual(['wr01-startgg-once']);
    expect(await balanceOf(database)).toBe(1);
  });
});

describe('code review API-IN-02: the stored model name is the one REPORT_MODEL constant', () => {
  it('a delivered scout report records exactly the model the generation call used', async () => {
    const { app, database, modelSpy } = legacyBillableApp(() => VALID_REPORT);

    expect((await postLegacy(app, 'in02-model')).statusCode).toBe(200);

    expect(REPORT_MODEL).toBe('claude-opus-4-8');
    const calledWith = (modelSpy.mock.calls[0] as unknown as [{ model: string }])[0].model;
    expect(calledWith).toBe(REPORT_MODEL);
    expect(storedScoutReports(database)[0]!.model).toBe(REPORT_MODEL);
  });
});

describe('code review SH-WR-05 / API-IN-03: droppedClaimCount counts claims only, never a dropped action slot', () => {
  it('a delivered report whose ONLY drop is an unlinked action slot stores no droppedClaimCount and emits no report_claims_dropped', async () => {
    const { app, database } = legacyBillableApp(() =>
      selectionOf(
        { overview: ['c01'], gameplan: ['c02'], watchFor: ['c03'] },
        {},
        // c09 is never selected, so it never survives: an R8 action drop.
        { action1: { actionId: 'a01', claimId: 'c09' } },
      ),
    );

    expect((await postLegacy(app, 'wr05-action-only')).statusCode).toBe(200);

    const report = storedScoutReports(database)[0]!.report as Record<string, unknown>;
    expect(report).not.toHaveProperty('droppedClaimCount');
    expect(findEvents(database, 'report_claims_dropped')).toHaveLength(0);
  });
});
