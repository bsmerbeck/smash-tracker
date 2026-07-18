import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  generateReportRequestSchema,
  reportJobSchema,
  reportsConfigSchema,
  scoutReportRecordSchema,
  type ReportJob,
} from '@smash-tracker/shared';
import type { ParryggConfig, ReportsConfig, StartggConfig, StripeConfig } from '../config/env.js';
import { StartggApiError } from '../startgg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';
import { parseParryProfileUrl, ParryScoutCache, scoutParryPlayer } from '../parrygg/scout.js';
import type { ParryggClients } from '../parrygg/client.js';
import { resolveCombinedScout } from '../scout/combine.js';
import {
  assembleReportPayload,
  Anthropic,
  generateScoutReport,
  ReportGenerationError,
  type AnthropicLikeClient,
} from '../reports/generate.js';
import { refundCredit, spendCredit } from '../billing/credits.js';
import { createEvent, dayShardKey } from '../events/ledger.js';
import { buildBillingEnvelope } from '../events/envelope.js';

/**
 * BILL-06/MEAS-03 (Phase 10): a `running` report job older than this is
 * considered abandoned (crashed mid-generation, never reached a terminal
 * state) rather than genuinely in-flight — a retry with the same jobId is
 * allowed to proceed instead of 409ing forever. Comfortably beyond any real
 * Anthropic call; the stuck-job sweep (a later plan) uses the same window to
 * find and recover jobs that were never retried by their own client.
 */
