import { describe, expect, it } from 'vitest';
import { deploymentIdentitySchema, DEPLOYMENT_IDENTITY_VERSION } from '@smash-tracker/shared';
import { getDeploymentConfig, loadEnv, type DeploymentConfig } from '../config/env.js';
import { authHeader, buildTestApp } from '../test-support/testApp.js';

/**
 * Phase 30.3 (Gate 6 capture-evidence hardening, item 3).
 *
 * `GET /api/deployment-identity` exists so the probe-capture operator can
 * bind the API it drives to the RTDB it snapshots. Two properties matter and
 * both are asserted here: the endpoint must ANSWER honestly (including
 * answering "I don't know" as an explicit null rather than a placeholder),
 * and it must leak nothing — an unauthenticated infrastructure map, or a
 * secret riding along in a future field, would each be a worse problem than
 * the one it solves.
 */

const PRODUCTION_IDENTITY: DeploymentConfig = {
  identityVersion: DEPLOYMENT_IDENTITY_VERSION,
  environment: 'production',
  service: 'smash-tracker-api',
  revision: 'smash-tracker-api-00042-xyz',
  releaseSha: '09443b85f0c2d1e4a7b3c9d8e6f5a4b3c2d1e0f9',
  firebaseProjectId: 'smash-tracker-f97b7',
  databaseHost: 'smash-tracker-f97b7-default-rtdb.firebaseio.com',
  databaseEmulatorHost: null,
};

/** Every secret-bearing env var, set to a value we then hunt for in the response. */
const SECRET_ENV = {
  FIREBASE_DATABASE_URL: 'https://smash-tracker-f97b7-default-rtdb.firebaseio.com',
  STARTGG_CLIENT_SECRET: 'SECRET-startgg-client',
  STARTGG_API_TOKEN: 'SECRET-startgg-token',
  STARTGG_STATE_SECRET: 'SECRET-startgg-state',
  ANTHROPIC_API_KEY: 'SECRET-anthropic',
  STRIPE_SECRET_KEY: 'SECRET-stripe',
  STRIPE_WEBHOOK_SECRET: 'SECRET-stripe-webhook',
  PARRYGG_API_KEY: 'SECRET-parrygg',
  GA4_API_SECRET: 'SECRET-ga4',
  INTERNAL_JOBS_SECRET: 'SECRET-internal-jobs',
  CLAIM_CODE_HMAC_SECRET: 'SECRET-claim-hmac',
  YOUTUBE_API_KEY: 'SECRET-youtube',
  REPORTS_ALLOWED_UIDS: 'uid-allowlisted-1,uid-allowlisted-2',
  DEMO_ACCOUNT_UIDS: 'uid-demo-1,uid-demo-2',
  RESEARCH_ADMIN_UIDS: 'uid-research-admin-1',
};

