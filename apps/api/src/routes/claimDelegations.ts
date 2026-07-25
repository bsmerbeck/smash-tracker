import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '@smash-tracker/shared';
import { revokeCoachDelegation } from '../claims/delegation.js';

const paramsSchema = z.object({
  tenantId: z.string().min(1),
  delegateUid: z.string().min(1),
});

/**
 * /api/client-workspaces/:tenantId/delegations/:delegateUid — Phase 23
 * (Claim Credential & Atomic Ownership Transition, CTRL-02): the
 * client-owner-facing revoke surface. The `/client-workspaces` prefix is
 * deliberately not under `/coaching`, which is the coach's own namespace —
 * this route is called by the CLIENT who now owns the tenant.
 *
 * Registered unconditionally, with no config-null 503 gate: revoking a
 * delegation involves no claim code and therefore no HMAC secret.
 *
 * This route lives in its own file rather than in `apps/api/src/routes/claims.ts`
 * because that file is under a permanent source-grep prohibition against any
 * error class the global handler maps to a distinguishing status code, which
 * this route legitimately needs (a membership denial must surface as a 403).
 */
const claimDelegationsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // DELETE /api/client-workspaces/:tenantId/delegations/:delegateUid
  app.delete(
    '/client-workspaces/:tenantId/delegations/:delegateUid',
    {
      schema: {
        params: paramsSchema,
        response: {
          204: z.undefined(),
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const sessionIdHeader = request.headers['x-session-id'];
      const sessionId =
        (Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader) ?? 'unknown';
      // Let a membership denial (`ForbiddenError`) propagate to the global
      // error handler, which already maps it to 403 — no local try/catch
      // needed here.
      await revokeCoachDelegation(
        app.firebase.database,
        request.uid,
        request.params.tenantId,
        request.params.delegateUid,
        { sessionId },
      );
      return reply.code(204).send();
    },
  );
};

export default claimDelegationsRoutes;
