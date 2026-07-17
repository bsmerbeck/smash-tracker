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
      // safeParse-and-skip (production-gap rule, mirrors RtdbService's
      // listMatches, review WR-03): one corrupt record must never 500 the
      // whole list — this tree now has TWO sync writers (start.gg +
      // parry.gg), and a single bad write would brick both the Trends table
      // and the recap entry point for that user. Skips log the child key +
      // failing field paths (never values, never uid) so corrupt data stays
      // discoverable in Cloud Run logs.
      const entries = Object.entries(raw).flatMap(([childKey, entry]) => {
        const parsed = tournamentEntrySchema.safeParse({
          ...(entry as object),
          entryKey: childKey,
        });
        if (!parsed.success) {
          request.log.warn(
            `tournaments: skipping corrupt entry ${childKey}: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
              .join('; ')}`,
          );
          return [];
        }
        return [parsed.data];
      });
      entries.sort((a, b) => b.lastSetAt - a.lastSetAt);
      return entries;
    },
  );
};

export default tournamentsRoutes;