describe('GET /api/deployment-identity', () => {
  it('reports the identity the server was built with', async () => {
    const { app } = buildTestApp({ deployment: PRODUCTION_IDENTITY });

    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment-identity',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(PRODUCTION_IDENTITY);
    // The wire shape is the shared contract, not merely whatever the handler
    // happened to return — the operator parses against this exact schema.
    expect(() => deploymentIdentitySchema.parse(response.json())).not.toThrow();
  });

  it('is AUTHENTICATED — an anonymous caller learns nothing about the deployment', async () => {
    const { app } = buildTestApp({ deployment: PRODUCTION_IDENTITY });

    const response = await app.inject({ method: 'GET', url: '/api/deployment-identity' });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(PRODUCTION_IDENTITY.revision);
    expect(response.body).not.toContain(PRODUCTION_IDENTITY.databaseHost);
    expect(response.body).not.toContain(PRODUCTION_IDENTITY.releaseSha);
  });

  it('rejects a malformed bearer the same way every other authed route does', async () => {
    const { app } = buildTestApp({ deployment: PRODUCTION_IDENTITY });

    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment-identity',
      headers: { authorization: 'Bearer not-a-registered-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 503 — never a guess — when the server was built without an identity', async () => {
    // Every pre-existing test app is built this way. A server that cannot
    // name itself must SAY so; the capture operator turns this into a hard
    // abort, which is the whole point of not defaulting.
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment-identity',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ statusCode: 503 });
  });

  it('serializes explicit NULLs for coordinates a non-Cloud-Run host cannot supply', async () => {
    const localIdentity: DeploymentConfig = {
      identityVersion: DEPLOYMENT_IDENTITY_VERSION,
      environment: 'development',
      service: null,
      revision: null,
      releaseSha: null,
      firebaseProjectId: null,
      databaseHost: '127.0.0.1:9000',
      databaseEmulatorHost: '127.0.0.1:9000',
    };
    const { app } = buildTestApp({ deployment: localIdentity });

    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment-identity',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Present-and-null, not absent: the operator distinguishes "the API said
    // it has no revision" from "the API did not answer that question".
    for (const key of ['service', 'revision', 'releaseSha', 'firebaseProjectId'] as const) {
      expect(key in body).toBe(true);
      expect(body[key]).toBeNull();
    }
  });

  it('exposes NO secret, token, key, or allowlist from a fully-configured environment', async () => {
    const env = loadEnv({ ...SECRET_ENV, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    const { app } = buildTestApp({ deployment: getDeploymentConfig(env) });

    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment-identity',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    for (const [name, value] of Object.entries(SECRET_ENV)) {
      if (name === 'FIREBASE_DATABASE_URL') continue;
      expect(response.body, `${name} leaked into the deployment identity`).not.toContain(value);
    }
    // Not even the full database URL — only its host.
    expect(response.body).not.toContain(SECRET_ENV.FIREBASE_DATABASE_URL);
    expect(response.json().databaseHost).toBe('smash-tracker-f97b7-default-rtdb.firebaseio.com');
  });

  it('the response carries EXACTLY the contracted members — the serializer is the guard', async () => {
    const { app } = buildTestApp({ deployment: PRODUCTION_IDENTITY });
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment-identity',
      headers: authHeader(),
    });
    expect(Object.keys(response.json()).sort()).toEqual([
      'databaseEmulatorHost',
      'databaseHost',
      'environment',
      'firebaseProjectId',
      'identityVersion',
      'releaseSha',
      'revision',
      'service',
    ]);
  });
});

describe('getDeploymentConfig', () => {
  const base = { FIREBASE_DATABASE_URL: 'https://example-rtdb.firebaseio.com' };

  it('derives the HOST from FIREBASE_DATABASE_URL, discarding path/query/userinfo', () => {
    const config = getDeploymentConfig(
      loadEnv({
        FIREBASE_DATABASE_URL: 'https://user:pw@example-rtdb.firebaseio.com/some/path?auth=SECRET',
      } as NodeJS.ProcessEnv),
    );
    expect(config.databaseHost).toBe('example-rtdb.firebaseio.com');
    expect(JSON.stringify(config)).not.toContain('SECRET');
    expect(JSON.stringify(config)).not.toContain('pw');
  });

  it('reads the Cloud Run coordinates the runtime injects', () => {
    const config = getDeploymentConfig(
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        K_SERVICE: 'smash-tracker-api',
        K_REVISION: 'smash-tracker-api-00042-xyz',
        API_RELEASE_SHA: 'deadbeef',
        GOOGLE_CLOUD_PROJECT: 'smash-tracker-f97b7',
      } as NodeJS.ProcessEnv),
    );
    expect(config).toMatchObject({
      environment: 'production',
      service: 'smash-tracker-api',
      revision: 'smash-tracker-api-00042-xyz',
      releaseSha: 'deadbeef',
      firebaseProjectId: 'smash-tracker-f97b7',
    });
  });

  it.each([
    ['unset', undefined],
    ['the EMPTY string a Dockerfile ARG passthrough produces', ''],
    ['whitespace only', '   '],
  ])('reports releaseSha as NULL when it is %s', (_label, value) => {
    const config = getDeploymentConfig(
      loadEnv({
        ...base,
        ...(value === undefined ? {} : { API_RELEASE_SHA: value }),
      } as NodeJS.ProcessEnv),
    );
    // The empty-string case is the one that matters: `ENV FOO=${FOO}` with an
    // unset build arg sets "" rather than leaving it undefined, and "" would
    // fail the shared schema's min(1) as a 500 instead of an honest null.
    expect(config.releaseSha).toBeNull();
    expect(() => deploymentIdentitySchema.parse(config)).not.toThrow();
  });

  it('carries the emulator host, which makes it a different database environment', () => {
    const config = getDeploymentConfig(
      loadEnv({ ...base, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000' } as NodeJS.ProcessEnv),
    );
    expect(config.databaseEmulatorHost).toBe('127.0.0.1:9000');
  });

  it('THROWS at startup on a database URL it cannot state a host for', () => {
    expect(() =>
      getDeploymentConfig(loadEnv({ FIREBASE_DATABASE_URL: 'not a url' } as NodeJS.ProcessEnv)),
    ).toThrow(/not a valid URL/);
  });

  it('never returns null — identity is not an integration that can be switched off', () => {
    expect(getDeploymentConfig(loadEnv(base as NodeJS.ProcessEnv))).not.toBeNull();
  });
});
