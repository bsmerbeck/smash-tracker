import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  errorResponseSchema,
  isPathSafeProviderId,
  RESEARCH_INGESTION_RUN_STATUSES,
} from '@smash-tracker/shared';
import type { Ga4Config, InternalJobsConfig, StartggConfig } from '../config/env.js';
import { checkInternalJobSecret } from '../plugins/internalJobAuth.js';
import { runProjectGa4 } from '../jobs/projectGa4.js';
import { runReconcile } from '../jobs/reconcile.js';
import { runSweepStuckReportJobs } from '../jobs/sweepStuckReportJobs.js';
import { runPrune } from '../jobs/prune.js';
import { runFunnelReadout } from '../jobs/funnelReadout.js';
import {
  DEFAULT_MAX_PAGES_PER_INVOCATION,
  INTERNAL_JOB_MAX_SYNC_BACKOFF_MS,
  runResearchBackfillBatch,
} from '../jobs/researchBackfillBatch.js';
import { isPathSafeTenantId } from '../research/subjectKind.js';

const INTERNAL_JOBS_SECRET_HEADER = 'x-internal-jobs-secret';

export interface InternalJobsRoutesOptions {
  internalJobs: InternalJobsConfig | null;
  ga4: Ga4Config | null;
  /** Overridable fetch for the GA4 Measurement Protocol POST (tests). */
  ga4Fetch?: typeof fetch;
  /** Phase 30 Plan 07: start.gg config the research-backfill job needs; null answers 503 for that route only. */
  startgg: StartggConfig | null;
  /** Overridable fetch for the start.gg GraphQL calls the backfill batch makes (tests). */
  startggFetch?: typeof fetch;
}

const projectGa4ResultSchema = z.object({
  projected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const reconcileResultSchema = z.object({
  checked: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  phantom: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
});

const sweepStuckReportJobsResultSchema = z.object({
  swept: z.number().int().nonnegative(),
  refunded: z.number().int().nonnegative(),
});

const pruneResultSchema = z.object({
  prunedLedgerDays: z.array(z.string()),
  prunedExceptionDays: z.array(z.string()),
});

/** Quick task 260722-lxt: aggregate-only count map — keys are event/exception names, never person-derived fields. */
const countMapSchema = z.record(z.string(), z.number().int().nonnegative());

const funnelReadoutResultSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  days: z.array(
    z.object({
      day: z.string(),
      eventCounts: countMapSchema,
      exceptionCounts: countMapSchema,
      pendingProjection: z.number().int().nonnegative(),
    }),
  ),
  totals: z.object({
    eventCounts: countMapSchema,
    exceptionCounts: countMapSchema,
    pendingProjection: z.number().int().nonnegative(),
  }),
});

/** Hard 14-day cap enforced at the route boundary — the module clamps again as defense-in-depth. */
const funnelReadoutQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(14).default(7),
});

/**
 * Phase 30 Plan 07 (ING-01/ING-02): the two refinements below are not
 * decoration (review C-H13). A length-only schema lets a `.`- or
 * `#`-bearing id through to the executor, whose FIRST action is a
 * `readBackfillRun` that constructs a reference from it — and both the real
 * Admin SDK and `FakeDatabase` (`apps/api/src/test-support/fakeDatabase.ts:141`)
 * reject illegal key characters SYNCHRONOUSLY at `ref()` construction. That
 * is a thrown 500 from a handler whose executor contract is explicitly
 * never-throws. Validating at the route boundary turns it into an ordinary
 * validation response and keeps the contract true.
 */
const researchBackfillJobQuerySchema = z.object({
  tenantId: z
    .string()
    .min(1)
    .max(200)
    .refine(isPathSafeTenantId, 'tenantId is not a path-safe key'),
  runId: z.string().min(1).max(200).refine(isPathSafeProviderId, 'runId is not a path-safe key'),
  maxPages: z.coerce.number().int().min(1).max(50).default(DEFAULT_MAX_PAGES_PER_INVOCATION),
});

