import { describe, expect, it } from 'vitest';
import { buildTestApp } from './test-support/testApp.js';

/**
 * Quick task 261006-kqb: `@fastify/cors` defaults its allowed methods to
 * GET, HEAD and POST. The dev web app (localhost:5173) calls this API cross-origin
 * (localhost:3001), so without an explicit list every PUT/PATCH/DELETE — profile
 * provisioning, ruleset/tier edits, deletes — failed at preflight. Production is
 * same-origin through the Hosting rewrite and never preflights.
 */

const ALLOWED_ORIGIN = 'http://localhost:5173';

function preflight(app: ReturnType<typeof buildTestApp>['app'], origin: string, method: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/api/users/me',
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type',
    },
  });
}

describe('CORS preflight', () => {
  it.each(['PUT', 'PATCH', 'DELETE'])('allows %s from the configured origin', async (method) => {
    const { app } = buildTestApp();
    const res = await preflight(app, ALLOWED_ORIGIN, method);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const allowed = String(res.headers['access-control-allow-methods'] ?? '').split(/\s*,\s*/);
    expect(allowed).toContain(method);
    await app.close();
  });

  it('never echoes an origin that is not configured', async () => {
    const { app } = buildTestApp();
    const res = await preflight(app, 'https://evil.example', 'PATCH');
    // A fixed-string origin is always sent as-is; the browser rejects the mismatch.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    await app.close();
  });
});
