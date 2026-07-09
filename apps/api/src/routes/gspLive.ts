import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema, gspLiveSchema } from '@smash-tracker/shared';
import { GspLiveService } from '../gspLive/service.js';

export interface GspLiveRoutesOptions {
  /** Overridable fetch for the gsptiers.com call (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * V17.1: GET /api/gsp-live — the cached live elite/max GSP thresholds (see
 * gspLive/service.ts for the lazy-refresh mechanics). Deliberately PUBLIC:
 * it exposes zero user data (two community-tracked numbers), and keeping it
 * auth-free lets the public /gsp-calculator page adopt it later. 404 only
 * when there has never been a successful upstream fetch and upstream is
 * currently failing — clients fall back to the model's static anchor.
 */
const gspLiveRoutes: FastifyPluginAsyncZod<GspLiveRoutesOptions> = async (app, options) => {
  const service = new GspLiveService(app.firebase.database, options.fetchImpl ?? fetch);

  app.get(
    '/gsp-live',
    {
      schema: {
        response: {
          200: gspLiveSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const live = await service.get(request.log);
      if (!live) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'No live GSP thresholds available yet',
          statusCode: 404,
        });
      }
      return live;
    },
  );
};

export default gspLiveRoutes;
