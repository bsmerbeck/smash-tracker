import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createPlaylistInputSchema,
  errorResponseSchema,
  playlistSchema,
  updatePlaylistInputSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { ForbiddenError, RtdbService } from '../services/rtdb.js';

const playlistIdParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * VOD Manager overhaul: `playlists/{uid}` — user-curated ordered collections
 * of match ids (see packages/shared/src/playlist.ts for the data-model
 * rationale). CRUD mirrors the gsp-readings routes: push-keyed records,
 * server-stamped `createdAt`, NotFoundError from the service bubbling to the
 * global 404 handler. POST additionally maps `ForbiddenError` (the
 * 50-playlist cap) to 403 locally — the global handler doesn't know about it
 * (mirrors `routes/groups.ts`'s ForbiddenError mapping).
 *
 * Every read/write is scoped to `request.subjectId` (Phase 11: the resolved
 * subject, derived from the verified `request.uid` plus an optional
 * coaching-mode header via the resolver preHandler below — personal mode is
 * `subjectId === uid`, unchanged behavior) — never a uid from
 * body/params/query (see the plan's threat model T-04-01).
 */
const playlistsRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveSubject);

  // GET /api/playlists
  app.get(
    '/playlists',
    {
      schema: {
        response: {
          200: z.array(playlistSchema),
        },
      },
    },
    async (request) => {
      return rtdb.listPlaylists(request.subjectId);
    },
  );

  // POST /api/playlists
  app.post(
    '/playlists',
    {
      schema: {
        body: createPlaylistInputSchema,
        response: {
          201: playlistSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const playlist = await rtdb.createPlaylist(request.subjectId, request.body);
        return reply.code(201).send(playlist);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        throw err;
      }
    },
  );

  // PATCH /api/playlists/:id
  app.patch(
    '/playlists/:id',
    {
      schema: {
        params: playlistIdParamsSchema,
        body: updatePlaylistInputSchema,
        response: {
          200: playlistSchema,
        },
      },
    },
    async (request) => {
      return rtdb.updatePlaylist(request.subjectId, request.params.id, request.body);
    },
  );

  // DELETE /api/playlists/:id
  app.delete(
    '/playlists/:id',
    {
      schema: {
        params: playlistIdParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deletePlaylist(request.subjectId, request.params.id);
      return reply.code(204).send();
    },
  );
};

export default playlistsRoutes;