const researchBackfillStopReasonSchema = z.enum([
  'completed',
  'page-budget',
  'lease-held',
  'lease-lost',
  'retryable-write',
  'backoff-pending',
  'infra-error',
  'failed',
  'noop-terminal',
]);

/** Mirrors `ResearchBackfillBatchResult` (`apps/api/src/jobs/researchBackfillBatch.ts`). */
const researchBackfillJobResultSchema = z.object({
  runId: z.string(),
  status: z.enum(RESEARCH_INGESTION_RUN_STATUSES),
  completed: z.boolean(),
  stopReason: researchBackfillStopReasonSchema,
  retryable: z.boolean(),
  pagesProcessed: z.number().int().nonnegative(),
  setsObserved: z.number().int().nonnegative(),
  cursorPage: z.number().int().nonnegative(),
  totalPages: z.number().int().nullable(),
  throttledMs: z.number().int().nonnegative(),
  backoffEvents: z.number().int().nonnegative(),
  writeRetries: z.number().int().nonnegative(),
  staleWritesSkipped: z.number().int().nonnegative(),
  retryAfterObserved: z.boolean(),
  reason: z.string().nullable(),
});

/**
 * Phase 10 Plan 5 (Canonical Measurement & Money Safety): the
 * Cloud-Scheduler-facing internal job routes. Root-scoped (registered
 * OUTSIDE `/api` in app.ts) so the literal path `/internal/jobs/*` matches
 * what a Cloud Scheduler HTTP target must hit — note `firebase.json`
 * currently rewrites only `/api/**` and `/s/**`, so a `/internal/**`
 * Hosting rewrite (or a direct Cloud Run URL) must be provisioned before
 * Cloud Scheduler can reach this in production (flagged for Plan 06's
 * infra-setup task; zero user-visible change either way, since these
 * routes are never on the request path a browser hits).
 *
 * T-10-05-01 (Elevation of Privilege): when `internalJobs` is null
 * (`INTERNAL_JOBS_SECRET` unset), the ENTIRE `/internal/jobs*` scope
 * answers 503 — same "absent config = 503, not an open route" convention
 * `billing.ts` already establishes for `getStripeConfig`. When configured,
 * every route below requires an exact `X-Internal-Jobs-Secret` header
 * match (constant-time compare via `checkInternalJobSecret`) or 401s.
 */
