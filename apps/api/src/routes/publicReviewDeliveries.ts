import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema, publicShareSnapshotSchema } from '@smash-tracker/shared';
import { z } from 'zod';
import { buildAnonymousDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { setDeliveryAck } from '../coaching/reviewDeliveries.js';
import { RtdbService } from '../services/rtdb.js';

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

/**
 * The ONE body every failure mode sends — unknown token, revoked, expired,
 * or a live token that simply isn't a coachReview delivery. Never render a
 * service error's message here (no-oracle belt and suspenders, mirroring
 * `coachNotes.ts`'s `UNAVAILABLE_404_BODY`).
 */
const UNAVAILABLE_404_BODY = {
  error: 'Not Found',
  message: 'This delivery is no longer available',
  statusCode: 404,
} as const;

const ackResponseSchema = z.object({ acknowledged: z.literal(true) });

/**
 * Phase 12 Plan 05 (DLV-02/DLV-03, D-09): the anonymous no-account
 * recipient surface for a coach review delivery — `GET
 * /api/review-deliveries/:token` resolves a live delivery to its pinned
 * published-version snapshot; `POST /api/review-deliveries/:token/ack`
 * records a LINK acknowledgement and fires `client_review_acknowledged`.
 *
 * Deliberately PUBLIC (no `app.authenticate` anywhere in this file — same
 * posture as `publicVodShares.ts`/`coachNotes.ts`): a delivery link's whole
 * purpose is to be openable without an account. Every response carries
 * `Cache-Control: no-store` (a revoke/expiry must bite on the very next
 * request, never a cached copy). Rate-limited per-route (60/min) against
 * the `global: false` `@fastify/rate-limit` registration in `app.ts`
 * (T-12-16), mirroring `publicVodShares.ts`.
 *
 * GET never sets `viewedAt`/derives 'Viewed' (T-12-14 / D-09 / Pitfall 4) —
 * that transition is owned exclusively by the client's post-render,
 * crawler-aware `client_review_view_loaded` X event (plan 08). A
 * crawler/unfurl fetch of this route must never produce a Viewed trust
 * signal.
 *
 * Both routes resolve EXCLUSIVELY through `RtdbService.getShareByToken`/
 * `resolveCoachReviewShareRef`, which only ever read `reviewVersions/`
 * (plus, for citation sources, `matches/{tenantId}/{sourceVodRef}.vodUrl`)
 * — never `reviewDrafts/` or any other subtree (T-12-13). Unknown, revoked,
 * and expired tokens — and a live token that resolves to a DIFFERENT share
 * kind — all collapse to the SAME unavailable body (T-12-15 no-oracle,
 * re-checked fresh on every call, never cached).
 */
const publicReviewDeliveriesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  // One hook, every response (200s and 404s alike): no-store, always.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // GET /api/review-deliveries/:token — the pinned published-version
  // snapshot (DLV-02).
  app.get(
    '/review-deliveries/:token',
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
      // A token that resolves fine but belongs to a different share kind
      // (e.g. a vod-review or recap token accidentally posted to this
      // endpoint) is treated identically to unknown/revoked — this route
      // only ever serves coachReview deliveries (T-12-15 no-oracle).
      if (!snapshot || snapshot.kind !== 'coachReview') {
        return reply.code(404).send(UNAVAILABLE_404_BODY);
      }
      return snapshot;
    },
  );

  // POST /api/review-deliveries/:token/ack — idempotent LINK
  // acknowledgement (D-09: `acknowledgedBy: 'link'` conceptually — this
  // route has no account to attribute to beyond the delivery itself).
  // Fires `client_review_acknowledged` ONLY on the genuine first-ack
  // transition (D-11), with an empty, content-free payload — no client
  // identity, no review content.
  app.post(
    '/review-deliveries/:token/ack',
    {
      schema: {
        params: tokenParamsSchema,
        response: {
          200: ackResponseSchema,
          404: errorResponseSchema,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const ref = await rtdb.resolveCoachReviewShareRef(request.params.token);
      if (!ref) {
        return reply.code(404).send(UNAVAILABLE_404_BODY);
      }

      const result = await setDeliveryAck(
        app.firebase.database,
        ref.tenantId,
        ref.reviewId,
        request.params.token,
      );
      if (!result) {
        // The token itself resolves to a live coachReview version, but no
        // delivery record actually carries it — collapse to the same
        // unavailable body rather than leak the distinction.
        return reply.code(404).send(UNAVAILABLE_404_BODY);
      }

      if (!result.alreadyAcked) {
        void createEvent(
          app.firebase.database,
          buildAnonymousDomainEnvelope({
            eventName: 'client_review_acknowledged',
            actorId: result.deliveryId,
            // No real client-side session concept on an anonymous,
            // no-account link — the deliveryId itself is the only
            // content-free identifier available (mirrors `events.ts`'s
            // `sessionId: eventId` fallback for the same reason).
            sessionId: result.deliveryId,
            causationId: `${ref.reviewId}:${result.deliveryId}`,
            consentState: 'unknown',
            payload: {},
          }),
        );
      }

      return reply.code(200).send({ acknowledged: true });
    },
  );
};

export default publicReviewDeliveriesRoutes;
