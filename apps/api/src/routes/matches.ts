import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createMatchInputSchema,
  errorResponseSchema,
  matchSchema,
  updateMatchInputSchema,
  vodTimestampEntrySchema,
  vodTimestampSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { ForbiddenError, RtdbService } from '../services/rtdb.js';

const matchIdParamsSchema = z.object({
  id: z.string().min(1),
});

const noteParamsSchema = z.object({
  id: z.string().min(1),
  noteId: z.string().min(1),
});

const matchesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // GET /api/matches
  app.get(
    '/matches',
    {
      schema: {
        response: {
          200: z.array(matchSchema),
        },
      },
    },
    async (request) => {
      return rtdb.listMatches(request.uid);
    },
  );

  // POST /api/matches
  app.post(
    '/matches',
    {
      schema: {
        body: createMatchInputSchema,
        response: {
          201: matchSchema,
        },
      },
    },
    async (request, reply) => {
      const match = await rtdb.createMatch(request.uid, request.body);
      return reply.code(201).send(match);
    },
  );

  // PATCH /api/matches/:id — NotFoundError from the service bubbles up to
  // the global error handler, which maps it to a 404.
  app.patch(
    '/matches/:id',
    {
      schema: {
        params: matchIdParamsSchema,
        body: updateMatchInputSchema,
        response: {
          200: matchSchema,
        },
      },
    },
    async (request) => {
      return rtdb.updateMatch(request.uid, request.params.id, request.body);
    },
  );

  // DELETE /api/matches/:id
  app.delete(
    '/matches/:id',
    {
      schema: {
        params: matchIdParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deleteMatch(request.uid, request.params.id);
      return reply.code(204).send();
    },
  );

  // POST /api/matches/:id/clear-vod — the one explicit "remove VOD" intent
  // (MatchTable's "Remove VOD link" action). Now that the PATCH above
  // preserves `vodTimestamps` whenever it's omitted (08-02), this is the
  // ONLY way to drop `vodUrl`/`vodStartSeconds`/`vodTimestamps` together —
  // RESEARCH Pitfall 2. A separate route (not a PATCH flag) keeps the
  // full-overwrite PATCH's "omit = preserve" contract simple and
  // unambiguous for every other caller.
  app.post(
    '/matches/:id/clear-vod',
    {
      schema: {
        params: matchIdParamsSchema,
        response: {
          200: matchSchema,
        },
      },
    },
    async (request) => {
      return rtdb.clearVodAndNotes(request.uid, request.params.id);
    },
  );

  // Phase 8 (Coaching Edit Sessions): owner note CRUD — these are the
  // ONLY write path for `vodTimestamps` now that the match-fact PATCH above
  // no longer accepts the field at all (08-01). All three are scoped to
  // `request.uid` (never a body/param uid) and ride this already-registered
  // `matchesRoutes` plugin (no new buildApp option, no app.ts change).
  // `body` is `vodTimestampSchema` directly — never hand-rolled — per
  // RESEARCH Pitfall 5.

  // POST /api/matches/:id/notes
  app.post(
    '/matches/:id/notes',
    {
      schema: {
        params: matchIdParamsSchema,
        body: vodTimestampSchema,
        response: {
          201: vodTimestampEntrySchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const note = await rtdb.createNote(request.uid, request.params.id, request.body);
        return reply.code(201).send(note);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        throw err; // NotFoundError bubbles to the global 404 handler
      }
    },
  );

  // PATCH /api/matches/:id/notes/:noteId
  app.patch(
    '/matches/:id/notes/:noteId',
    {
      schema: {
        params: noteParamsSchema,
        body: vodTimestampSchema,
        response: {
          200: vodTimestampEntrySchema,
        },
      },
    },
    async (request) => {
      return rtdb.updateNote(request.uid, request.params.id, request.params.noteId, request.body);
    },
  );

  // DELETE /api/matches/:id/notes/:noteId
  app.delete(
    '/matches/:id/notes/:noteId',
    {
      schema: {
        params: noteParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deleteNote(request.uid, request.params.id, request.params.noteId);
      return reply.code(204).send();
    },
  );
};

export default matchesRoutes;
