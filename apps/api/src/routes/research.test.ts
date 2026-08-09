import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';
import { RESEARCH_FAMILY_REJECTION } from '../research/routeGuards.js';
import { confirmIdentityPlayers } from '../research/ingestion/identity.js';

const ADMIN_UID = 'admin-1';
const ADMIN_TOKEN = 'admin-token';
const OTHER_UID = 'other-uid';
const OTHER_TOKEN = 'other-token';

const RESEARCH_CONFIG = { adminUids: new Set([ADMIN_UID]) };

describe('POST /api/research/tenants', () => {
  it('allows an allowlisted admin to create a tenant and returns its id', async () => {
    const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Hbox snapshot' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toHaveProperty('tenantId');
    expect(typeof response.json().tenantId).toBe('string');
  });

  it('rejects a non-allowlisted caller with the family uniform rejection', async () => {
    const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      payload: { label: 'Hbox snapshot' },
    });

    expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('rejects every well-formed request with the family uniform rejection when the research config is null', async () => {
    const { app, auth } = buildTestApp({ research: null });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Hbox snapshot' },
    });

    expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('rejects a caller holding the reports allowlist but not the research allowlist, identically', async () => {
    const { app, auth } = buildTestApp({
      research: RESEARCH_CONFIG,
      reports: { anthropicApiKey: 'test-key', allowedUids: new Set([OTHER_UID]) },
    });
    auth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      payload: { label: 'Hbox snapshot' },
    });

    expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });
});

describe('GET /api/research/tenants', () => {
  it('allows an allowlisted admin to list their own research tenants', async () => {
    const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

    await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Hbox snapshot' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0].kind).toBe('research');
  });

  it('rejects a non-allowlisted caller with the family uniform rejection', async () => {
    const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });

    expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('rejects every well-formed request with the family uniform rejection when the research config is null', async () => {
    const { app, auth } = buildTestApp({ research: null });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });
});

describe('research route family: cross-reason equality (no-oracle)', () => {
  it('every authenticated negative reason returns the SAME status and body — deep equality, not independent assertions', async () => {
    const { app: appWithConfig, auth: authWithConfig } = buildTestApp({
      research: RESEARCH_CONFIG,
    });
    authWithConfig.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });
    const nonAllowlistedResponse = await appWithConfig.inject({
      method: 'GET',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });

    const { app: appNullConfig, auth: authNullConfig } = buildTestApp({ research: null });
    authNullConfig.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const nullConfigResponse = await appNullConfig.inject({
      method: 'GET',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(nonAllowlistedResponse.statusCode).toBe(nullConfigResponse.statusCode);
    expect(nonAllowlistedResponse.json()).toEqual(nullConfigResponse.json());
  });

  it("the family's rejection STATUS equals the status an unregistered path returns", async () => {
    // Deliberately does NOT compare the BODY: Fastify's default not-found
    // body embeds the request method and URL, so no single fixed value can
    // match it across every possible route — the narrowed claim this phase
    // proves is status-code parity only (C2-MED-4), never body equality.
    const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });

    const familyResponse = await app.inject({
      method: 'GET',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    const unregisteredResponse = await app.inject({
      method: 'GET',
      url: '/api/definitely-not-a-real-route',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });

    expect(familyResponse.statusCode).toBe(unregisteredResponse.statusCode);
  });
});

