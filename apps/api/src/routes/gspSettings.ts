import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { gspSettingsSchema, upsertGspSettingsInputSchema } from '@smash-tracker/shared';
import { RtdbService } from '../services/rtdb.js';

/**
 * V10: `gspSettings/{uid}` — a single per-user setting, the Elite Smash entry
 * threshold the player is tracking their fighter's GSP against. There is no
 * public Elite Smash API (elitegsp.com estimates it from crowd-sourced
 * submissions and we intentionally don't scrape it), so this is entirely
 * user-maintained.
 *
 * GET returns a synthesized default (see `RtdbService.getGspSettings`) rather
 * than 404ing when the user hasn't saved anything yet — simpler for the web
 * hook than branching on response status, and the placeholder default is
 * clearly labeled as such in the UI.
 */
const gspSettingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // GET /api/gsp-settings
  app.get(
    '/gsp-settings',
    {
      schema: {
        response: {
          200: gspSettingsSchema,
        },
      },
    },
    async (request) => {
      return rtdb.getGspSettings(request.uid);
    },
  );

  // PUT /api/gsp-settings
  app.put(
    '/gsp-settings',
    {
      schema: {
        body: upsertGspSettingsInputSchema,
        response: {
          200: gspSettingsSchema,
        },
      },
    },
    async (request) => {
      return rtdb.setGspSettings(request.uid, request.body);
    },
  );
};

export default gspSettingsRoutes;
