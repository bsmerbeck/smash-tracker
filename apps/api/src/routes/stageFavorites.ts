import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { stageFavoritesSchema, upsertStageFavoritesInputSchema } from '@smash-tracker/shared';
import { RtdbService } from '../services/rtdb.js';

/**
 * `stageFavorites/{uid}` — the user's favorited stages, pinned to the top of
 * every stage picker (match forms, set wizard, stage breakdown filter) so
 * frequent stages don't have to be scrolled to on every match log.
 *
 * GET returns a synthesized empty default rather than 404ing when the user
 * hasn't favorited anything yet — same convention as gsp-settings. PUT
 * replaces the whole list (favorites are a small ordered set, not an
 * append-only log).
 */
const stageFavoritesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // GET /api/stage-favorites
  app.get(
    '/stage-favorites',
    {
      schema: {
        response: {
          200: stageFavoritesSchema,
        },
      },
    },
    async (request) => {
      return rtdb.getStageFavorites(request.uid);
    },
  );

  // PUT /api/stage-favorites
  app.put(
    '/stage-favorites',
    {
      schema: {
        body: upsertStageFavoritesInputSchema,
        response: {
          200: stageFavoritesSchema,
        },
      },
    },
    async (request) => {
      return rtdb.setStageFavorites(request.uid, request.body);
    },
  );
};

export default stageFavoritesRoutes;
