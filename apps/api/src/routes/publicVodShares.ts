import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema, publicShareSnapshotSchema } from '@smash-tracker/shared';
import { z } from 'zod';
import { RtdbService } from '../services/rtdb.js';

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): `GET
 * /api/vod-shares/:token` is the app's first real anonymous read surface —
 * no longer the Phase 5 501 registration stub. It is deliberately PUBLIC (no
 * `app.authenticate` hook anywhere in this file, same posture as
 * `gspLive.ts`): a share link's entire purpose is to be openable without an
 * account.
 *
 * The handler only ever calls `RtdbService.getShareByToken`, which touches
 * exactly two subtrees (`shareTokens/{token}`, `shareSnapshots/{shareId}`)
 * and NEVER `matches/{uid}` (T-06-01). Redaction is enforced by response
 * SHAPE, not handler logic: `publicShareSnapshotSchema` is the Fastify
 * `response[200]` schema, so `fastify-type-provider-zod`'s serializer
 * strips/rejects any accidental `uid`/`matchId` leak at the framework level
 * (T-06-02).
 *
 * Unknown and revoked tokens return an IDENTICAL 404 body — there is no
 * oracle distinguishing "never existed" from "was revoked" (VIEW-05,
 * T-06-05); `getShareByToken` collapses both cases to `null`. The success
 * response carries `Cache-Control: no-store` so a revoke takes effect on the
 * very next request — Firebase Hosting's blanket `headers` block does not
 * apply to this Cloud-Run-rewritten route (RESEARCH.md Pitfall 6), so the
 * header must be set explicitly here.
 *
 * Rate-limited to 60 req/min per real client IP via the per-route
 * `config.rateLimit` override against the top-level `global: false`
 * `@fastify/rate-limit` registration in `app.ts` (TRUST-01, T-06-06).
 */
const publicVodSharesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.get(
    '/vod-shares/:token',
    {
      schema: {
        params: tokenParamsSchema,
        response: {
          200: publicShareSnapshotSchema,
          404: errorResponseSchema,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const snapshot = await rtdb.getShareByToken(request.params.token);
      if (!snapshot) {
        // Identical body for unknown AND revoked tokens — no oracle
        // distinguishing the two (VIEW-05 / T-06-05).
        return reply.code(404).send({
          error: 'Not Found',
          message: 'This share is no longer available',
          statusCode: 404,
        });
      }
      // Revocation must take effect immediately — never let any layer
      // (CDN, browser) serve a cached copy of a since-revoked share.
      reply.header('Cache-Control', 'no-store');
      return snapshot;
    },
  );
};

export default publicVodSharesRoutes;
