import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createMatchInputSchema, matchSchema, updateMatchInputSchema } from '@smash-tracker/shared';
import { z } from 'zod';
import { RtdbService } from '../services/rtdb.js';

const matchIdParamsSchema = z.object({
  id: z.string().min(1),
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
};

export default matchesRoutes;
