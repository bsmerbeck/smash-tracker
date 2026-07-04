import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  opponentAliasMapSchema,
  opponentNameInputSchema,
  upsertOpponentAliasInputSchema,
} from '@smash-tracker/shared';
import { RtdbService, ValidationError } from '../services/rtdb.js';

const aliasParamsSchema = z.object({
  alias: opponentNameInputSchema,
});

/**
 * V5 Phase C: opponent identity. `opponentAliases/{uid}` is a flat map from
 * an alias opponent name to the canonical name it should display/aggregate
 * as (see packages/shared/src/opponent.ts for the full write-time
 * resolution + cycle-rejection rules). Web's `useFilteredMatches` is the
 * single choke point that applies this map to rewrite `match.opponent`
 * before any downstream consumer (scouting, tables, dashboards) sees it.
 */
const opponentAliasesRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // GET /api/opponents/aliases
  app.get(
    '/opponents/aliases',
    {
      schema: {
        response: {
          200: opponentAliasMapSchema,
        },
      },
    },
    async (request) => {
      return rtdb.listOpponentAliases(request.uid);
    },
  );

  // PUT /api/opponents/aliases/:alias
  app.put(
    '/opponents/aliases/:alias',
    {
      schema: {
        params: aliasParamsSchema,
        body: upsertOpponentAliasInputSchema,
        response: {
          200: opponentAliasMapSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await rtdb.setOpponentAlias(
          request.uid,
          request.params.alias,
          request.body.canonical,
        );
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: err.message,
            statusCode: 400,
          });
        }
        throw err;
      }
    },
  );

  // DELETE /api/opponents/aliases/:alias — NotFoundError from the service
  // bubbles up to the global error handler, which maps it to a 404.
  app.delete(
    '/opponents/aliases/:alias',
    {
      schema: {
        params: aliasParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deleteOpponentAlias(request.uid, request.params.alias);
      return reply.code(204).send();
    },
  );
};

export default opponentAliasesRoutes;
