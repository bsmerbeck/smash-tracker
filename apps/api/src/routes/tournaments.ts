import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { tournamentEntryListSchema, tournamentEntrySchema } from '@smash-tracker/shared';

/**
 * GET /api/tournaments — the signed-in user's tournament registry, serving
 * BOTH start.gg (accumulated by startgg/sync.ts's `accumulateRegistry`) and
 * parry.gg (accumulated by parrygg/sync.ts's `accumulateParryggRegistry`)
 * entries, each keyed by `entryKey`. Read-only: entries are written
 * exclusively by the two sync services under
 * tournamentEntries/{uid}/{entryKey}.
 */
const tournamentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/tournaments',
    {
      schema: {
        response: {
          200: tournamentEntryListSchema,
        },
      },
    },
    async (request) => {
      const snapshot = await app.firebase.database.ref(`tournamentEntries/${request.uid}`).get();
      if (!snapshot.exists()) {
        return [];
      }
      const raw = snapshot.val() as Record<string, unknown>;
      // Always stamp entryKey from the RTDB child key — legacy start.gg
      // records (child key = String(eventId)) get a routable entryKey with
      // zero data migration; parry.gg entries carry their own sanitized key.
      const entries = Object.entries(raw).map(([childKey, entry]) =>
        tournamentEntrySchema.parse({ ...(entry as object), entryKey: childKey }),
      );
      entries.sort((a, b) => b.lastSetAt - a.lastSetAt);
      return entries;
    },
  );
};

export default tournamentsRoutes;
