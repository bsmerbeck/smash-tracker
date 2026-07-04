import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  errorResponseSchema,
  scoutQuerySchema,
  scoutReportDataSchema,
} from '@smash-tracker/shared';
import type { StartggConfig } from '../config/env.js';
import { StartggApiError } from '../startgg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';

export interface ScoutRoutesOptions {
  config: StartggConfig | null;
  /** Overridable fetch for the start.gg GraphQL calls (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * POST /api/scout — "opponent research before bracket": scout ANY start.gg
 * player (not just linked accounts) by profile URL, bare slug, or numeric
 * player id. Aggregates their PUBLIC recent SSBU set history server-side
 * (using our own API token — never a user token) into a `ScoutReportData`.
 * Signed-in users only (Bearer auth), same as the rest of /api — scouting
 * isn't itself sensitive, but it does spend shared start.gg rate-limit
 * budget, so it's gated behind sign-in like every other integration route.
 *
 * A single in-memory `ScoutCache` (see startgg/scout.ts) is shared across
 * requests to this plugin instance, so repeated scouts of the same player
 * during a bracket don't re-burn the rate limit.
 */
const scoutRoutes: FastifyPluginAsyncZod<ScoutRoutesOptions> = async (app, options) => {
  const { config } = options;

  if (!config) {
    app.all('/scout', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'start.gg integration is not configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new ScoutCache();

  app.post(
    '/scout',
    {
      preHandler: app.authenticate,
      schema: {
        body: scoutQuerySchema,
        response: {
          200: scoutReportDataSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      let input;
      try {
        input = parseScoutInput(request.body.query);
      } catch (err) {
        if (err instanceof ScoutInputError) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: err.message,
            statusCode: 400,
          });
        }
        throw err;
      }

      try {
        const report = await scoutPlayer(config.apiToken, input, fetchImpl, cache);
        if (!report) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No start.gg player found for that query',
            statusCode: 404,
          });
        }
        return report;
      } catch (err) {
        if (err instanceof StartggApiError && err.status === 429) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'start.gg is rate-limiting requests right now — try again shortly',
            statusCode: 429,
          });
        }
        request.log.error({ err }, 'start.gg scout lookup failed');
        throw err;
      }
    },
  );
};

export default scoutRoutes;
