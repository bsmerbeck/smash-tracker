import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';
import { RESEARCH_FAMILY_REJECTION } from '../research/routeGuards.js';

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