const internalJobsRoutes: FastifyPluginAsyncZod<InternalJobsRoutesOptions> = async (
  app,
  options,
) => {
  const { internalJobs, ga4, ga4Fetch, startgg, startggFetch } = options;

  if (!internalJobs) {
    app.all('/internal/jobs*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Internal jobs are not enabled on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const requireInternalJobsSecret = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers[INTERNAL_JOBS_SECRET_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!checkInternalJobSecret(headerValue, internalJobs.secret)) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid internal jobs secret',
        statusCode: 401,
      });
    }
  };

  app.get(
    '/internal/jobs/project-ga4',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        response: {
          200: projectGa4ResultSchema,
          401: errorResponseSchema,
        },
      },
    },
    async () => {
      // MEAS-06: drains the bounded outboxPending day-shards and projects
      // only consent-granted events — never re-derives a canonical event
      // (Pitfall 2, see jobs/projectGa4.ts's own doc comment).
      return runProjectGa4(app.firebase.database, ga4, ga4Fetch);
    },
  );

  app.get(
    '/internal/jobs/reconcile',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        response: {
          200: reconcileResultSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      // MEAS-07: bounded single-day-shard comparison; writes ONLY to
      // reconciliationExceptions, never mutates a canonical/domain record
      // (see jobs/reconcile.ts's own doc comment).
      const result = await runReconcile(app.firebase.database);
      request.log.info(result, 'reconcile run summary');
      return result;
    },
  );

  app.get(
    '/internal/jobs/sweep-stuck-jobs',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        response: {
          200: sweepStuckReportJobsResultSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      // BILL-06: recovers orphaned `running` report jobs — atomic refund per
      // job, idempotent via the reportJobsByStatus/running index.
      const result = await runSweepStuckReportJobs(app.firebase.database);
      request.log.info(result, 'sweep-stuck-jobs run summary');
      return result;
    },
  );

  app.get(
    '/internal/jobs/prune',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        response: {
          200: pruneResultSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      // MEAS-08: whole-day-node retention pruning — never a per-record scan.
      const result = await runPrune(app.firebase.database);
      request.log.info(result, 'prune run summary');
      return result;
    },
  );

  // Quick task 260722-lxt: a bounded, aggregate-only operator readout for
  // the Phase 10 two-week soak gate. One curl gets Stage-1/Stage-3 funnel
  // evidence instead of Firebase-console spelunking:
  //   curl -sS -H "X-Internal-Jobs-Secret: $SECRET" "$HOST/internal/jobs/funnel-readout?days=7" | jq
  app.get(
    '/internal/jobs/funnel-readout',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        querystring: funnelReadoutQuerySchema,
        response: {
          200: funnelReadoutResultSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const { days } = request.query;
      const result = await runFunnelReadout(app.firebase.database, { days });
      request.log.info({ days, generatedAt: result.generatedAt }, 'funnel-readout run summary');
      return result;
    },
  );

  // Phase 30 Plan 07 (ING-01/ING-02): lets a scheduler or an operator
  // advance a research backfill with one secret-gated request, on the
  // established internal-jobs pattern. Takes NO research-admin gate
  // (documented below) — this scope's authorization model is the shared
  // secret, identical to every sibling job above.
  app.get(
    '/internal/jobs/research-backfill',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        querystring: researchBackfillJobQuerySchema,
        response: {
          200: researchBackfillJobResultSchema,
          401: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!startgg) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'start.gg integration is not configured on this server',
          statusCode: 503,
        });
      }

      const { tenantId, runId, maxPages } = request.query;
      const result = await runResearchBackfillBatch(
        app.firebase.database,
        startgg.apiToken,
        tenantId,
        runId,
        {
          maxPagesPerInvocation: maxPages,
          // The admin routes pass `TRIGGER_MAX_SYNC_BACKOFF_MS` because they
          // are reached through the Hosting rewrite and its ~60-second
          // window; this endpoint is reachable only via the direct Cloud Run
          // URL, where the request timeout is minutes rather than seconds,
          // so it gets the larger `INTERNAL_JOB_MAX_SYNC_BACKOFF_MS`. Both
          // are bounded, and neither is unbounded — a scheduler tick that
          // never returns is its own outage.
          maxSyncBackoffMs: INTERNAL_JOB_MAX_SYNC_BACKOFF_MS,
          fetchImpl: startggFetch,
        },
      );
      // A `backoff-pending` or `infra-error` result is a normal 200 here,
      // not an error status: the result object carries `retryable`, and a
      // scheduler that reads it simply ticks again. Returning a 5xx would
      // make an ordinary rate-limit pause look like a server fault in the
      // scheduler's own alerting.
      request.log.info(result, 'research-backfill run summary');
      return result;
    },
  );

  // Documented here rather than at the route above so the reasoning stays
  // attached to the decision, not just the code: this scope's authorization
  // model is the shared secret, identical to every sibling job in this
  // file, and layering the research allowlist on top would require a uid
  // this request does not have. The tenant scoping is supplied by the
  // caller's `tenantId`, which the executor guards with the path-safe
  // predicate before touching a reference, and the executor's own
  // identity-confirmation check is what stops an unconfirmed workspace from
  // being backfilled through this door.
  //
  // Operational note (production-gap checklist): `firebase.json` rewrites
  // only the api and share scopes, so `/internal/jobs/research-backfill` is
  // reachable in production only through the direct Cloud Run URL or a
  // newly provisioned rewrite — the same standing caveat the internal-jobs
  // scope already carries for Cloud Scheduler generally.
};

export default internalJobsRoutes;
