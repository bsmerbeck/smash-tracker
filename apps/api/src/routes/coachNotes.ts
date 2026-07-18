import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  coachAttributionSchema,
  errorResponseSchema,
  publicShareSnapshotSchema,
  vodTimestampEntrySchema,
  vodTimestampSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, RtdbService } from '../services/rtdb.js';

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

const noteParamsSchema = z.object({
  token: z.string().min(1),
  noteId: z.string().min(1),
});

/**
 * Coach-write bodies derive EVERY note-field validator from the shared
 * `vodTimestampSchema`/`coachAttributionSchema` (never hand-rolled numbers —
 * RESEARCH Pitfall 5): the 200-char note / 5-tag / 60-char-displayName /
 * uuid-sessionId caps live in exactly one place.
 */
const createCoachNoteBodySchema = vodTimestampSchema.extend(coachAttributionSchema.shape);

const patchCoachNoteBodySchema = vodTimestampSchema.partial().extend({
  sessionId: coachAttributionSchema.shape.sessionId,
});

/** DELETE carries `sessionId` as a QUERY param (no DELETE body — resolved research directive). */
const deleteCoachNoteQuerySchema = z.object({
  sessionId: coachAttributionSchema.shape.sessionId,
});

/**
 * The session READ's optional `sessionId` query param (review WR-02): the
 * caller's own claimed session, used ONLY to compute each note's `own` flag
 * server-side — stored sessionIds are never serialized into the response.
 * Optional (a plain view of an edit link works without it); zod-bounded to
 * the uuid shape so junk never reaches the service layer.
 */
const sessionQuerySchema = z.object({
  sessionId: coachAttributionSchema.shape.sessionId.optional(),
});

/**
 * The ONE 404 body every failure mode sends — unknown token, revoked,
 * expired, wrong tier, missing note, "note isn't yours". Never render a
 * service error's message here (no-oracle belt and suspenders, T-08-13).
 */
const UNAVAILABLE_404_BODY = {
  error: 'Not Found',
  message: 'This share is no longer available',
  statusCode: 404,
} as const;

/**
 * Phase 8 Plan 3 (Coaching Edit Sessions): the anonymous coach surface —
 * the ONE deliberate write exception to "anonymous requests never touch
 * `matches/{uid}`". Same posture as `publicVodShares.ts`: deliberately NO
 * authenticate preHandler anywhere in this file (the bearer edit-token in
 * the path IS the credential), every response carries `Cache-Control: no-store`
 * (a revoke/expiry must bite on the very next request — never a cached
 * copy), and every failure mode — unknown token, revoked, EXPIRED, wrong
 * tier, missing note, and "note isn't yours" — returns ONE identical 404
 * body (T-08-13's no-oracle rule; RESEARCH A3 extends it to ownership).
 *
 * `RtdbService` re-resolves the token (revokedAt AND expiresAt re-checked
 * against RTDB) on EVERY call — nothing here caches a token lookup
 * (T-08-12). The owner uid / match id are resolved server-side from the
 * stored token record; no caller-supplied identifier ever reaches an RTDB
 * path (T-08-08).
 *
 * Rate limits are registered in app.ts's nested coach scope (per-token
 * 20/min + per-IP floor), NOT per-route here — see the registration block.
 */
const coachNotesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  // One hook, every response (200s, 404s, 429s alike): no-store, always.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // GET /api/vod-shares/:token/session — the LIVE edit-session view
  // (COACH-03): the frozen-snapshot read stays on GET /api/vod-shares/:token.
  app.get(
    '/vod-shares/:token/session',
    {
      schema: {
        params: tokenParamsSchema,
        querystring: sessionQuerySchema,
        response: {
          200: publicShareSnapshotSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const session = await rtdb.getEditSessionByToken(
        request.params.token,
        request.query.sessionId,
      );
      if (!session) {
        return reply.code(404).send(UNAVAILABLE_404_BODY);
      }
      return session;
    },
  );

  // POST /api/vod-shares/:token/notes (COACH-02)
  app.post(
    '/vod-shares/:token/notes',
    {
      schema: {
        params: tokenParamsSchema,
        body: createCoachNoteBodySchema,
        response: {
          201: vodTimestampEntrySchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { sessionId, displayName, ...noteInput } = request.body;
      try {
        const note = await rtdb.createCoachNote(
          request.params.token,
          sessionId,
          displayName,
          noteInput,
        );
        return reply.code(201).send(note);
      } catch (err) {
        if (err instanceof NotFoundError) {
          // Collapse EVERY not-found flavor to the one canonical body —
          // never render err.message (no-oracle belt and suspenders).
          return reply.code(404).send(UNAVAILABLE_404_BODY);
        }
        if (err instanceof ForbiddenError) {
          // Cap rejection: a valid-token holder gets a real 403 — but with
          // a STATIC message, never `err.message` (review WR-01): the
          // service's cap message interpolates the owner's private matchId
          // (an RTDB push key, creation-time-encoded) — the one identifier
          // the anonymous surface must never serve.
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'This review already has the maximum number of notes',
            statusCode: 403,
          });
        }
        throw err;
      }
    },
  );

  // PATCH /api/vod-shares/:token/notes/:noteId (COACH-02/04) — partial
  // body; absent fields preserve the stored values. Ownership is enforced
  // server-side inside the RtdbService transaction, never trusted from the
  // client's sessionId claim alone beyond scoping to that session's notes.
  app.patch(
    '/vod-shares/:token/notes/:noteId',
    {
      schema: {
        params: noteParamsSchema,
        body: patchCoachNoteBodySchema,
        response: {
          200: vodTimestampEntrySchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { sessionId, ...noteInput } = request.body;
      try {
        return await rtdb.updateCoachNote(
          request.params.token,
          sessionId,
          request.params.noteId,
          noteInput,
        );
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.code(404).send(UNAVAILABLE_404_BODY);
        }
        throw err;
      }
    },
  );

  // DELETE /api/vod-shares/:token/notes/:noteId?sessionId=... (COACH-02/04)
  app.delete(
    '/vod-shares/:token/notes/:noteId',
    {
      schema: {
        params: noteParamsSchema,
        querystring: deleteCoachNoteQuerySchema,
        response: {
          204: z.undefined(),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await rtdb.deleteCoachNote(
          request.params.token,
          request.query.sessionId,
          request.params.noteId,
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.code(404).send(UNAVAILABLE_404_BODY);
        }
        throw err;
      }
    },
  );
};

export default coachNotesRoutes;
