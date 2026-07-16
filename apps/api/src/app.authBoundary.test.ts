import { describe, expect, it } from 'vitest';
import { buildTestApp } from './test-support/testApp.js';

/**
 * The complete, audited set of routes that are DELIBERATELY reachable with
 * no `Authorization` header. This is NOT framed as "the first anonymous
 * route" — `gsp-live`, start.gg's login/callback, parry.gg's login flow,
 * and the Stripe webhook already bypass `app.authenticate` today, each for
 * a documented reason (see each route file's own module comment). Adding a
 * route here must be a reviewed, deliberate act — this is the single choke
 * point that answers "does anything unauthenticated exist?"
 *
 * IMPORTANT LIMITATION: this is a POSITIVE list ("routes I know are safe"),
 * not an exhaustive route-tree walk. If a future PR adds a new
 * authenticated route and forgets `preHandler: app.authenticate` (or the
 * file-scope `app.addHook('preHandler', app.authenticate)` equivalent),
 * this test will NOT catch it — the broken route was never added to
 * `KNOWN_ANONYMOUS_ROUTES` and this test only exercises routes IN that
 * list. The per-route assertions below (for THIS phase's new authenticated
 * routes) are the explicit inverse check for the routes this phase itself
 * adds; they don't generalize to routes added by other future phases.
 */
const KNOWN_ANONYMOUS_ROUTES: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'GET', url: '/healthz' },
  { method: 'GET', url: '/api/gsp-live' },
  { method: 'GET', url: '/api/auth/startgg/login' },
  { method: 'GET', url: '/api/integrations/startgg/callback' },
  { method: 'POST', url: '/api/auth/parrygg/login/search' },
  { method: 'POST', url: '/api/auth/parrygg/login/start' },
  { method: 'POST', url: '/api/auth/parrygg/login/complete' },
  { method: 'POST', url: '/api/billing/webhook' },
  { method: 'GET', url: '/api/vod-shares/:token' },
  // NEW this phase — root-scoped (not /api-prefixed) HTML shell + OG image:
  { method: 'GET', url: '/s/:token' },
  { method: 'GET', url: '/s/:token/og.png' },
];

describe('auth boundary', () => {
  it('every known-anonymous route accepts a request with no Authorization header', async () => {
    const { app } = buildTestApp();

    for (const route of KNOWN_ANONYMOUS_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url.replace(':token', 'x'),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).not.toBe(401);
    }
  });

  it('POST /api/vod-shares requires auth', async () => {
    const { app } = buildTestApp();

    // A schema-valid payload: Fastify validates the body (preValidation)
    // before running preHandler hooks, so a malformed body would 400
    // before the auth check ever runs — this must be well-formed to prove
    // the 401 comes from app.authenticate, not from body validation.
    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares',
      payload: {
        matchId: 'm1',
        redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('GET /api/vod-shares requires auth', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/vod-shares' });

    expect(response.statusCode).toBe(401);
  });

  it('POST /api/vod-shares/:id/revoke requires auth', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/vod-shares/some-id/revoke',
    });

    expect(response.statusCode).toBe(401);
  });
});
