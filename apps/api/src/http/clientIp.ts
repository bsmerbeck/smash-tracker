import type { FastifyRequest } from 'fastify';

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): rate-limit key for
 * the anonymous share routes. Deliberately NOT `request.ip`: with
 * `trustProxy: true`, `request.ip` resolves to the LEFTMOST X-Forwarded-For
 * entry, which is client-supplied — Cloud Run's front end APPENDS the real
 * client address to whatever XFF the caller sent, it never strips
 * caller-supplied entries. Keying on the leftmost entry therefore lets an
 * anonymous caller mint a fresh 60/min bucket per request by rotating a
 * spoofed header (TRUST-01 bypass). The RIGHTMOST entry is the one the
 * trusted Google front end actually appended — the closest-to-us,
 * non-spoofable address — so that is the key, falling back to the raw
 * socket address when no XFF header is present (direct connection).
 *
 * Lives outside `app.ts` (Phase 23, CRED-04) so route modules — e.g. the
 * claim redemption route — can import it without creating a module cycle
 * back through `app.ts`, which itself imports this function back under the
 * same name.
 */
export function anonRateLimitKey(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  // Multiple header instances arrive as an array; the trusted proxy appends
  // to the last one, so take the final entry of the final header value.
  const headerValue = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (headerValue) {
    const last = headerValue.split(',').pop()?.trim();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? request.ip;
}