describe('research route family: authentication vs. authorization (two distinct classes)', () => {
  it('an unauthenticated request receives the authentication failure, NOT the family uniform rejection', async () => {
    const { app } = buildTestApp({ research: RESEARCH_CONFIG });

    const response = await app.inject({ method: 'GET', url: '/api/research/tenants' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('an unauthenticated POST also receives the authentication failure, not the family uniform rejection', async () => {
    const { app } = buildTestApp({ research: RESEARCH_CONFIG });

    // A schema-valid payload (mirrors app.authBoundary.test.ts's convention):
    // Fastify validates the body BEFORE preHandler hooks, so a malformed
    // body would 400 before the auth check ever runs — this must be
    // well-formed to prove the 401 comes from app.authenticate.
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      payload: { label: 'Hbox snapshot' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toEqual(RESEARCH_FAMILY_REJECTION.body);
  });
});

describe('research route family: malformed body is not an oracle', () => {
  it('the malformed-body validation response is byte-identical across allowlisted, non-allowlisted, and config-null callers', async () => {
    const { app: allowlistedApp, auth: allowlistedAuth } = buildTestApp({
      research: RESEARCH_CONFIG,
    });
    allowlistedAuth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const allowlistedResponse = await allowlistedApp.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { notLabel: 123 },
    });

    const { app: nonAllowlistedApp, auth: nonAllowlistedAuth } = buildTestApp({
      research: RESEARCH_CONFIG,
    });
    nonAllowlistedAuth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });
    const nonAllowlistedResponse = await nonAllowlistedApp.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      payload: { notLabel: 123 },
    });

    const { app: nullConfigApp, auth: nullConfigAuth } = buildTestApp({ research: null });
    nullConfigAuth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const nullConfigResponse = await nullConfigApp.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { notLabel: 123 },
    });

    expect(allowlistedResponse.statusCode).toBe(400);
    expect(nonAllowlistedResponse.statusCode).toBe(400);
    expect(nullConfigResponse.statusCode).toBe(400);
    expect(allowlistedResponse.json()).toEqual(nonAllowlistedResponse.json());
    expect(nonAllowlistedResponse.json()).toEqual(nullConfigResponse.json());
  });
});

/**
 * Phase 29 Plan 10 (RTEN-05A): the family's FIRST tenant-addressed routes —
 * entitlement grant/revoke on `/api/research/tenants/:tenantId/entitlement/*`.
 * Reuses `requireResearchTenantAdmin` (plan 29-05), so every negative
 * outcome collapses to the SAME `RESEARCH_FAMILY_REJECTION` this file's
 * other describe blocks already assert against.
 */
