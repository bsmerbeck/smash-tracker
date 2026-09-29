import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  watchlistItemKeySchema,
  watchlistResponseSchema,
  watchlistTrackInputSchema,
  watchlistTrackResponseSchema,
} from '@smash-tracker/shared';
import { RtdbService, WatchlistFullError } from '../services/rtdb.js';

/**
 * `watchlist/{subjectId}` — the opponents, matchups and stages a player (or a
 * coach acting for a managed client, via `X-Active-Subject`) tracks so they
 * return in the digest on any device (Phase 39.2, TRK-02).
 *
 * Per-item routes only — there is deliberately NO whole-list replace, so no
 * write is ever built from a list that has not been loaded (production-gap
 * #8). The storage key is derived server-side from the validated body; a
 * client-supplied key or timestamp is never trusted. Every handler addresses
 * storage ONLY through `request.subjectId`, which `app.resolveSubject` sets
 * after checking `clientMembers/{tenant}/{uid}` on this very request, so a
 * revoked delegate is refused immediately and a client's list never mixes with
 * the coach's own.
 *
 * No telemetry and no `createEvent` call: tracking is not an event-ledger
 * transition.
 */
const watchlistRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveSubject);

  // GET /api/watchlist
  app.get(
    '/watchlist',
    {
      schema: {
        response: {
          200: watchlistResponseSchema,
        },
      },
    },
    async (request) => {
      return rtdb.getWatchlist(request.subjectId);
    },
  );

  // PUT /api/watchlist/items — idempotent track of ONE item (25-item cap)
  app.put(
    '/watchlist/items',
    {
      schema: {
        body: watchlistTrackInputSchema,
        response: {
          200: watchlistTrackResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await rtdb.trackWatchlistItem(request.subjectId, request.body);
      } catch (error) {
        if (error instanceof WatchlistFullError) {
          // The global ConflictError mapping carries no machine code; the web
          // toast keys off `code`, never the message text.
          return reply.code(409).send({
            error: 'Conflict',
            message: error.message,
            statusCode: 409,
            code: error.code,
          });
        }
        throw error;
      }
    },
  );

  // DELETE /api/watchlist/items/:itemKey
  app.delete(
    '/watchlist/items/:itemKey',
    {
      schema: {
        params: z.object({ itemKey: watchlistItemKeySchema }),
        response: {
          200: z.object({ itemKey: watchlistItemKeySchema }),
        },
      },
    },
    async (request) => {
      return rtdb.untrackWatchlistItem(request.subjectId, request.params.itemKey);
    },
  );
};

export default watchlistRoutes;
