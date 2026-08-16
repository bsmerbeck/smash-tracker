import { describe, expect, it, vi } from 'vitest';
import {
  API_RELEASE_SHA_HEADER,
  API_REVISION_HEADER,
  DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
  DEPLOYMENT_IDENTITY_VERSION,
} from '@smash-tracker/shared';
import type { DemoAccountConfig, DeploymentConfig, StripeConfig } from './config/env.js';
import type { StripeLikeClient } from './routes/billing.js';
import { authHeader, buildTestApp, TEST_TOKEN } from './test-support/testApp.js';

/**
 * Phase 30.3 (deployment-binding hardening, item 3): the per-response ORIGIN
 * headers.
 *
 * WHAT THEY CLOSE. The Gate-6 capture operator makes three separate HTTP
 * requests — `GET /api/deployment-identity`, `GET /api/users/me`, and the
 * refused `POST /api/billing/checkout`. Only the first was ever bound to a
 * revision. Under Cloud Run split traffic, or a deploy landing mid-capture,
 * the three can be answered by DIFFERENT revisions, so the probe could bind an
 * identity from revision A while sealing a refusal from revision B — and
 * nothing in the artifact would show it. Each response now states which build
 * served it, and the operator refuses to seal a capture that spans more than
 * one.
 *
 * THREE PROPERTIES ARE LOAD-BEARING HERE, and all three are asserted:
 *  1. authenticated responses carry both headers;
 *  2. ERROR responses carry them too — the capture's decisive response is a
 *     403, and a header that vanished on the error path would be missing
 *     exactly when it is needed;
 *  3. anonymous and public-bearer responses carry NEITHER, so the
 *     least-exposure posture that made `/api/deployment-identity`
 *     authenticated is preserved and every no-oracle surface stays
 *     byte-identical.
 */

const IDENTITY: DeploymentConfig = {
  identityVersion: DEPLOYMENT_IDENTITY_VERSION,
  environment: 'production',
  service: 'smash-tracker-api',
  revision: 'smash-tracker-api-00042-xyz',
  releaseSha: '09443b85f0c2d1e4a7b3c9d8e6f5a4b3c2d1e0f9',
  firebaseProjectId: 'smash-tracker-f97b7',
  databaseHost: 'smash-tracker-f97b7-default-rtdb.firebaseio.com',
  databaseEmulatorHost: null,
};

const DEMO_UID = 'demo-hbox-uid-1';
const DEMO_TOKEN = 'demo-hbox-token';
const DEMO_CONFIG: DemoAccountConfig = { demoUids: new Set([DEMO_UID]) };
const STRIPE_CONFIG: StripeConfig = { secretKey: 'sk-test-123', webhookSecret: 'whsec-test-456' };

function stripeClient(): StripeLikeClient {
  return {
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ id: 'cs_test', url: 'https://checkout.stripe.com/x' })),
      },
    },
    webhooks: { constructEvent: vi.fn(() => ({}) as never) },
  } as unknown as StripeLikeClient;
}

/** An app that knows who it is, with the demo money guard armed. */
function buildOriginApp(deployment: DeploymentConfig | null = IDENTITY) {
  const built = buildTestApp({
    deployment,
    demo: DEMO_CONFIG,
    stripe: STRIPE_CONFIG,
    stripeClient: stripeClient(),
    webBaseUrl: 'https://grandfinals.gg',
  });
  built.auth.registerToken(DEMO_TOKEN, { uid: DEMO_UID, email: 'demo-hbox@test.com' });
  return built;
}

/** `GET /api/users/me` needs the profile node to exist; `PUT` creates it. */
async function seedProfile(app: ReturnType<typeof buildOriginApp>['app']): Promise<void> {
  await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
}

describe('deployment origin headers: every authenticated response names its own build', () => {
  it.each([
    ['GET /api/deployment-identity', '/api/deployment-identity'],
    ['GET /api/users/me', '/api/users/me'],
  ])('%s carries both coordinates', async (_label, url) => {
    const { app } = buildOriginApp();
    await seedProfile(app);

    const response = await app.inject({ method: 'GET', url, headers: authHeader() });

    expect(response.statusCode).toBe(200);
    expect(response.headers[API_REVISION_HEADER]).toBe(IDENTITY.revision);
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBe(IDENTITY.releaseSha);
  });

  /**
   * THE decisive one. The capture's evidence is a 403 from the demo checkout
   * guard; if that response could not state its own origin, the refusal would
   * remain free to come from a different revision than the identity the probe
   * is bound to — which is the entire hole being closed.
   */
  it('the demo checkout 403 — an ERROR response — carries them too', async () => {
    const { app } = buildOriginApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(DEMO_TOKEN),
      payload: { packId: 'pack5' },
    });

    expect(response.statusCode).toBe(403);
    // Still the application guard's own refusal — the header hook changed
    // nothing about the body contract the capture also verifies.
    expect(response.json().code).toBe(DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE);
    expect(response.headers[API_REVISION_HEADER]).toBe(IDENTITY.revision);
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBe(IDENTITY.releaseSha);
  });

  it('a NotFoundError mapped by the global error handler carries them as well', async () => {
    // A second error path, through a different mechanism than the demo
    // guard's `reply.code(403)`: this one is thrown from a handler and mapped
    // by `setErrorHandler`. `onSend` runs after both.
    const { app } = buildOriginApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/no-such-match-id',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers[API_REVISION_HEADER]).toBe(IDENTITY.revision);
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBe(IDENTITY.releaseSha);
  });
});

