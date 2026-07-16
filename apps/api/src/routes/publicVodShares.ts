import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

/**
 * Phase 5 (Share Foundation & Owner Controls): `GET /api/vod-shares/:token`
 * is deliberately PUBLIC — this is a REGISTRATION SEAM ONLY. Phase 5 ships
 * no anonymous-facing surface (per CONTEXT.md's phase boundary); the real
 * token->snapshot read lands in Phase 6. This route exists purely so:
 *
 *   1. `app.authBoundary.test.ts` has a real, concrete anonymous route to
 *      assert against (rather than an abstract "will exist later" claim).
 *   2. The share url shape (`${webBaseUrl}/s/{token}` -> API lookup) is
 *      locked in now, so Phase 6 only has to replace this handler's BODY,
 *      never its route registration or auth posture.
 *
 * Deliberately does NOT read `matches/{uid}` or `shareSnapshots/{shareId}`
 * — wiring up a real `getShareByToken` implementation here is explicitly
 * out of scope this phase (RESEARCH.md Open Question 2 / Anti-Patterns).
 * Same anonymous shape as `gspLive.ts` (no `app.authenticate` hook anywhere
 * in this file), mirrored here for the CI allowlist to compare against.
 */
const publicVodSharesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/vod-shares/:token',
    {
      schema: {
        params: tokenParamsSchema,
      },
    },
    async (_request, reply) => {
      return reply.code(501).send({
        error: 'Not Implemented',
        message: 'Public share viewing ships in a later phase',
        statusCode: 501,
      });
    },
  );
};

export default publicVodSharesRoutes;