const REPORT_JOB_STALE_MS = 15 * 60 * 1000;

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
 * refunds it (`refundCredit`, via `failJob()`) on every failure path after
 * that point — a failed generation must never cost the caller a credit. A
 * zero balance at spend time answers 402, which is the web app's cue to open
 * the "buy credits" dialog.
 *
 * BILL-06/MEAS-03 (Phase 10): generation is wrapped in a durable
 * `reportJobs/{uid}/{jobId}` state machine (`queued -> running -> succeeded |
 * failed`), keyed on a client-supplied (or server-generated fallback) jobId.
 * `creditRef` is the jobId itself — no separate `reports:${uid}:` ref — so
 * `credit_spent`/`credit_refunded` ledger entries and the `report_started` /
 * `report_completed` / `report_failed` B events all correlate on the same
 * key. A retry with a jobId that already `succeeded` returns the cached
 * result without spending a credit or calling Anthropic again; a retry
 * against a `running` job within the staleness window 409s instead of
 * double-generating. Execution itself stays synchronous-in-request per
 * STACK.md — only the STATE is durable.
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

  /**
   * Access rule for the READ routes (GET /reports, GET /reports/:id) — must
   * match POST's: allowlisted uids OR anyone when Stripe billing is
   * configured (V7-C). Since V7-C, a billing-enabled non-allowlisted uid can
   * PAY to generate a report via POST; gating the read routes to the
   * allowlist alone (the pre-V9-B behavior) meant they could buy credits,
   * generate a report, and then be 403'd from ever listing or reopening it.
   * When Stripe is NOT configured, the pre-V7-C allowlist-only 403 behavior
   * is unchanged.
   */
  const canReadReports = (uid: string): boolean =>
    config.allowedUids.has(uid) || stripeConfig !== null;

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
          409: errorResponseSchema,
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

      // BILL-06: durable, idempotent report job. `jobId` is client-generated
      // (one per "Generate report" click); a legacy/un-updated client that
      // omits it falls back to a server-generated jobId, which still works —
      // it just can't be retried idempotently from the client side.
      const jobId = request.body.jobId ?? randomUUID();
      const jobRef = app.firebase.database.ref(`reportJobs/${request.uid}/${jobId}`);
      const existingSnapshot = await jobRef.get();
      const existingJob: ReportJob | null = existingSnapshot.exists()
        ? reportJobSchema.parse(existingSnapshot.val())
        : null;

      // Idempotent retry: a jobId that already succeeded returns the stored
      // result WITHOUT spending a credit or calling Anthropic again. If the
      // stored resultRef is somehow missing its report record (should never
      // happen under the single-writer-per-job invariant), fall through and
      // regenerate rather than 500ing the caller.
      if (existingJob?.status === 'succeeded' && existingJob.resultRef) {
        const resultSnapshot = await app.firebase.database
          .ref(`scoutReports/${request.uid}/${existingJob.resultRef}`)
          .get();
        if (resultSnapshot.exists()) {
          return scoutReportRecordSchema.parse({
            id: existingJob.resultRef,
            ...(resultSnapshot.val() as object),
          });
        }
      }

      // A job still `running` within the staleness window is genuinely
      // in-flight (or was, up to REPORT_JOB_STALE_MS ago) — reject the
      // duplicate attempt rather than double-spend/double-generate. Past the
      // staleness window, treat it as abandoned and let this request retry.
      if (
        existingJob?.status === 'running' &&
        Date.now() - existingJob.updatedAt < REPORT_JOB_STALE_MS
      ) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'A report generation for this job is already in progress',
          statusCode: 409,
        });
      }

      const jobCreatedAt = existingJob?.createdAt ?? Date.now();
      const jobAttempt = existingJob ? existingJob.attempt + 1 : 0;
      // Set once the job first reaches `running`; reused by every terminal
      // transition so the running-index write and its clear land in the
      // same day shard.
      let jobDay: string | null = null;

      /**
       * BILL-06/MEAS-03: single failure path for every failure/refund site
       * below. Transitions the job to `failed`, clears the `running` index
       * (a no-op if the job never reached `running`), refunds the spent
       * credit (if any), and emits exactly one `report_failed` B event.
       */
      async function failJob(): Promise<void> {
        const now = Date.now();
        await jobRef.set(
          reportJobSchema.parse({
            status: 'failed',
            createdAt: jobCreatedAt,
            updatedAt: now,
            attempt: jobAttempt,
            creditRef: jobId,
          }),
        );
        const day = jobDay ?? dayShardKey(now);
        await app.firebase.database.ref().update({
          [`reportJobsByStatus/running/${request.uid}/${jobId}`]: null,
          [`reportJobsByDay/${day}/${jobId}`]: { uid: request.uid, status: 'failed' },
        });
        if (spent) {
          await refundCredit(app.firebase.database, request.uid, jobId);
        }
        void createEvent(
          app.firebase.database,
          buildBillingEnvelope({
            eventName: 'report_failed',
            source: 'job',
            actorId: request.uid,
            sessionId: request.uid,
            causationId: `${jobId}:report_failed`,
            consentState: 'unknown',
            payload: {},
          }),
        );
      }

      const rawQuery = request.body.query;
      // Same source-resolution rule as POST /api/scout: a pasted parry.gg
      // profile URL always overrides `source` (or its default).
      const effectiveSource = parseParryProfileUrl(rawQuery)
        ? 'parrygg'
        : (request.body.source ?? 'startgg');

      // V13 combined scouting: a second lookup on the OTHER site is merged into
      // the report's data. combineWith targeting the SAME site is ignored (the
      // UI never produces it). Combined mode deliberately SKIPS the
      // single-source 503/400 pre-checks below: an unconfigured or malformed
      // side is gracefully dropped by the resolver so the other side can still
      // carry the report (locked "succeed with whatever resolves" behavior).
      const combineWith = request.body.combineWith;
      const combined = Boolean(combineWith) && combineWith!.source !== effectiveSource;

      if (!combined && effectiveSource === 'parrygg' && !parryggConfig) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'parry.gg integration is not configured on this server',
          statusCode: 503,
        });
      }
      if (!combined && effectiveSource === 'startgg' && !startggConfig) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'start.gg integration is not configured on this server',
          statusCode: 503,
        });
      }

      let input;
      if (!combined && effectiveSource === 'startgg') {
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

      // Every check above this point (403/503/400) is a pure request-shape
      // rejection — nothing has been attempted yet, so no job record is
      // written for those. From here on, the request WILL attempt
      // generation, so the job enters `queued`.
      await jobRef.set(
        reportJobSchema.parse({
          status: 'queued',
          createdAt: jobCreatedAt,
          updatedAt: Date.now(),
          attempt: jobAttempt,
          creditRef: jobId,
        }),
      );

      // V7-C: non-allowlisted uids spend one credit per generation attempt.
      // Spent up front (before the start.gg/Claude calls) so a concurrent
      // second request from the same uid can't both observe a positive
      // balance (spendCredit uses an RTDB transaction) — refunded on any
      // failure below. BILL-06 (Phase 10): `creditRef` is the jobId itself
      // (a client-generated, non-PII UUID) so credit_spent, the creditLedger
      // entry, and the report_* B events all correlate on the same key.
      let spent = false;
      if (!freeAccess) {
        spent = await spendCredit(app.firebase.database, request.uid, jobId);
        if (!spent) {
          await failJob();
          return reply.code(402).send({
            error: 'Payment Required',
            message: 'You need report credits — buy a pack to continue',
            statusCode: 402,
          });
        }
      }

      let scout;
      if (combined) {
        const result = await resolveCombinedScout(
          [{ query: rawQuery, source: effectiveSource }, combineWith!],
          {
            startggConfig,
            parryggConfig: parryggConfig ?? null,
            fetchImpl,
            parryggClients: options.parryggClients,
            scoutCache,
            parryScoutCache,
          },
        );
        if (!result.ok) {
          await failJob();
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
        scout = result.report;
      } else if (effectiveSource === 'parrygg') {
        scout = await scoutParryPlayer(
          parryggConfig!.apiKey,
          rawQuery,
          parryScoutCache,
          options.parryggClients,
        );
        if (!scout) {
          await failJob();
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
            await failJob();
            return reply.code(429).send({
              error: 'Too Many Requests',
              message: 'start.gg is rate-limiting requests right now — try again shortly',
              statusCode: 429,
            });
          }
          await failJob();
          request.log.error({ err }, 'start.gg scout lookup failed during report generation');
          throw err;
        }

        if (!scout) {
          await failJob();
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No start.gg player found for that query',
            statusCode: 404,
          });
        }
      }

      const payload = await assembleReportPayload(request.uid, scout, app.firebase.database);

      // BILL-06/MEAS-03: transition to `running` immediately before the
      // Claude call — this is the durable "generation is genuinely
      // in-flight" marker the staleness check above and the stuck-job sweep
      // (a later plan) rely on. `jobDay` is captured so the terminal
      // transition below clears the SAME day shard this write touches.
      const runningAt = Date.now();
      jobDay = dayShardKey(runningAt);
      await jobRef.set(
        reportJobSchema.parse({
          status: 'running',
          createdAt: jobCreatedAt,
          updatedAt: runningAt,
          attempt: jobAttempt,
          creditRef: jobId,
        }),
      );
      await app.firebase.database.ref().update({
        [`reportJobsByStatus/running/${request.uid}/${jobId}`]: true,
        [`reportJobsByDay/${jobDay}/${jobId}`]: { uid: request.uid, status: 'running' },
      });
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_started',
          source: 'job',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: `${jobId}:report_started`,
          consentState: 'unknown',
          payload: {},
        }),
      );

      let report;
      try {
        report = await generateScoutReport(client, payload);
      } catch (err) {
        if (err instanceof ReportGenerationError) {
          await failJob();
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
          await failJob();
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Claude is rate-limiting requests right now — try again shortly',
            statusCode: 429,
          });
        }
        if (err instanceof Anthropic.APIError) {
          await failJob();
          request.log.error({ err }, 'Claude report generation failed');
          return reply.code(502).send({
            error: 'Bad Gateway',
            message: 'The model provider returned an error — try again shortly',
            statusCode: 502,
          });
        }
        await failJob();
        throw err;
      }

      // RTDB deletes null-valued keys on write, so persisting the model's
      // `headToHead: null` (a legitimate "no head-to-head history" output)
      // would come back with the key ABSENT and previously corrupted the
      // stored record (see storedScoutReportSchema's doc). Strip null fields
      // before writing — house conditional-spread convention — so records
      // are stored in exactly the shape they'll be read back in.
      const { headToHead, ...reportRest } = report;
      const storedReport = {
        ...reportRest,
        ...(headToHead !== null ? { headToHead } : {}),
      };

      const ref = app.firebase.database.ref(`scoutReports/${request.uid}`).push();
      const record = {
        createdAt: Date.now(),
        model: 'claude-opus-4-8',
        player: scout.player,
        report: storedReport,
      };
      try {
        await ref.set(record);
      } catch (err) {
        await failJob();
        throw err;
      }

      const id = ref.key;
      if (!id) {
        // The report was generated and stored — this is a server bug (push()
        // failing to yield a key), not a failed generation, so the spent
        // credit is NOT refunded here. The job is deliberately left in
        // `running` rather than transitioned here — there is no resultRef to
        // record, and the stuck-job sweep will eventually recover it.
        throw new Error('Failed to generate a push key for the new scout report');
      }

      // BILL-06/MEAS-03: terminal success transition. Clears the `running`
      // index (same day shard the running write used) and emits exactly one
      // `report_completed` B event.
      const succeededAt = Date.now();
      await jobRef.set(
        reportJobSchema.parse({
          status: 'succeeded',
          createdAt: jobCreatedAt,
          updatedAt: succeededAt,
          attempt: jobAttempt,
          creditRef: jobId,
          resultRef: id,
        }),
      );
      await app.firebase.database.ref().update({
        [`reportJobsByStatus/running/${request.uid}/${jobId}`]: null,
        [`reportJobsByDay/${jobDay}/${jobId}`]: { uid: request.uid, status: 'succeeded' },
      });
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_completed',
          source: 'job',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: `${jobId}:report_completed`,
          consentState: 'unknown',
          payload: {},
        }),
      );

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
      if (!canReadReports(request.uid)) {
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

      // safeParse + skip, not parse: one corrupt stored record (e.g. a
      // pre-fix row RTDB null-stripped — see storedScoutReportSchema — or
      // any future shape drift) must never 500 the caller's ENTIRE library.
      // Skipped records are logged with their id so they're findable, not
      // silently swallowed.
      const raw = snapshot.val() as Record<string, unknown>;
      return Object.entries(raw)
        .flatMap(([id, value]) => {
          const parsed = scoutReportRecordSchema.safeParse({ id, ...(value as object) });
          if (!parsed.success) {
            request.log.warn(
              { reportId: id, issues: parsed.error.issues },
              'skipping stored scout report that failed schema validation',
            );
            return [];
          }
          return [parsed.data];
        })
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
      if (!canReadReports(request.uid)) {
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