describe('deployment origin headers: absence is honest, never a placeholder', () => {
  it('emits NEITHER header when the server was built without a deployment identity', async () => {
    // Every pre-existing test app is built this way. The capture operator
    // turns the absence into a hard abort rather than a coordinate it skips.
    const { app } = buildOriginApp(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.headers[API_REVISION_HEADER]).toBeUndefined();
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBeUndefined();
  });

  it('omits the release-SHA header — never an empty one — when the image carries no SHA', async () => {
    // `ENV FOO=${FOO}` with an unset build arg yields "", which
    // `getDeploymentConfig` collapses to null. An empty header value would
    // read as an ANSWER; absence reads as "this build cannot say".
    const { app } = buildOriginApp({ ...IDENTITY, releaseSha: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.headers[API_REVISION_HEADER]).toBe(IDENTITY.revision);
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBeUndefined();
  });

  it('omits the revision header off Cloud Run, where no revision exists', async () => {
    const { app } = buildOriginApp({ ...IDENTITY, revision: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.headers[API_REVISION_HEADER]).toBeUndefined();
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBe(IDENTITY.releaseSha);
  });
});

/**
 * The least-exposure boundary. `GET /api/deployment-identity` was made
 * authenticated deliberately — an unauthenticated endpoint naming the service,
 * revision, release SHA, and backing database host is a free infrastructure
 * map. Emitting build coordinates on anonymous responses would quietly undo
 * two-thirds of that decision, so the hook is gated on `request.uid`.
 *
 * It also means every no-oracle surface stays byte-identical INCLUDING its
 * headers, rather than merely "identical to each other".
 */
describe('deployment origin headers: anonymous surfaces are untouched', () => {
  it.each([
    ['/healthz', 'GET' as const],
    ['/api/vod-shares/no-such-token', 'GET' as const],
    ['/api/review-deliveries/no-such-token', 'GET' as const],
  ])('%s carries NO build coordinates', async (url, method) => {
    const { app } = buildOriginApp();

    const response = await app.inject({ method, url });

    expect(response.headers[API_REVISION_HEADER]).toBeUndefined();
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBeUndefined();
  });

  it('a 401 from a failed authentication leaks nothing — the uid was never established', async () => {
    const { app } = buildOriginApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: 'Bearer not-a-registered-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers[API_REVISION_HEADER]).toBeUndefined();
    expect(response.headers[API_RELEASE_SHA_HEADER]).toBeUndefined();
    expect(response.body).not.toContain(IDENTITY.revision);
    expect(response.body).not.toContain(IDENTITY.releaseSha);
  });

  it('an anonymous request with no Authorization header at all is likewise bare', async () => {
    const { app } = buildOriginApp();

    const response = await app.inject({ method: 'GET', url: '/api/users/me' });

    expect(response.statusCode).toBe(401);
    expect(response.headers[API_REVISION_HEADER]).toBeUndefined();
  });
});

describe('deployment origin headers: nothing beyond the two build coordinates', () => {
  it('names no project or database host — those stay behind the authenticated identity route', async () => {
    const { app } = buildOriginApp();
    await seedProfile(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(TEST_TOKEN),
    });

    // The exact-set assertion is the real guard: a future coordinate cannot
    // ride along on this hook without being added here first.
    const emitted = Object.keys(response.headers)
      .filter((name) => name.startsWith('x-gf-'))
      .sort();
    expect(emitted).toEqual([API_RELEASE_SHA_HEADER, API_REVISION_HEADER].sort());
    // The infrastructure coordinates specifically. (No substring check for
    // `service`: a Cloud Run revision name legitimately EMBEDS the service
    // name, so such a check would fail on correct output.)
    const serialized = JSON.stringify(response.headers);
    expect(serialized).not.toContain(IDENTITY.databaseHost);
    expect(serialized).not.toContain(IDENTITY.firebaseProjectId);
  });
});
