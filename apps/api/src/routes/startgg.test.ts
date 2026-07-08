import { describe, expect, it } from 'vitest';
import type { StartggConfig } from '../config/env.js';
import { signState } from '../startgg/oauth.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

const IDENTITY_RESPONSE = {
  data: {
    currentUser: {
      id: 42,
      slug: 'user/abc123',
      email: 'linked@example.com',
      player: { id: 777, gamerTag: 'TestTag' },
    },
  },
};

/** Dispatches the OAuth token exchange and GraphQL identity lookups. */
function oauthFetchMock(): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const target = String(url);
    if (target.includes('/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'access-token' }));
    }
    if (target.includes('/gql/alpha')) {
      return new Response(JSON.stringify(IDENTITY_RESPONSE));
    }
    throw new Error(`Unexpected fetch: ${target}`);
  }) as typeof fetch;
}

describe('start.gg routes (unconfigured)', () => {
  it('answers 503 for integration routes and the login entrypoint', async () => {
    const { app } = buildTestApp();

    const status = await app.inject({
      method: 'GET',
      url: '/api/integrations/startgg/status',
      headers: authHeader(),
    });
    expect(status.statusCode).toBe(503);

    const login = await app.inject({ method: 'GET', url: '/api/auth/startgg/login' });
    expect(login.statusCode).toBe(503);
  });
});

describe('start.gg routes (configured)', () => {
  it('requires auth on management routes', async () => {
    const { app } = buildTestApp({ startgg: CONFIG });
    const response = await app.inject({ method: 'GET', url: '/api/integrations/startgg/status' });
    expect(response.statusCode).toBe(401);
  });

  it('reports unlinked, then linked status', async () => {
    const { app, database } = buildTestApp({ startgg: CONFIG });

    const before = await app.inject({
      method: 'GET',
      url: '/api/integrations/startgg/status',
      headers: authHeader(),
    });
    expect(before.json()).toEqual({ linked: false });

    database.seed(`startggLinks/${TEST_UID}`, {
      userId: 42,
      playerId: 777,
      gamerTag: 'TestTag',
      slug: 'user/abc123',
      linkedAt: 1000,
      lastSyncAt: 2000,
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/integrations/startgg/status',
      headers: authHeader(),
    });
    expect(after.json()).toMatchObject({ linked: true, gamerTag: 'TestTag', playerId: 777 });
  });

  it('builds an authorize URL carrying a link state', async () => {
    const { app } = buildTestApp({ startgg: CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/startgg/authorize',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const { url } = response.json() as { url: string };
    expect(url).toContain('https://start.gg/oauth/authorize');
    expect(new URL(url).searchParams.get('state')).toBeTruthy();
  });

  it('refuses to sync when no account is linked', async () => {
    const { app } = buildTestApp({ startgg: CONFIG });
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/startgg/sync',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(409);
  });

  it('unlinks the account', async () => {
    const { app, database } = buildTestApp({ startgg: CONFIG });
    database.seed(`startggLinks/${TEST_UID}`, {
      userId: 42,
      playerId: 777,
      gamerTag: 'TestTag',
      slug: 'user/abc123',
      linkedAt: 1000,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/integrations/startgg/link',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(204);

    const status = await app.inject({
      method: 'GET',
      url: '/api/integrations/startgg/status',
      headers: authHeader(),
    });
    expect(status.json()).toEqual({ linked: false });
  });

  it('login entrypoint redirects to the start.gg authorize page', async () => {
    const { app } = buildTestApp({ startgg: CONFIG });
    const response = await app.inject({ method: 'GET', url: '/api/auth/startgg/login' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://start.gg/oauth/authorize');
  });

  it('callback with an invalid state redirects with an error reason', async () => {
    const { app } = buildTestApp({ startgg: CONFIG, startggFetch: oauthFetchMock() });
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/startgg/callback?code=abc&state=forged',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('startgg=error');
    expect(response.headers.location).toContain('invalid_state');
  });

  it('link callback stores the link and redirects to settings', async () => {
    const { app, database } = buildTestApp({ startgg: CONFIG, startggFetch: oauthFetchMock() });
    const state = signState(CONFIG.stateSecret, 'link', TEST_UID);

    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/startgg/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'http://localhost:5173/settings/integrations?startgg=linked',
    );
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['startggLinks']?.[TEST_UID]).toMatchObject({
      userId: 42,
      playerId: 777,
      gamerTag: 'TestTag',
    });
  });

  it('login callback creates the Firebase user and hands back a custom token', async () => {
    const { app, database } = buildTestApp({ startgg: CONFIG, startggFetch: oauthFetchMock() });
    const state = signState(CONFIG.stateSecret, 'login');

    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/startgg/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    expect(location).toContain('http://localhost:5173/auth/startgg#token=');
    expect(location).toContain('custom-token-for-fake-created-uid-1');

    // The freshly created account is linked immediately so sync works.
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect(tree['startggLinks']?.['fake-created-uid-1']).toMatchObject({ playerId: 777 });
  });

  it('login callback reuses an existing Firebase account by email', async () => {
    const { app, auth } = buildTestApp({ startgg: CONFIG, startggFetch: oauthFetchMock() });
    auth.seedUser({ uid: 'existing-uid', email: 'linked@example.com' });
    const state = signState(CONFIG.stateSecret, 'login');

    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/startgg/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });

    expect(response.headers.location).toContain('custom-token-for-existing-uid');
  });

  it('login callback degrades to an error redirect when completion throws', async () => {
    const { app, auth } = buildTestApp({ startgg: CONFIG, startggFetch: oauthFetchMock() });
    // Mirrors the live incident: createCustomToken throwing (the runtime
    // service account lacked iam.serviceAccounts.signBlob) must not surface
    // as a 500 — Hosting's proxy retries 5xx and burns the single-use code.
    auth.createCustomToken = async () => {
      throw new Error('Permission iam.serviceAccounts.signBlob denied');
    };
    const state = signState(CONFIG.stateSecret, 'login');

    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/startgg/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    expect(location).toContain('startgg=error');
    expect(location).toContain('reason=login_failed');
  });
});