describe('entitlement grant/revoke: tenant-addressed authorization', () => {
  async function createResearchTenant(): Promise<{
    app: ReturnType<typeof buildTestApp>['app'];
    auth: ReturnType<typeof buildTestApp>['auth'];
    tenantId: string;
  }> {
    const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Hbox snapshot' },
    });
    const tenantId = createResponse.json().tenantId as string;
    return { app, auth, tenantId };
  }

  it('allows an allowlisted admin who is a member to grant an entitlement', async () => {
    const { app, tenantId } = await createResearchTenant();

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ idempotencyKey: 'idem-key-001' });
    expect(typeof response.json().grantId).toBe('string');
  });

  it('is idempotent: the same idempotency key returns the same grant identifier', async () => {
    const { app, tenantId } = await createResearchTenant();

    const first = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });

    expect(second.json().grantId).toBe(first.json().grantId);
  });

  it('allows the owning admin to revoke, returning { ok: true }', async () => {
    const { app, tenantId } = await createResearchTenant();

    const grantResponse = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });
    const { grantId } = grantResponse.json();

    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/revoke`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { expectedGrantId: grantId },
    });

    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json()).toEqual({ ok: true });
  });

  it('a repeated revoke is a no-op returning the same response', async () => {
    const { app, tenantId } = await createResearchTenant();
    const grantResponse = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });
    const { grantId } = grantResponse.json();

    const firstRevoke = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/revoke`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { expectedGrantId: grantId },
    });
    const secondRevoke = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/revoke`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { expectedGrantId: grantId },
    });

    expect(secondRevoke.json()).toEqual(firstRevoke.json());
  });

  it('rejects a non-allowlisted caller on grant with the family uniform rejection', async () => {
    const { app, auth, tenantId } = await createResearchTenant();
    auth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });

    expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('rejects an allowlisted admin who is NOT a member of this tenant, on both grant and revoke', async () => {
    const { app, auth, tenantId } = await createResearchTenant();
    const SECOND_ADMIN_UID = 'admin-2';
    const SECOND_ADMIN_TOKEN = 'admin-2-token';
    const secondResearchConfig = { adminUids: new Set([ADMIN_UID, SECOND_ADMIN_UID]) };
    // Rebuild the app with BOTH admins allowlisted, but the second admin
    // was never made a member of `tenantId` (createResearchTenant() above
    // only wrote membership for ADMIN_UID).
    const { app: sharedApp, auth: sharedAuth } = buildTestApp({ research: secondResearchConfig });
    void app; // the first app/tenant is discarded; only tenantId is reused.
    void auth;
    sharedAuth.registerToken(SECOND_ADMIN_TOKEN, {
      uid: SECOND_ADMIN_UID,
      email: 'admin2@test.com',
    });

    const grantResponse = await sharedApp.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${SECOND_ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });
    expect(grantResponse.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(grantResponse.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);

    const revokeResponse = await sharedApp.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/revoke`,
      headers: { authorization: `Bearer ${SECOND_ADMIN_TOKEN}` },
      payload: { expectedGrantId: 'whatever' },
    });
    expect(revokeResponse.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(revokeResponse.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('rejects every well-formed grant/revoke request with the family uniform rejection when the research config is null', async () => {
    const { tenantId } = await createResearchTenant();
    const { app: nullConfigApp, auth: nullConfigAuth } = buildTestApp({ research: null });
    nullConfigAuth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

    const grantResponse = await nullConfigApp.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });
    expect(grantResponse.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
    expect(grantResponse.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
  });

  it('rejects a path-illegal tenantId as a schema validation error, not a 500 (review C2-A6)', async () => {
    // Phase 30 Plan 07 extends the family-wide path-safety mandate (review
    // C2-A6) to `:tenantId` itself via the shared `pathSafeTenantIdSchema`
    // referenced by every route's `params` schema — including this
    // pre-existing Phase 29 route. An illegal tenantId now fails Fastify's
    // OWN schema validation before the handler (and therefore
    // `requireResearchTenantAdmin`) ever runs, so the response is a 400
    // validation error rather than the family's 404 uniform rejection. Both
    // are non-500, non-oracle outcomes; this test asserts the NEW one.
    const { app } = await createResearchTenant();

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${encodeURIComponent('tenant.illegal')}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'idem-key-001' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
  });

  it('rejects a malformed idempotency key at the schema boundary (400), never reaching the store', async () => {
    const { app, tenantId } = await createResearchTenant();

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { idempotencyKey: 'ab' },
    });

    expect(response.statusCode).toBe(400);
  });
});

/**
 * Phase 30 Plan 07 (ING-01/ING-02/ING-05): the eleven identity/backfill/
 * coverage/supplement routes. All eleven reuse `requireResearchTenantAdmin`
 * verbatim as the first statement of every handler, so every negative
 * authorization outcome collapses to the SAME `RESEARCH_FAMILY_REJECTION`
 * this file's other describe blocks already assert against.
 */
function asDatabase(database: unknown): Database {
  return database as Database;
}

const PLAYER_ID = '100';

async function createConfirmedResearchTenant(): Promise<{
  app: ReturnType<typeof buildTestApp>['app'];
  auth: ReturnType<typeof buildTestApp>['auth'];
  database: ReturnType<typeof buildTestApp>['database'];
  tenantId: string;
}> {
  const { app, auth, database } = buildTestApp({
    research: RESEARCH_CONFIG,
    startgg: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://example.com/cb',
      apiToken: 'server-token',
      stateSecret: 'state-secret',
      webBaseUrl: 'https://example.com',
    },
    // A stub with no real network I/O — every call this route table's tests
    // make (identity/resolve, backfill/trigger's immediate batch) must never
    // reach the real `fetch` global.
    startggFetch: makeStartggFetch({
      slugResolvesTo: Number(PLAYER_ID),
      pages: { 1: { totalPages: 1, sets: [] } },
    }),
  });
  auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/research/tenants',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { label: 'Hbox snapshot' },
  });
  const tenantId = createResponse.json().tenantId as string;

  await confirmIdentityPlayers(asDatabase(database), tenantId, ADMIN_UID, [
    { playerId: PLAYER_ID, gamerTag: 'Subject' },
  ]);

  return { app, auth, database, tenantId };
}

