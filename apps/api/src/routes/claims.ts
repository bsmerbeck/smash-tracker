import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  claimRedeemedResponseSchema,
  errorResponseSchema,
  redeemClaimRequestSchema,
} from '@smash-tracker/shared';
import type { ClaimCodeConfig } from '../config/env.js';
import { floorDelay, redeemClaimCode } from '../claims/redemption.js';
import { anonRateLimitKey } from '../http/clientIp.js';

export interface ClaimRoutesOptions {
  claimCode: ClaimCodeConfig | null;
}

/**
 * Phase 23 Plan 05 (Claim Credential & Atomic Ownership Transition, CRED-02/
 * CRED-05): the client-side claim-redemption route.
 *
 * The claim code arrives in a POST body and never in a URL, a query string,
 * or a path parameter, so it never reaches an access log, a referrer
 * header, or browser history (CRED-02).
 *
 * This route is deliberately absent from the foreign-client 403 test
 * harness (`apps/api/src/coaching/foreignClient.test.ts`) on purpose: a
 * client redeeming a code has, by definition, no membership record yet —
 * that harness proves membership-gated same-subject routes reject a
 * foreign coach, which has no meaning here.
 *
 * This file MUST contain exactly one real route. The delegation-revoke
 * route (plan 06) lives in its own file specifically so the source grep
 * that proves no globally-mapped error class (`NotFoundError`/
 * `ConflictError`/`ForbiddenError`) exists on the redemption path stays
 * valid permanently.
 */
const claimsRoutes: FastifyPluginAsyncZod<ClaimRoutesOptions> = async (app, options) => {
  const { claimCode } = options;

  if (!claimCode) {
    app.all('/claims/*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Claim codes are not configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  // Deliberately NOT membership-gated and does NOT use the subject-resolver
  // preHandler: a client redeeming a code has, by definition, no membership
  // record yet. That is the entire point of a claim flow.
  app.addHook('preHandler', app.authenticate);

  // Constructed once so a future edit can never accidentally diverge one
  // branch's body from another's — the byte-identical body is the CRED-05
  // contract.
  const INVALID_CLAIM_CODE_RESPONSE = Object.freeze({
    error: 'Bad Request',
    message: 'invalid_claim_code',
    statusCode: 400,
  });

  app.post(
    '/claims/redeem',
    {
      schema: {
        body: redeemClaimRequestSchema,
        response: {
          200: claimRedeemedResponseSchema,
          400: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const start = Date.now();
      const sessionIdHeader = request.headers['x-session-id'];
      const sessionId =
        (Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader) ?? 'unknown';
      // Reuses the existing non-spoofable rightmost-XFF extraction rather
      // than `request.ip`, which `trustProxy: true` makes client-spoofable.
      const clientIp = anonRateLimitKey(request);

      const result = await redeemClaimCode(
        app.firebase.database,
        {
          code: request.body.code,
          redeemerUid: request.uid,
          clientIp,
          sessionId,
          hmacSecret: claimCode.hmacSecret,
        },
        request.log,
      );

      if (result.status === 'rate_limited') {
        await floorDelay(start);
        return reply.code(429).send({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
          statusCode: 429,
        });
      }

      if (result.status === 'invalid') {
        await floorDelay(start);
        return reply.code(400).send(INVALID_CLAIM_CODE_RESPONSE);
      }

      await floorDelay(start);
      return reply.code(200).send({ tenantId: result.tenantId });
    },
  );
};

export default claimsRoutes;
