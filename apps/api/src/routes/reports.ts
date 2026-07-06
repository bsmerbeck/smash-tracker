import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  generateReportRequestSchema,
  reportsConfigSchema,
  scoutReportRecordSchema,
} from '@smash-tracker/shared';
import type { ParryggConfig, ReportsConfig, StartggConfig, StripeConfig } from '../config/env.js';
import { StartggApiError } from '../startgg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';
import { parseParryProfileUrl, ParryScoutCache, scoutParryPlayer } from '../parrygg/scout.js';
import type { ParryggClients } from '../parrygg/client.js';
import {
  assembleReportPayload,
  Anthropic,
  generateScoutReport,
  ReportGenerationError,
  type AnthropicLikeClient,
} from '../reports/generate.js';
import { refundCredit, spendCredit } from '../billing/credits.js';

export interface ReportsRoutesOptions {
  config: ReportsConfig | null;
  startggConfig: StartggConfig | null;
  /** V7-C: Stripe billing config; null disables credit purchases (pre-V7-C 403 behavior for non-allowlisted uids). */
  stripeConfig: StripeConfig | null;
  /** Overridable Anthropic client (tests) — a real client is built when omitted. */
  client?: AnthropicLikeClient;
  /** Overridable fetch for the start.gg GraphQL calls (tests). */
  fetchImpl?: typeof fetch;
  /** parry.gg integration config (V9-B Feature 4); null/omitted means a query resolved to parry.gg answers 503 (start.gg queries are unaffected). */
  parryggConfig?: ParryggConfig | null;
  /** Overridable parry.gg gRPC-Web service clients (tests). */
  parryggClients?: ParryggClients;
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
 * all); every other route 403s for a signed-in-but-not-allowlisted uid
 * UNLESS a signed-in-but-not-allowlisted uid has both Stripe configured
 * (V7-C) on this deployment AND spendable credits.
 *
 * V7-C billing: allowlisted uids (`config.allowedUids`) stay free/unlimited,
 * unchanged from V7-B — the paywall exists purely to cover the OWNER's own
 * Anthropic API costs from everyone else's usage. For a non-allowlisted uid:
 * when `stripeConfig` is null (Stripe not configured on this deployment),
 * behavior is EXACTLY the pre-V7-C 403 (no behavior change); when
 * `stripeConfig` is present, `POST /reports` spends one credit up front
 * (`spendCredit`, RTDB-transaction-safe against concurrent requests) and
 * refunds it (`refundCredit`) on every failure path after that point — a
 * failed generation must never cost the caller a credit. A zero balance at
 * spend time answers 402, which is the web app's cue to open the "buy
 * credits" dialog.
 */