/** A scripted start.gg fetch: resolves the slug query and the research-sets-page query, both from ONE inspectable request body. */
function makeStartggFetch(
  opts: {
    slugResolvesTo?: number | null;
    pages?: Record<number, { totalPages: number; sets: unknown[] }>;
  } = {},
): typeof fetch {
  return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (body.query.includes('ResolveBySlug')) {
      const resolvedId = opts.slugResolvesTo;
      return new Response(
        JSON.stringify({
          data: {
            user:
              resolvedId != null
                ? { id: 1, slug: 'user/resolved', player: { id: resolvedId, gamerTag: 'Resolved' } }
                : null,
          },
        }),
      );
    }
    if (body.query.includes('ResearchPlayerSets')) {
      const page = body.variables.page as number;
      const entry = opts.pages?.[page] ?? { totalPages: 1, sets: [] };
      return new Response(
        JSON.stringify({
          data: {
            player: { sets: { pageInfo: { totalPages: entry.totalPages }, nodes: entry.sets } },
          },
        }),
      );
    }
    return new Response(JSON.stringify({ data: null }));
  }) as unknown as typeof fetch;
}

interface RouteTableEntry {
  method: 'GET' | 'POST' | 'DELETE';
  urlFor: (tenantId: string) => string;
  body?: Record<string, unknown>;
}

const NEW_ROUTE_TABLE: RouteTableEntry[] = [
  {
    method: 'POST',
    urlFor: (t) => `/api/research/tenants/${t}/identity/resolve`,
    body: { slug: 'user/whoever' },
  },
  {
    method: 'POST',
    urlFor: (t) => `/api/research/tenants/${t}/identity/confirm`,
    body: { players: [{ playerId: PLAYER_ID }] },
  },
  { method: 'GET', urlFor: (t) => `/api/research/tenants/${t}/identity` },
  { method: 'DELETE', urlFor: (t) => `/api/research/tenants/${t}/identity/${PLAYER_ID}` },
  {
    method: 'POST',
    urlFor: (t) => `/api/research/tenants/${t}/backfill/trigger`,
    body: { mode: 'full' },
  },
  {
    method: 'POST',
    urlFor: (t) => `/api/research/tenants/${t}/backfill/advance`,
    body: { runId: 'some-run-id' },
  },
  { method: 'GET', urlFor: (t) => `/api/research/tenants/${t}/backfill/status` },
  { method: 'GET', urlFor: (t) => `/api/research/tenants/${t}/coverage` },
  {
    method: 'POST',
    urlFor: (t) => `/api/research/tenants/${t}/supplements`,
    body: { targetSetId: '1', field: 'note', value: 'x', sourceKind: 'manual' },
  },
  {
    method: 'DELETE',
    urlFor: (t) => `/api/research/tenants/${t}/supplements/1/manual-note`,
  },
  { method: 'GET', urlFor: (t) => `/api/research/tenants/${t}/supplements/1` },
];

