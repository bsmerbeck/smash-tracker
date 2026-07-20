import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  errorResponseSchema,
  scoutQuerySchema,
  scoutReportDataSchema,
} from '@smash-tracker/shared';
import type { ParryggConfig, StartggConfig } from '../config/env.js';
import { StartggApiError } from '../startgg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';
import { parseParryProfileUrl, ParryScoutCache, scoutParryPlayer } from '../parrygg/scout.js';
import type { ParryggClients } from '../parrygg/client.js';
import { resolveCombinedScout } from '../scout/combine.js';
import { emitScoutActivated } from '../onboarding/activation.js';

/** `X-Session-Id` header, mirroring `matches.ts`'s own identically-named helper — defaults to `'unknown'` when absent (never blocks the request). */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

export interface ScoutRoutesOptions {
  config: StartggConfig | null;
  /** Overridable fetch for the start.gg GraphQL calls (tests). */
  fetchImpl?: typeof fetch;
  /** parry.gg integration config (V9-B Feature 4); null/omitted means parry.gg queries answer 503 (start.gg queries are unaffected). */
  parryggConfig?: ParryggConfig | null;
  /** Overridable parry.gg gRPC-Web service clients (tests). */
  parryggClients?: ParryggClients;
}

/**
 * POST /api/scout — "opponent research before bracket": scout ANY player on
 * start.gg OR (V9-B Feature 4) parry.gg by profile URL, bare slug/tag, or
 * (start.gg only) numeric player id. Aggregates their PUBLIC match history
 * server-side (using our own API token/key — never a user token) into a
 * `ScoutReportData`. Signed-in users only (Bearer auth), same as the rest of
 * /api — scouting isn't itself sensitive, but it does spend shared rate-limit
 * budget, so it's gated behind sign-in like every other integration route.
 *
 * Source resolution: a pasted parry.gg profile URL ALWAYS wins (unambiguous
 * signal), overriding whatever `source` the client sent. Otherwise the
 * effective source is `request.body.source ?? 'startgg'` — back-compat with
 * every pre-V9-B client that never sent `source` at all. Each site's config
 * gates independently: a query resolved to parry.gg when `parryggConfig` is
 * absent answers 503 (parry.gg not configured) even if start.gg IS
 * configured, and vice versa — the two integrations are fully independent.
 *
 * Separate in-memory caches per source (`ScoutCache` for start.gg,
 * `ParryScoutCache` for parry.gg — see their respective scout.ts modules for
 * the caching rationale), both shared across requests to this plugin
 * instance.
 */
const scoutRoutes: FastifyPluginAsyncZod<ScoutRoutesOptions> = async (app, options) => {
  const { config, parryggConfig } = options;

  if (!config && !parryggConfig) {
    app.all('/scout', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'No scouting integration is configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new ScoutCache();
  const parryCache = new ParryScoutCache();

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
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rawQuery = request.body.query;
      // A pasted parry.gg profile URL is unambiguous and always overrides
      // the client's `source` (or its default) — see the module doc.
      const effectiveSource = parseParryProfileUrl(rawQuery)
        ? 'parrygg'
        : (request.body.source ?? 'startgg');

      // V13 combined scouting: a second lookup on the OTHER site merges into
      // one report. combineWith targeting the SAME site as the primary is
      // ignored (the UI never produces it) and falls through to the normal
      // single-source path below. Graceful per source-gating: an unconfigured
      // side is simply skipped inside the resolver, never a 503 here.
      const combineWith = request.body.combineWith;
      if (combineWith && combineWith.source !== effectiveSource) {
        const result = await resolveCombinedScout(
          [{ query: rawQuery, source: effectiveSource }, combineWith],
          {
            startggConfig: config,
            parryggConfig: parryggConfig ?? null,
            fetchImpl,
            parryggClients: options.parryggClients,
            scoutCache: cache,
            parryScoutCache: parryCache,
          },
        );
        if (!result.ok) {
          if (result.kind === 'rateLimited') {
            return reply.code(429).send({
              error: 'Too Many Requests',
              message: 'start.gg is rate-limiting requests right now — try again shortly',
              statusCode: 429,
            });
          }
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No player found for that query on either start.gg or parry.gg',
            statusCode: 404,
          });
        }
        void emitScoutActivated(app.firebase.database, request.uid, sessionIdFromHeader(request));
        return result.report;
      }

      if (effectiveSource === 'parrygg') {
        if (!parryggConfig) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'parry.gg integration is not configured on this server',
            statusCode: 503,
          });
        }
        const report = await scoutParryPlayer(
          parryggConfig.apiKey,
          rawQuery,
          parryCache,
          options.parryggClients,
        );
        if (!report) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No parry.gg player found for that query',
            statusCode: 404,
          });
        }
        void emitScoutActivated(app.firebase.database, request.uid, sessionIdFromHeader(request));
        return report;
      }

      if (!config) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'start.gg integration is not configured on this server',
          statusCode: 503,
        });
      }

      let input;
      try {
        input = parseScoutInput(rawQuery);
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
        void emitScoutActivated(app.firebase.database, request.uid, sessionIdFromHeader(request));
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
