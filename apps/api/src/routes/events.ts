import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CANONICAL_SCHEMA_VERSION,
  errorResponseSchema,
  eventEnvelopeSchema,
  X_EVENT_ALLOWLIST,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { createEvent } from '../events/ledger.js';

const BEARER_PREFIX = 'Bearer ';

/** MEAS-04: reject any `occurredAt` more than 5 minutes from the server clock — bounds stale/replayed/clock-skewed X payloads. */
const X_EVENT_MAX_AGE_MS = 5 * 60 * 1000;

const ALLOWED_EVENT_NAMES: readonly string[] = X_EVENT_ALLOWLIST;

const postEventBodySchema = z.object({
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  occurredAt: z.number(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const eventAckSchema = z.object({ ok: z.literal(true) });

/**
 * MEAS-04/MEAS-09: `POST /api/events` is the durable, same-origin X-class
 * ingestion route that replaces ad-blocker-erasable direct-to-GA4 client
 * calls (`apps/web/src/lib/firebase.ts`'s `logProductEvent`, left
 * untouched — this is a NEW, sibling call path, not a migration).
 *
 * Deliberately PUBLIC (no `app.authenticate` anywhere in this file, same
 * posture as `publicVodShares.ts`/`gspLive.ts`): an anonymous visitor must
 * be able to fire `share_view_loaded` before ever signing in. Every control
 * lives server-side because the caller is untrusted:
 *
 * 1. `eventName` is checked against `X_EVENT_ALLOWLIST` and rejected with
 *    400 BEFORE any RTDB path is ever constructed from it (T-10-04-01/03) —
 *    an unknown name never reaches `createEvent()`.
 * 2. `occurredAt` must fall within `X_EVENT_MAX_AGE_MS` of the server clock
 *    — stale or replayed payloads are rejected (T-10-04-02).
 * 3. `receivedAt` is ALWAYS stamped from the server's own `Date.now()`; the
 *    client never sends it and nothing here ever reads one from the body.
 * 4. An OPTIONAL `Authorization: Bearer <idToken>` header is honored (never
 *    required) to correctly attribute a signed-in visitor's event as
 *    `actorKind: 'authenticated'` — an invalid/expired token on this
 *    anonymous-tolerant route falls back to anonymous rather than 401ing,
 *    since the whole point of this route is that auth is optional.
 * 5. Dedup rides `createEvent()`'s existing `eventDedup` transaction, keyed
 *    off `causationId` — this route sets `causationId = eventId` (the
 *    client-generated id), so a resent/duplicated POST with the same
 *    `(eventId, eventName)` is a no-op, never a second ledger row.
 *
 * Rate-limited to 60 req/min per real client IP via the per-route
 * `config.rateLimit` override against the top-level `global: false`
 * `@fastify/rate-limit` registration in `app.ts` (TRUST-01-style posture,
 * mirroring `publicVodShares.ts`).
 */
const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/events',
    {
      schema: {
        body: postEventBodySchema,
        response: {
          200: eventAckSchema,
          400: errorResponseSchema,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { eventId, eventName, occurredAt, payload } = request.body;

      // Allowlist check happens first — nothing derived from `eventName`
      // (an RTDB path, a dedup key) is ever constructed for a rejected name.
      if (!ALLOWED_EVENT_NAMES.includes(eventName)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Unknown eventName',
          statusCode: 400,
        });
      }

      const now = Date.now();
      if (Math.abs(now - occurredAt) > X_EVENT_MAX_AGE_MS) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'occurredAt is outside the allowed timestamp window',
          statusCode: 400,
        });
      }

      // Optional bearer attribution: never required, never rejects the
      // request on a bad/expired token — this route stays anonymous-first.
      let actorKind: 'anonymous' | 'authenticated' = 'anonymous';
      let actorId = eventId;
      const header = request.headers.authorization;
      if (header?.startsWith(BEARER_PREFIX)) {
        const idToken = header.slice(BEARER_PREFIX.length).trim();
        if (idToken) {
          try {
            const decoded = await app.firebase.auth.verifyIdToken(idToken);
            actorKind = 'authenticated';
            actorId = decoded.uid;
          } catch {
            // Invalid/expired bearer — fall back to anonymous attribution.
          }
        }
      }

      const envelope = eventEnvelopeSchema.parse({
        eventId,
        eventName,
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        occurredAt,
        receivedAt: now,
        actorKind,
        actorId,
        sessionId: eventId,
        source: 'web',
        causationId: eventId,
        consentState: 'unknown',
        payload: payload ?? {},
      });

      await createEvent(app.firebase.database, envelope);

      return { ok: true } as const;
    },
  );
};

export default eventsRoutes;