describe.each(NEW_ROUTE_TABLE)(
  '$method $urlFor(":tenantId") — five negative authorization classes',
  (entry) => {
    it('allows an allowlisted admin who is a member', async () => {
      const { app, tenantId } = await createConfirmedResearchTenant();
      const response = await app.inject({
        method: entry.method,
        url: entry.urlFor(tenantId),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: entry.body,
      });
      expect(response.statusCode).not.toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.statusCode).toBeLessThan(500);
    });

    it('rejects a non-allowlisted caller with the family uniform rejection', async () => {
      const { app, auth, tenantId } = await createConfirmedResearchTenant();
      auth.registerToken(OTHER_TOKEN, { uid: OTHER_UID, email: 'other@test.com' });
      const response = await app.inject({
        method: entry.method,
        url: entry.urlFor(tenantId),
        headers: { authorization: `Bearer ${OTHER_TOKEN}` },
        payload: entry.body,
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });

    it('rejects every well-formed request with the family uniform rejection when the research config is null', async () => {
      const { tenantId } = await createConfirmedResearchTenant();
      const { app: nullConfigApp, auth: nullConfigAuth } = buildTestApp({ research: null });
      nullConfigAuth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
      const response = await nullConfigApp.inject({
        method: entry.method,
        url: entry.urlFor(tenantId),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: entry.body,
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });

    it('rejects an allowlisted admin who is NOT a member of this tenant', async () => {
      const { tenantId } = await createConfirmedResearchTenant();
      const SECOND_ADMIN_UID = 'admin-2';
      const SECOND_ADMIN_TOKEN = 'admin-2-token';
      const { app: sharedApp, auth: sharedAuth } = buildTestApp({
        research: { adminUids: new Set([ADMIN_UID, SECOND_ADMIN_UID]) },
      });
      sharedAuth.registerToken(SECOND_ADMIN_TOKEN, {
        uid: SECOND_ADMIN_UID,
        email: 'admin2@test.com',
      });
      const response = await sharedApp.inject({
        method: entry.method,
        url: entry.urlFor(tenantId),
        headers: { authorization: `Bearer ${SECOND_ADMIN_TOKEN}` },
        payload: entry.body,
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });

    it('rejects a coaching-tenant (non-research) member with the family uniform rejection', async () => {
      const { app, auth, database } = await createConfirmedResearchTenant();
      // A coaching (non-research) tenant the SAME admin is a member of.
      const coachingTenantId = 'coaching-tenant-1';
      database.seed(`clientTenants/${coachingTenantId}`, { kind: 'coaching' });
      database.seed(`clientMembers/${coachingTenantId}/${ADMIN_UID}`, true);
      void auth;
      const response = await app.inject({
        method: entry.method,
        url: entry.urlFor(coachingTenantId),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: entry.body,
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });
  },
);

describe('backfill trigger: identity resolution and validate-then-create', () => {
  it('refuses an unconfirmed workspace with 409 and zero fetch calls', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: null }));
    }) as unknown as typeof fetch;
    const { app, auth } = buildTestApp({
      research: RESEARCH_CONFIG,
      startgg: {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://example.com/cb',
        apiToken: 'server-token',
        stateSecret: 'ss',
        webBaseUrl: 'https://example.com',
      },
      startggFetch: fetchImpl,
    });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Unconfirmed' },
    });
    const tenantId = createResponse.json().tenantId as string;

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full' },
    });

    expect(response.statusCode).toBe(409);
    expect(fetchCalls).toBe(0);
  });

  it('refuses a playerId that is not in the confirmed set with 409', async () => {
    const { app, tenantId } = await createConfirmedResearchTenant();
    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full', playerId: '999999' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('a slug that resolves to a CONFIRMED id starts the run against that id (review C-H9c)', async () => {
    // Built once, from the start, with the scripted fetch AND the confirmed
    // identity in place — `createConfirmedResearchTenant()`'s own app
    // instance has no fetch override, so a fresh instance is built here
    // instead of trying to swap options onto an existing app.
    const built = buildTestApp({
      research: RESEARCH_CONFIG,
      startgg: {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://example.com/cb',
        apiToken: 'server-token',
        stateSecret: 'ss',
        webBaseUrl: 'https://example.com',
      },
      startggFetch: makeStartggFetch({ slugResolvesTo: Number(PLAYER_ID) }),
    });
    built.auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await built.app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Slug test' },
    });
    const slugTenantId = createResponse.json().tenantId as string;
    await confirmIdentityPlayers(asDatabase(built.database), slugTenantId, ADMIN_UID, [
      { playerId: PLAYER_ID },
    ]);

    const response = await built.app.inject({
      method: 'POST',
      url: `/api/research/tenants/${slugTenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full', slug: 'user/whoever' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().batch.runId).toBeTruthy();
  });

  it('a slug that resolves to an UNCONFIRMED id answers 409', async () => {
    const built = buildTestApp({
      research: RESEARCH_CONFIG,
      startgg: {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://example.com/cb',
        apiToken: 'server-token',
        stateSecret: 'ss',
        webBaseUrl: 'https://example.com',
      },
      startggFetch: makeStartggFetch({ slugResolvesTo: 999999 }),
    });
    built.auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await built.app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Slug unconfirmed test' },
    });
    const tenantId = createResponse.json().tenantId as string;
    await confirmIdentityPlayers(asDatabase(built.database), tenantId, ADMIN_UID, [
      { playerId: PLAYER_ID },
    ]);

    const response = await built.app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full', slug: 'user/whoever' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('a slug that resolves to nothing answers 404', async () => {
    const built = buildTestApp({
      research: RESEARCH_CONFIG,
      startgg: {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://example.com/cb',
        apiToken: 'server-token',
        stateSecret: 'ss',
        webBaseUrl: 'https://example.com',
      },
      startggFetch: makeStartggFetch({ slugResolvesTo: null }),
    });
    built.auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await built.app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Slug not found test' },
    });
    const tenantId = createResponse.json().tenantId as string;
    await confirmIdentityPlayers(asDatabase(built.database), tenantId, ADMIN_UID, [
      { playerId: PLAYER_ID },
    ]);

    const response = await built.app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full', slug: 'user/whoever' },
    });

    expect(response.statusCode).toBe(404);
  });

  it("neither id nor slug supplied targets selectPrimaryConfirmedPlayerId's result", async () => {
    const { app, database, tenantId } = await createConfirmedResearchTenant();
    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full' },
    });
    expect(response.statusCode).toBe(200);
    const { runId } = response.json() as { runId: string };
    const { readBackfillRun } = await import('../research/ingestion/backfillRun.js');
    const run = await readBackfillRun(asDatabase(database), tenantId, runId);
    expect(run?.playerId).toBe(PLAYER_ID);
  });

  it('a trigger requesting 20 pages fetches at most TRIGGER_MAX_PAGES_PER_REQUEST pages synchronously (review C-M7)', async () => {
    let pagesFetched = 0;
    const built = buildTestApp({
      research: RESEARCH_CONFIG,
      startgg: {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://example.com/cb',
        apiToken: 'server-token',
        stateSecret: 'ss',
        webBaseUrl: 'https://example.com',
      },
      startggFetch: (async () => {
        pagesFetched += 1;
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 20 }, nodes: [] } } },
          }),
        );
      }) as unknown as typeof fetch,
    });
    built.auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await built.app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Page cap test' },
    });
    const tenantId = createResponse.json().tenantId as string;
    await confirmIdentityPlayers(asDatabase(built.database), tenantId, ADMIN_UID, [
      { playerId: PLAYER_ID },
    ]);

    await built.app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full', maxPages: 20 },
    });

    // Every page this mock returns is an empty (0-node) page against a
    // real, non-collapsed totalPages of 20 — the Dead-PREFIX extension's
    // shared same-page ID-only confirmation probe now runs for EVERY such
    // page (empty or short-non-empty), so each of the
    // TRIGGER_MAX_PAGES_PER_REQUEST pages can cost up to two fetches (the
    // heavy query plus its confirmation probe) instead of one.
    expect(pagesFetched).toBeLessThanOrEqual(3 * 2);
  });

  it("a trigger for a second confirmed player while another player's run is active returns 409 naming the active player (review C2-H3)", async () => {
    const built = buildTestApp({
      research: RESEARCH_CONFIG,
      startgg: {
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://example.com/cb',
        apiToken: 'server-token',
        stateSecret: 'ss',
        webBaseUrl: 'https://example.com',
      },
      startggFetch: (async () =>
        new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } } },
          }),
        )) as unknown as typeof fetch,
    });
    built.auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await built.app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'Busy test' },
    });
    const tenantId = createResponse.json().tenantId as string;
    const SECOND_PLAYER_ID = '200';
    await confirmIdentityPlayers(asDatabase(built.database), tenantId, ADMIN_UID, [
      { playerId: PLAYER_ID },
      { playerId: SECOND_PLAYER_ID },
    ]);

    // Manually create an ACTIVE (never-completing) run for the first player
    // via the run-state module directly, bypassing the trigger route so no
    // batch executes and the run stays running.
    const { createOrResumeBackfillRun } = await import('../research/ingestion/backfillRun.js');
    await createOrResumeBackfillRun(asDatabase(built.database), {
      tenantId,
      playerId: PLAYER_ID,
      requestedByUid: ADMIN_UID,
      mode: 'full',
    });

    const response = await built.app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full', playerId: SECOND_PLAYER_ID },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().activePlayerId).toBe(PLAYER_ID);
  });

  it('answers 503 when the start.gg config is null', async () => {
    const { app, auth, database } = buildTestApp({ research: RESEARCH_CONFIG });
    auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/research/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: 'No startgg' },
    });
    const tenantId = createResponse.json().tenantId as string;
    await confirmIdentityPlayers(asDatabase(database), tenantId, ADMIN_UID, [
      { playerId: PLAYER_ID },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/backfill/trigger`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { mode: 'full' },
    });

    expect(response.statusCode).toBe(503);
  });
});