const reportsRoutes: FastifyPluginAsyncZod<ReportsRoutesOptions> = async (app, options) => {
  const { config, startggConfig, stripeConfig, parryggConfig } = options;

  // AI reports need Claude configured, AND at least one of the two scouting
  // engines (start.gg or parry.gg) to actually source data from — same
  // per-source 503 gating as POST /api/scout below (a query resolved to a
  // source with no config answers 503 for THAT request, not a blanket
  // route-level 503, unless NEITHER source is configured at all).
  if (!config || (!startggConfig && !parryggConfig)) {
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
  const parryScoutCache = new ParryScoutCache();
  const client: AnthropicLikeClient =
    options.client ?? new Anthropic({ apiKey: config.anthropicApiKey });

  app.addHook('preHandler', app.authenticate);

  // GET /api/reports/config — never 403s; tells the web app whether to show
  // the "Generate AI report" button for the signed-in user, and (V7-C)
  // whether billing is available so it can show the credits indicator / buy
  // dialog for non-allowlisted users.
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
      const freeAccess = config.allowedUids.has(request.uid);
      const billingEnabled = stripeConfig !== null;
      return {
        enabled: freeAccess || billingEnabled,
        freeAccess,
        billingEnabled,
      };
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
          402: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const freeAccess = config.allowedUids.has(request.uid);

      if (!freeAccess && !stripeConfig) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'AI reports are not enabled for this account',
          statusCode: 403,
        });
      }

      const rawQuery = request.body.query;
      // Same source-resolution rule as POST /api/scout: a pasted parry.gg
      // profile URL always overrides `source` (or its default).
      const effectiveSource = parseParryProfileUrl(rawQuery)
        ? 'parrygg'
        : (request.body.source ?? 'startgg');

      if (effectiveSource === 'parrygg' && !parryggConfig) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'parry.gg integration is not configured on this server',
          statusCode: 503,
        });
      }
      if (effectiveSource === 'startgg' && !startggConfig) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'start.gg integration is not configured on this server',
          statusCode: 503,
        });
      }

      let input;
      if (effectiveSource === 'startgg') {
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
      }

      // V7-C: non-allowlisted uids spend one credit per generation attempt.
      // Spent up front (before the start.gg/Claude calls) so a concurrent
      // second request from the same uid can't both observe a positive
      // balance (spendCredit uses an RTDB transaction) — refunded on any
      // failure below. `creditRef` ties the spend and a possible refund to
      // the same request in the ledger.
      const creditRef = `reports:${request.uid}:${randomUUID()}`;
      let spent = false;
      if (!freeAccess) {
        spent = await spendCredit(app.firebase.database, request.uid, creditRef);
        if (!spent) {
          return reply.code(402).send({
            error: 'Payment Required',
            message: 'You need report credits — buy a pack to continue',
            statusCode: 402,
          });
        }
      }

      async function refundIfSpent(): Promise<void> {
        if (spent) {
          await refundCredit(app.firebase.database, request.uid, creditRef);
        }
      }

      let scout;
      if (effectiveSource === 'parrygg') {
        scout = await scoutParryPlayer(
          parryggConfig!.apiKey,
          rawQuery,
          parryScoutCache,
          options.parryggClients,
        );
        if (!scout) {
          await refundIfSpent();
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No parry.gg player found for that query',
            statusCode: 404,
          });
        }
      } else {
        try {
          scout = await scoutPlayer(startggConfig!.apiToken, input!, fetchImpl, scoutCache);
        } catch (err) {
          if (err instanceof StartggApiError && err.status === 429) {
            await refundIfSpent();
            return reply.code(429).send({
              error: 'Too Many Requests',
              message: 'start.gg is rate-limiting requests right now — try again shortly',
              statusCode: 429,
            });
          }
          await refundIfSpent();
          request.log.error({ err }, 'start.gg scout lookup failed during report generation');
          throw err;
        }

        if (!scout) {
          await refundIfSpent();
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No start.gg player found for that query',
            statusCode: 404,
          });
        }
      }

      const payload = await assembleReportPayload(request.uid, scout, app.firebase.database);

      let report;
      try {
        report = await generateScoutReport(client, payload);
      } catch (err) {
        if (err instanceof ReportGenerationError) {
          await refundIfSpent();
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
          await refundIfSpent();
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Claude is rate-limiting requests right now — try again shortly',
            statusCode: 429,
          });
        }
        if (err instanceof Anthropic.APIError) {
          await refundIfSpent();
          request.log.error({ err }, 'Claude report generation failed');
          return reply.code(502).send({
            error: 'Bad Gateway',
            message: 'The model provider returned an error — try again shortly',
            statusCode: 502,
          });
        }
        await refundIfSpent();
        throw err;
      }

      const ref = app.firebase.database.ref(`scoutReports/${request.uid}`).push();
      const record = {
        createdAt: Date.now(),
        model: 'claude-opus-4-8',
        player: scout.player,
        report,
      };
      try {
        await ref.set(record);
      } catch (err) {
        await refundIfSpent();
        throw err;
      }

      const id = ref.key;
      if (!id) {
        // The report was generated and stored — this is a server bug (push()
        // failing to yield a key), not a failed generation, so the spent
        // credit is NOT refunded here.
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
