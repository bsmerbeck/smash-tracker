import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorResponseSchema, REVIEW_DELIVERY_STATES } from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { requireMembership } from '../coaching/tenants.js';
import {
  createReviewDelivery,
  listReviewDeliveries,
  revokeReviewDelivery,
} from '../coaching/reviewDeliveries.js';

const reviewIdParamsSchema = z.object({
  clientId: z.string().min(1),
  reviewId: z.string().min(1),
});
const deliveryIdParamsSchema = z.object({
  clientId: z.string().min(1),
  reviewId: z.string().min(1),
  deliveryId: z.string().min(1),
});

const createDeliveryBodySchema = z.object({
  /** The published version this delivery pins to (DLV-01: exactly ONE). */
  version: z.number().int().positive(),
  /** Optional custom expiry — absent means the link stays active until explicitly revoked. */
  expiresAt: z.number().int().positive().optional(),
});

const deliveryCreatedResponseSchema = z.object({
  deliveryId: z.string().min(1),
  token: z.string().min(1),
  url: z.string().url(),
});

const deliveryListItemResponseSchema = z.object({
  deliveryId: z.string().min(1),
  status: z.enum(REVIEW_DELIVERY_STATES),
  token: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  ackAt: z.number().int().nonnegative().nullable(),
  viewedAt: z.number().int().nonnegative().nullable(),
  url: z.string().url(),
});

export interface CoachingReviewDeliveriesRoutesOptions {
  /** SPA origin the delivery url is built against, e.g. `${webBaseUrl}/r/{token}` (env.WEB_BASE_URL). */
  webBaseUrl: string;
}

/** `X-Session-Id` header, mirroring `coachingReviews.ts`'s own identically-named helper (duplicated rather than imported — that file exports nothing this one needs beyond this small, self-contained convention). */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

/**
 * Phase 12 (Coach Reviews & Delivery, DLV-01/DLV-04): the coach-side
 * delivery-management routes, nested under
 * `/api/coaching/clients/:clientId/reviews/:reviewId/deliveries` — the SAME
 * direct `requireMembership` gating (URL `:clientId` param, no header) as
 * `coachingReviews.ts`'s sibling review routes, NOT the
 * `X-Active-Subject`/`app.resolveSubject` mechanism.
 */
const coachingReviewDeliveriesRoutes: FastifyPluginAsyncZod<
  CoachingReviewDeliveriesRoutesOptions
> = async (app, options) => {
  const { webBaseUrl } = options;

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request) => {
    const { clientId } = request.params as { clientId?: string };
    if (clientId) {
      await requireMembership(app.firebase.database, request.uid, clientId);
    }
  });

  // POST /api/coaching/clients/:clientId/reviews/:reviewId/deliveries —
  // mint a revocable delivery pinned to exactly one published version
  // (DLV-01). Fires review_delivery_created AFTER the durable write.
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/deliveries',
    {
      schema: {
        params: reviewIdParamsSchema,
        body: createDeliveryBodySchema,
        response: {
          201: deliveryCreatedResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createReviewDelivery(
        app.firebase.database,
        request.params.clientId,
        request.params.reviewId,
        request.body.version,
        webBaseUrl,
        { expiresAt: request.body.expiresAt },
      );

      void createEvent(
        app.firebase.database,
        buildDomainEnvelope({
          eventName: 'review_delivery_created',
          actorId: request.uid,
          sessionId: sessionIdFromHeader(request),
          causationId: `${request.params.reviewId}:${result.deliveryId}`,
          consentState: 'unknown',
        }),
      );

      return reply.code(201).send(result);
    },
  );

  // GET /api/coaching/clients/:clientId/reviews/:reviewId/deliveries —
  // every delivery ever created for this review, most-recent-first.
  app.get(
    '/coaching/clients/:clientId/reviews/:reviewId/deliveries',
    {
      schema: {
        params: reviewIdParamsSchema,
        response: { 200: z.array(deliveryListItemResponseSchema) },
      },
    },
    async (request) =>
      listReviewDeliveries(
        app.firebase.database,
        request.params.clientId,
        request.params.reviewId,
        webBaseUrl,
      ),
  );

  // POST .../deliveries/:deliveryId/revoke — soft-revokes a delivery
  // (mirrors vodShares.ts's dedicated revoke-action-route convention, never
  // a hard DELETE). Idempotent: fires review_delivery_revoked ONLY on a
  // genuine transition (D-11), never re-fired for an already-revoked id.
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/deliveries/:deliveryId/revoke',
    {
      schema: {
        params: deliveryIdParamsSchema,
        response: {
          204: z.undefined(),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { revoked } = await revokeReviewDelivery(
        app.firebase.database,
        request.params.clientId,
        request.params.reviewId,
        request.params.deliveryId,
      );

      if (revoked) {
        void createEvent(
          app.firebase.database,
          buildDomainEnvelope({
            eventName: 'review_delivery_revoked',
            actorId: request.uid,
            sessionId: sessionIdFromHeader(request),
            causationId: `${request.params.reviewId}:${request.params.deliveryId}`,
            consentState: 'unknown',
          }),
        );
      }

      return reply.code(204).send();
    },
  );
};

export default coachingReviewDeliveriesRoutes;