describe('research route family: path-safe segments across every parameter (review C2-A6)', () => {
  const UNSAFE_SEGMENT_ROUTES: { name: string; urlFor: (unsafe: string) => string }[] = [
    { name: ':tenantId', urlFor: (unsafe) => `/api/research/tenants/${unsafe}/identity` },
    {
      name: ':playerId',
      urlFor: (unsafe) => `/api/research/tenants/valid-tenant/identity/${unsafe}`,
    },
    {
      name: ':targetSetId',
      urlFor: (unsafe) => `/api/research/tenants/valid-tenant/supplements/${unsafe}`,
    },
    {
      name: ':supplementId',
      urlFor: (unsafe) => `/api/research/tenants/valid-tenant/supplements/1/${unsafe}`,
    },
  ];

  describe.each(UNSAFE_SEGMENT_ROUTES)('$name', ({ urlFor }) => {
    it.each(['.', '#'])(
      'a "%s"-bearing value asserts a 400-class response, never a 500',
      async (unsafeChar) => {
        const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG });
        auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
        const response = await app.inject({
          method: 'GET',
          url: urlFor(encodeURIComponent(`bad${unsafeChar}value`)),
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
      },
    );
  });
});

describe('supplement authorship (review: attributedToUid is never client-supplied)', () => {
  it('a supplement POST whose body attempts to set an author uid stores the caller uid instead', async () => {
    const { app, tenantId } = await createConfirmedResearchTenant();

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/supplements`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        targetSetId: '1',
        field: 'note',
        value: 'attempted spoof',
        sourceKind: 'manual',
        attributedToUid: 'someone-else',
      },
    });

    expect(response.statusCode).toBe(200);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/research/tenants/${tenantId}/supplements/1`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const supplements = listResponse.json() as Array<{ attributedToUid: string }>;
    expect(supplements).toHaveLength(1);
    expect(supplements[0]?.attributedToUid).toBe(ADMIN_UID);
  });
});
