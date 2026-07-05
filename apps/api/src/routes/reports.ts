import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  generateReportRequestSchema,
  reportsConfigSchema,
  scoutReportRecordSchema,
} from '@smash-tracker/shared';
import type { ReportsConfig, StartggConfig } from '../config/env.js';
import { StartggApiError } from '../startgg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';
import {
  assembleReportPayload,
  Anthropic,
  generateScoutReport,
  ReportGenerationError,
  type AnthropicLikeClient,
} from '../reports/generate.js';

export interface ReportsRoutesOptions {
  config: ReportsConfig | null;
  startggConfig: StartggConfig | null;
  /** Overridable Anthropic client (tests) — a real client is built when omitted. */
  client?: AnthropicLikeClient;
  /** Overridable fetch for the start.gg GraphQL calls (tests). */
  fetchImpl?: typeof fetch;
}

const reportIdParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * /api/reports — AI-generated pre-bracket scouting reports (V7-B), layered on
 * top of the V7-A scout data layer. Requires BOTH `config` (Claude API key +
 * a non-empty uid allowlist) and `startggConfig` (the scout layer's own
 * config) to be present; either missing means every route here answers 503,
 * same shape scout.ts uses for its own dependency.
 *
 * Access is allowlist-gated on top of ordinary sign-in (`REPORTS_ALLOWED_UIDS`)
 * because report generation spends real Claude API tokens per request — this
 * is a paid feature, not a general one. `/reports/config` never 403s (it's
 * how the web app decides whether to show the "Generate AI report" button at
 * all); every other route 403s for a signed-in-but-not-allowlisted uid.
 */
const reportsRoutes: FastifyPluginAsyncZod<ReportsRoutesOptions> = async (app, options) => {
  const { config, startggConfig } = options;

  if (!config || !startggConfig) {
    app.all('/reports*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'AI reports are not enabled on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const scoutCache = new ScoutCache();
  const client: AnthropicLikeClient =
    options.client ?? new Anthropic({ apiKey: config.anthropicApiKey });

  app.addHook('preHandler', app.authenticate);

  // GET /api/reports/config — never 403s; tells the web app whether to show
  // the "Generate AI report" button for the signed-in user.
  app.get(
    '/reports/config',
    {
      schema: {
        response: {
          200: reportsConfigSchema,
        },
      },
    },
    async (request) => {
      return { enabled: config.allowedUids.has(request.uid) };
    },
  );

  // POST /api/reports
  app.post(
    '/reports',
    {
      schema: {
        body: generateReportRequestSchema,
        response: {
          200: scoutReportRecordSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!config.allowedUids.has(request.uid)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'AI reports are not enabled for this account',
          statusCode: 403,
        });
      }

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

      let scout;
      try {
        scout = await scoutPlayer(startggConfig.apiToken, input, fetchImpl, scoutCache);
      } catch (err) {
        if (err instanceof StartggApiError && err.status === 429) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'start.gg is rate-limiting requests right now — try again shortly',
            statusCode: 429,
          });
        }
        request.log.error({ err }, 'start.gg scout lookup failed during report generation');
        throw err;
      }

      if (!scout) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'No start.gg player found for that query',
          statusCode: 404,
        });
      }

      const payload = await assembleReportPayload(request.uid, scout, app.firebase.database);

      let report;
      try {
        report = await generateScoutReport(client, payload);
      } catch (err) {
        if (err instanceof ReportGenerationError) {
          const message =
            err.reason === 'refusal'
              ? 'The model declined to generate a report for this request'
              : err.reason === 'truncated'
                ? 'Report generation was truncated — try again'
                : 'The model returned a response that could not be parsed — try again';
          return reply.code(502).send({
            error: 'Bad Gateway',
            message,
            statusCode: 502,
          });
        }
        if (err instanceof Anthropic.RateLimitError) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Claude is rate-limiting requests right now — try again shortly',
            statusCode: 429,
          });
        }
        if (err instanceof Anthropic.APIError) {
          request.log.error({ err }, 'Claude report generation failed');
          return reply.code(502).send({
            error: 'Bad Gateway',
            message: 'The model provider returned an error — try again shortly',
            statusCode: 502,
          });
        }
        throw err;
      }

      const ref = app.firebase.database.ref(`scoutReports/${request.uid}`).push();
      const record = {
        createdAt: Date.now(),
        model: 'claude-opus-4-8',
        player: scout.player,
        report,
      };
      await ref.set(record);

      const id = ref.key;
      if (!id) {
        throw new Error('Failed to generate a push key for the new scout report');
      }

      return { id, ...record };
    },
  );

  // GET /api/reports — newest-first.
  app.get(
    '/reports',
    {
      schema: {
        response: {
          200: z.array(scoutReportRecordSchema),
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!config.allowedUids.has(request.uid)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'AI reports are not enabled for this account',
          statusCode: 403,
        });
      }

      const snapshot = await app.firebase.database.ref(`scoutReports/${request.uid}`).get();
      if (!snapshot.exists()) {
        return [];
      }

      const raw = snapshot.val() as Record<string, unknown>;
      return Object.entries(raw)
        .map(([id, value]) => scoutReportRecordSchema.parse({ id, ...(value as object) }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
  );

  // GET /api/reports/:id
  app.get(
    '/reports/:id',
    {
      schema: {
        params: reportIdParamsSchema,
        response: {
          200: scoutReportRecordSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!config.allowedUids.has(request.uid)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'AI reports are not enabled for this account',
          statusCode: 403,
        });
      }

      const snapshot = await app.firebase.database
        .ref(`scoutReports/${request.uid}/${request.params.id}`)
        .get();
      if (!snapshot.exists()) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Report ${request.params.id} not found`,
          statusCode: 404,
        });
      }

      return scoutReportRecordSchema.parse({
        id: request.params.id,
        ...(snapshot.val() as object),
      });
    },
  );
};

export default reportsRoutes;
