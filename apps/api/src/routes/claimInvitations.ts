import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  claimInvitationStatusSchema,
  errorResponseSchema,
  issuedClaimInvitationSchema,
} from '@smash-tracker/shared';
import type { ClaimCodeConfig } from '../config/env.js';
import {
  ClaimIssuanceRateLimitError,
  getClaimInvitationStatus,
  issueClaimInvitation,
  revokeClaimInvitation,
} from '../claims/invitations.js';

export interface ClaimInvitationRoutesOptions {
  claimCode: ClaimCodeConfig | null;
}

const clientIdParamsSchema = z.object({ clientId: z.string().min(1) });

/**
 * /api/coaching/clients/:clientId/claim-invitations — Phase 23 (Claim
 * Credential & Atomic Ownership Transition, CRED-01/CRED-02/CRED-03): the
 * coach-side issue/rotate/revoke/status surface for a client workspace's
 * claim code.
 *
 * No route in this file ever accepts or returns a claim code in a URL, a
 * query string, or a path parameter — issuance returns the raw code in a
 * POST response body exactly once, and redemption (plan 05) accepts it in a
 * POST request body. That is a hard CRED-02 requirement, not a style
 * preference.
 *
 * All three routes use `request.uid` directly (never the
 * `X-Active-Subject` subject-resolver pair) — managing one's own client's
 * claim invitation is a coach action on a URL-param-identified tenant,
 * exactly like the archive/delete/export family in `coachingTenants.ts`.
 */
const claimInvitationsRoutes: FastifyPluginAsyncZod<ClaimInvitationRoutesOptions> = async (
  app,
  options,
) => {
  const { claimCode } = options;

  if (!claimCode) {
    app.all('/coaching/clients/:clientId/claim-invitations', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Claim codes are not configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  app.addHook('preHandler', app.authenticate);

  function readSessionId(headerValue: string | string[] | undefined): string {
    return (Array.isArray(headerValue) ? headerValue[0] : headerValue) ?? 'unknown';
  }

  // POST /api/coaching/clients/:clientId/claim-invitations — mint (or
  // rotate) a claim code for the tenant. 201 body is the ONLY place a raw
  // claim code is ever returned.
  app.post(
    '/coaching/clients/:clientId/claim-invitations',
    {
      schema: {
        params: clientIdParamsSchema,
        response: {
          201: issuedClaimInvitationSchema,
          403: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const sessionId = readSessionId(request.headers['x-session-id']);
        const issued = await issueClaimInvitation(
          app.firebase.database,
          request.uid,
          request.params.clientId,
          { sessionId, hmacSecret: claimCode.hmacSecret },
        );
        return reply.code(201).send(issued);
      } catch (err) {
        if (err instanceof ClaimIssuanceRateLimitError) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Claim code issuance limit reached for today',
            statusCode: 429,
          });
        }
        throw err;
      }
    },
  );

  // DELETE /api/coaching/clients/:clientId/claim-invitations — standalone
  // revoke; idempotent when nothing is outstanding.
  app.delete(
    '/coaching/clients/:clientId/claim-invitations',
    {
      schema: {
        params: clientIdParamsSchema,
        response: {
          204: z.undefined(),
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const sessionId = readSessionId(request.headers['x-session-id']);
      await revokeClaimInvitation(app.firebase.database, request.uid, request.params.clientId, {
        sessionId,
      });
      return reply.code(204).send();
    },
  );

  // GET /api/coaching/clients/:clientId/claim-invitations — outstanding
  // status only; never the digest.
  app.get(
    '/coaching/clients/:clientId/claim-invitations',
    {
      schema: {
        params: clientIdParamsSchema,
        response: {
          200: claimInvitationStatusSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      return getClaimInvitationStatus(app.firebase.database, request.uid, request.params.clientId);
    },
  );
};

export default claimInvitationsRoutes;
