import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorResponseSchema } from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { requireMembership } from '../coaching/tenants.js';
import {
  createSessionDelivery,
  listSessionDeliveries,
  revokeSessionDelivery,
} from '../coaching/sessionDeliveries.js';

const sessionIdParamsSchema = z.object({
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
});
const deliveryIdParamsSchema = z.object({
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1),
});

const deliveryCreatedResponseSchema = z.object({
  deliveryId: z.string().min(1),
  token: z.string().min(1),
  url: z.string().url(),
});

const deliveryListItemResponseSchema = z.object({
  deliveryId: z.string().min(1),
  status: z.enum(['delivered', 'revoked']),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
  url: z.string().url(),
});

export interface CoachingSessionDeliveriesRoutesOptions {
  /** SPA origin the delivery url is built against, e.g. `${webBaseUrl}/r/{token}` (env.WEB_BASE_URL). */
  webBaseUrl: string;
}

/** `X-Session-Id` header, mirroring `coachingReviewDeliveries.ts`'s identically-named helper (duplicated rather than imported — that file exports nothing this one needs beyond this small, self-contained convention). */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

/**
 * Phase 20 Plan 03 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02, D-10 immutability): the coach-side session delivery-management
 * routes, nested under
 * `/api/coaching/clients/:clientId/sessions/:sessionId/deliveries` — the SAME
 * direct `requireMembership` gating (URL `:clientId` param, no header) as
 * `coachingReviewDeliveries.ts`'s sibling review-delivery routes.
 */
const coachingSessionDeliveriesRoutes: FastifyPluginAsyncZod<
  CoachingSessionDeliveriesRoutesOptions
> = async (app, options) => {
  const { webBaseUrl } = options;

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request) => {
    const { clientId } = request.params as { clientId?: string };
    if (clientId) {
      await requireMembership(app.firebase.database, request.uid, clientId);
    }
  });

  // POST /api/coaching/clients/:clientId/sessions/:sessionId/deliveries —
  // mint a revocable delivery embedding a FROZEN client-visible snapshot
  // (D-10). Fires session_delivery_created AFTER the durable write, with a
  // content-free payload (no summary/homework text — reference ids only).
  app.post(
    '/coaching/clients/:clientId/sessions/:sessionId/deliveries',
    {
      schema: {
        params: sessionIdParamsSchema,
        response: {
          201: deliveryCreatedResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createSessionDelivery(
        app.firebase.database,
        request.params.clientId,
        request.params.sessionId,
        webBaseUrl,
      );

      void createEvent(
        app.firebase.database,
        buildDomainEnvelope({
          eventName: 'session_delivery_created',
          actorId: request.uid,
          sessionId: sessionIdFromHeader(request),
          causationId: `${request.params.sessionId}:${result.deliveryId}`,
          consentState: 'unknown',
        }),
      );

      return reply.code(201).send(result);
    },
  );

  // GET /api/coaching/clients/:clientId/sessions/:sessionId/deliveries —
  // every delivery ever created for this session, most-recent-first.
  app.get(
    '/coaching/clients/:clientId/sessions/:sessionId/deliveries',
    {
      schema: {
        params: sessionIdParamsSchema,
        response: { 200: z.array(deliveryListItemResponseSchema) },
      },
    },
    async (request) =>
      listSessionDeliveries(
        app.firebase.database,
        request.params.clientId,
        request.params.sessionId,
        webBaseUrl,
      ),
  );

  // POST .../deliveries/:deliveryId/revoke — soft-revokes a delivery
  // (mirrors coachingReviewDeliveries.ts's dedicated revoke-action-route
  // convention). Idempotent: no event is fired here — revoke rides the
  // existing token lifecycle per the orchestrator's decision, not a
  // dedicated event.
  app.post(
    '/coaching/clients/:clientId/sessions/:sessionId/deliveries/:deliveryId/revoke',
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
      await revokeSessionDelivery(
        app.firebase.database,
        request.params.clientId,
        request.params.sessionId,
        request.params.deliveryId,
      );

      return reply.code(204).send();
    },
  );
};

export default coachingSessionDeliveriesRoutes;
