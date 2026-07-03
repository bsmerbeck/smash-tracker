import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { opponentListSchema } from '@smash-tracker/shared';
import { RtdbService } from '../services/rtdb.js';

const opponentsRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // GET /api/opponents
  app.get(
    '/opponents',
    {
      schema: {
        response: {
          200: opponentListSchema,
        },
      },
    },
    async (request) => {
      return rtdb.listOpponents(request.uid);
    },
  );
};

export default opponentsRoutes;
