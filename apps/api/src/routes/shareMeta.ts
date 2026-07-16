import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RtdbService } from '../services/rtdb.js';
import { renderShareHtml } from '../shares/renderShareHtml.js';

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

export interface ShareMetaRoutesOptions {
  /** SPA origin `spa.html` is fetched from and the canonical/og:url is built against (`env.WEB_BASE_URL`). */
  webBaseUrl: string;
  /** Overridable fetch for the spa.html shell fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): `GET /s/:token` —
 * the root-scoped (NOT `/api`-prefixed — must match `firebase.json`'s new
 * `/s/**` rewrite literally) HTML shell that Discord/Twitter/Slack unfurl
 * bots AND real browsers both hit. Deliberately PUBLIC (no
 * `app.authenticate` hook, same posture as `gspLive.ts`/`publicVodShares.ts`):
 * a share link's whole purpose is to be openable without an account.
 *
 * Calls the SAME `RtdbService.getShareByToken` as the JSON route — never a
 * second redaction path (RESEARCH.md Anti-Patterns). Renders via
 * `renderShareHtml`, which derives all OG meta from the public snapshot
 * only.
 *
 * ALWAYS returns 200, even for an unknown/revoked token (RESEARCH.md Open
 * Question 2): a non-200 status risks some unfurl bots treating "nothing to
 * unfurl" and refusing entirely, and matches the existing `**` SPA-fallback
 * convention where the client owns the empty/error state. `renderShareHtml`
 * already produces generic, non-leaking meta for a `null` snapshot
 * (VIEW-05).
 *
 * `Cache-Control: no-store` — revocation must take effect on the very next
 * request; Firebase Hosting's blanket `headers` block does not apply to
 * this Cloud-Run-rewritten route (RESEARCH.md Pitfall 6), so this is set
 * explicitly. `Referrer-Policy: strict-origin-when-cross-origin` keeps the
 * token (part of this URL) out of the `Referer` header sent to the
 * embedded YouTube/Twitch iframes the client-side ShareViewPage mounts
 * (T-06-08).
 *
 * Rate-limited via the root-scoped `@fastify/rate-limit` context this route
 * is registered inside (`app.ts`), NOT a per-route `config.rateLimit`
 * override — this route is root-scoped outside `/api`, so it needs its own
 * scoped plugin instance rather than reusing the `/api` block's top-level
 * `global: false` registration (TRUST-01).
 */
const shareMetaRoutes: FastifyPluginAsyncZod<ShareMetaRoutesOptions> = async (app, options) => {
  const rtdb = new RtdbService(app.firebase.database);
  const { webBaseUrl, fetchImpl } = options;

  app.get(
    '/s/:token',
    {
      schema: {
        params: tokenParamsSchema,
      },
    },
    async (request, reply) => {
      const snapshot = await rtdb.getShareByToken(request.params.token);
      const html = await renderShareHtml({
        token: request.params.token,
        snapshot,
        webBaseUrl,
        fetchImpl,
      });

      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      return reply.code(200).send(html);
    },
  );
};

export default shareMetaRoutes;
