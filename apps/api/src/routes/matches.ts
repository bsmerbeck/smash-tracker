import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  createMatchInputSchema,
  errorResponseSchema,
  matchSchema,
  updateMatchInputSchema,
  vodTimestampEntrySchema,
  vodTimestampSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { ForbiddenError, RtdbService } from '../services/rtdb.js';

const matchIdParamsSchema = z.object({
  id: z.string().min(1),
});

const noteParamsSchema = z.object({
  id: z.string().min(1),
  noteId: z.string().min(1),
});

/** `X-Session-Id` header, mirroring `coachingReviews.ts`'s own identically-named helper — defaults to `'unknown'` when absent (never blocks the request). */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

const matchesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveSubject);

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
      return rtdb.listMatches(request.subjectId);
    },
  );

  // POST /api/matches — the create-path half of the Phase 11 carry-over
  // (D-11): `client_vod_attached` fires when a COACH creates a match
  // directly into a client's library (`isClientLibrary`) with a `vodUrl`
  // already attached. Never for a personal match (`subjectId === uid`) —
  // every write here is a "first attach" by definition, since a brand-new
  // match has no prior state to diff against.
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
      const match = await rtdb.createMatch(request.subjectId, request.body);
      const isClientLibrary = request.subjectId !== request.uid;
      if (isClientLibrary && request.body.vodUrl !== undefined) {
        void createEvent(
          app.firebase.database,
          buildDomainEnvelope({
            eventName: 'client_vod_attached',
            actorId: request.uid,
            sessionId: sessionIdFromHeader(request),
            causationId: match.id,
            consentState: 'unknown',
          }),
        );
      }
      return reply.code(201).send(match);
    },
  );

  // PATCH /api/matches/:id — NotFoundError from the service bubbles up to
  // the global error handler, which maps it to a 404. The update-path half
  // of the Phase 11 carry-over (D-11): `client_vod_attached` fires ONLY on
  // the genuine FIRST vodUrl write to a client-library match
  // (`vodFirstAttached`, computed by `updateMatch` from its own
  // already-fetched current/input pair — never a second read here). A
  // second edit that merely changes/keeps an existing `vodUrl`, or any edit
  // to a personal match, never fires it.
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
      const { vodFirstAttached, ...match } = await rtdb.updateMatch(
        request.subjectId,
        request.params.id,
        request.body,
      );
      const isClientLibrary = request.subjectId !== request.uid;
      if (isClientLibrary && vodFirstAttached) {
        void createEvent(
          app.firebase.database,
          buildDomainEnvelope({
            eventName: 'client_vod_attached',
            actorId: request.uid,
            sessionId: sessionIdFromHeader(request),
            causationId: match.id,
            consentState: 'unknown',
          }),
        );
      }
      return match;
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
      await rtdb.deleteMatch(request.subjectId, request.params.id);
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
      return rtdb.clearVodAndNotes(request.subjectId, request.params.id);
    },
  );

  // Phase 8 (Coaching Edit Sessions): owner note CRUD — these are the
  // ONLY write path for `vodTimestamps` now that the match-fact PATCH above
  // no longer accepts the field at all (08-01). All three are scoped to the
  // resolved subject (Phase 11: `request.subjectId`, never a body/param id)
  // and ride this already-registered `matchesRoutes` plugin (no new
  // buildApp option, no app.ts change). `body` is `vodTimestampSchema`
  // directly — never hand-rolled — per RESEARCH Pitfall 5.

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
        const note = await rtdb.createNote(request.subjectId, request.params.id, request.body);
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
      return rtdb.updateNote(
        request.subjectId,
        request.params.id,
        request.params.noteId,
        request.body,
      );
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
      await rtdb.deleteNote(request.subjectId, request.params.id, request.params.noteId);
      return reply.code(204).send();
    },
  );
};

export default matchesRoutes;
