import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  opponentNameInputSchema,
  opponentNoteMapSchema,
  opponentNoteSchema,
  upsertOpponentNoteInputSchema,
} from '@smash-tracker/shared';
import { RtdbService } from '../services/rtdb.js';

const noteParamsSchema = z.object({
  name: opponentNameInputSchema,
});

/**
 * V6-W1c: opponent tendency notes. `opponentNotes/{uid}/{canonicalName}` is a
 * flat map keyed by the SAME canonical opponent name used everywhere else
 * (validated through `opponentNameInputSchema`, the same normalizer
 * `opponentAliases` uses) — the web app is responsible for resolving an
 * alias to its canonical name (via `useFilteredMatches`) before reading or
 * writing a note, so notes always attach to the merged identity rather than
 * a name that might later become an alias.
 */
const opponentNotesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveSubject);

  // GET /api/opponent-notes
  app.get(
    '/opponent-notes',
    {
      schema: {
        response: {
          200: opponentNoteMapSchema,
        },
      },
    },
    async (request) => {
      return rtdb.listOpponentNotes(request.subjectId);
    },
  );

  // PUT /api/opponent-notes/:name
  app.put(
    '/opponent-notes/:name',
    {
      schema: {
        params: noteParamsSchema,
        body: upsertOpponentNoteInputSchema,
        response: {
          200: opponentNoteSchema,
        },
      },
    },
    async (request) => {
      return rtdb.setOpponentNote(request.subjectId, request.params.name, request.body);
    },
  );

  // DELETE /api/opponent-notes/:name — NotFoundError from the service bubbles
  // up to the global error handler, which maps it to a 404.
  app.delete(
    '/opponent-notes/:name',
    {
      schema: {
        params: noteParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deleteOpponentNote(request.subjectId, request.params.name);
      return reply.code(204).send();
    },
  );
};

export default opponentNotesRoutes;
