import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { anonRateLimitKey } from './clientIp.js';

/**
 * GHSA-3m5p-2c4r-xxw2 (fixed in fastify 5.12.1) changed how fastify itself
 * derives `request.ip` / `hostname` / `protocol` from X-Forwarded-* headers
 * when `trustProxy` is enabled — this app runs `trustProxy: true`
 * (`apps/api/src/app.ts`). `anonRateLimitKey` deliberately does NOT use
 * `request.ip` for the same reason documented in `clientIp.ts`: under
 * `trustProxy: true`, fastify's own IP derivation reads the LEFTMOST
 * X-Forwarded-For entry, which is caller-supplied and therefore spoofable.
 * This suite pins `anonRateLimitKey`'s independent, rightmost-entry
 * extraction so a future fastify bump — including this one — cannot silently
 * change the rate-limit/claims spoof-resistance property by changing what
 * `request.ip` means. These tests ran green on fastify 5.9.0 before the bump
 * in this task and are unchanged (byte-identical assertions) after it.
 */
function buildApp() {
  return Fastify({ trustProxy: true });
}

function registerKeyRoute(app: ReturnType<typeof buildApp>) {
  app.get('/probe', async (request) => ({
    key: anonRateLimitKey(request),
    fastifyIp: request.ip,
  }));
}

describe('anonRateLimitKey under trustProxy: true', () => {
  it('returns the RIGHTMOST X-Forwarded-For entry (the trusted front end append)', async () => {
    const app = buildApp();
    registerKeyRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 203.0.113.7' },
    });

    expect(response.json().key).toBe('203.0.113.7');
    await app.close();
  });

  it('does NOT return the leftmost, client-spoofable entry (TRUST-01 spoof resistance)', async () => {
    const app = buildApp();
    registerKeyRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 203.0.113.7' },
    });

    expect(response.json().key).not.toBe('9.9.9.9');
    await app.close();
  });

  it('takes the last entry of the LAST header instance when X-Forwarded-For repeats', async () => {
    const app = buildApp();
    registerKeyRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2, 198.51.100.9'] },
    });

    expect(response.json().key).toBe('198.51.100.9');
    await app.close();
  });

  it('falls back to the socket address when no X-Forwarded-For header is present', async () => {
    const app = buildApp();
    registerKeyRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '198.18.0.42',
    });

    expect(response.json().key).toBe('198.18.0.42');
    await app.close();
  });
});
