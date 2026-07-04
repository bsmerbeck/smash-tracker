import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { tournamentEntryListSchema, tournamentEntrySchema } from '@smash-tracker/shared';

/**
 * GET /api/tournaments — the signed-in user's start.gg tournament registry,
 * accumulated server-side during sync (see startgg/sync.ts's
 * `accumulateRegistry`). Read-only: entries are written exclusively by the
 * sync service under tournamentEntries/{uid}/{eventId}.
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
      const entries = Object.values(raw).map((entry) => tournamentEntrySchema.parse(entry));
      entries.sort((a, b) => b.lastSetAt - a.lastSetAt);
      return entries;
    },
  );
};

export default tournamentsRoutes;
