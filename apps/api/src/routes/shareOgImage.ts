import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RtdbService } from '../services/rtdb.js';
import { renderOgImage } from '../shares/renderOgImage.js';
import { createTtlCache } from '../shares/ttlCache.js';

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

export interface ShareOgImageRoutesOptions {
  /** SPA/Hosting origin sprites AND the static fallback image are fetched from (`env.WEB_BASE_URL`). */
  webBaseUrl: string;
  /** Overridable fetch for the sprite/fallback-image fetches (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Matches this route's own `Cache-Control: public, max-age=300` — no reason to cache the fetched static fallback bytes longer than clients/crawlers are told to. */
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_KEY = 'static-fallback';
const fallbackCache = createTtlCache<Buffer>(FALLBACK_CACHE_TTL_MS);

/**
 * Absolute last-resort fallback — a minimal 1x1 transparent PNG. Used ONLY
 * if BOTH the satori/resvg render AND the fetched static fallback
 * (`apps/web/public/og-image.png`, via the Hosting origin) fail. Guarantees
 * this route can never fail to produce PNG bytes, regardless of network
 * conditions — "never 500 the crawler path" has no escape hatch otherwise.
 */
const LAST_RESORT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): `GET
 * /s/:token/og.png` — the root-scoped (NOT `/api`-prefixed) generated OG
 * card. Deliberately PUBLIC, same posture as `shareMeta.ts`.
 *
 * Calls the SAME `RtdbService.getShareByToken` as the JSON/HTML routes —
 * never a second redaction path. `renderOgImage` is only ever invoked for a
 * non-null (active) snapshot; a null lookup (unknown/revoked/malformed
 * token) goes straight to the static fallback without attempting a render
 * (T-06-04 — never let a cache or a render path imply a token is valid).
 *
 * PRODUCTION-GAP CORRECTION (deviation from the plan's literal wording):
 * the plan describes this route as reading `apps/web/public/og-image.png`
 * bytes directly off local disk. That file is NEVER present in the
 * deployed Cloud Run container — the Dockerfile's `build` stage only
 * `COPY`s `packages/shared` and `apps/api` (never `apps/web`), and the
 * `runtime` stage copies ONLY `deploy/dist` + `deploy/node_modules` +
 * `package.json` from `pnpm --filter @smash-tracker/api deploy`. A local
 * `readFile('apps/web/public/og-image.png')` would ENOENT in production on
 * every single fallback hit — silently defeating the "never 500 the
 * crawler path" guarantee this route exists to provide. Instead, the
 * static image is fetched from the Hosting origin
 * (`${webBaseUrl}/og-image.png`, already deployed as a public static
 * asset — same origin `renderShareHtml`'s shell fetch and
 * `renderOgImage`'s sprite fetch already use), and cached briefly so a
 * sustained render outage doesn't hammer the Hosting origin on every
 * request either. If that fetch ALSO fails, `LAST_RESORT_PNG` (a minimal
 * embedded 1x1 transparent PNG) guarantees this route still returns valid
 * PNG bytes no matter what.
 *
 * `Cache-Control: public, max-age=300` (RESEARCH.md Open Question 3): OG
 * content is safe-forever by design (OG-02), so a short positive cache is
 * crawler-friendly and reduces render cost on repeated hits — unlike the
 * JSON/HTML routes, which stay `no-store` because their content genuinely
 * changes on revocation.
 *
 * Rate-limited via the same root-scoped `@fastify/rate-limit` context as
 * `shareMeta.ts` (app.ts), not a per-route `config.rateLimit` override.
 */
const shareOgImageRoutes: FastifyPluginAsyncZod<ShareOgImageRoutesOptions> = async (
  app,
  options,
) => {
  const rtdb = new RtdbService(app.firebase.database);
  const { webBaseUrl, fetchImpl = fetch } = options;

  app.get(
    '/s/:token/og.png',
    {
      schema: {
        params: tokenParamsSchema,
      },
    },
    async (request, reply) => {
      const snapshot = await rtdb.getShareByToken(request.params.token);

      let png: Buffer | null = null;
      if (snapshot) {
        png = await renderOgImage({
          token: request.params.token,
          snapshot,
          webBaseUrl,
          fetchImpl,
        });
      }
      if (!png) {
        png = await getStaticFallback(webBaseUrl, fetchImpl);
      }

      reply.header('Content-Type', 'image/png');
      reply.header('Cache-Control', 'public, max-age=300');
      return reply.code(200).send(png);
    },
  );
};

async function getStaticFallback(webBaseUrl: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const cached = fallbackCache.get(FALLBACK_CACHE_KEY);
  if (cached !== undefined) return cached;

  try {
    const response = await fetchImpl(`${webBaseUrl}/og-image.png`);
    if (!response.ok) {
      throw new Error(`og-image.png fetch failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fallbackCache.set(FALLBACK_CACHE_KEY, buffer);
    return buffer;
  } catch {
    return LAST_RESORT_PNG;
  }
}

export default shareOgImageRoutes;
