import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  entryKeyInputSchema,
  errorResponseSchema,
  generateReportRequestSchema,
  isReportReadyBinding,
  PREP_BUNDLE_SIZE,
  prepBundleAcceptedResponseSchema,
  prepReportJobsResponseSchema,
  reportJobSchema,
  reportsConfigSchema,
  scoutReportRecordSchema,
  type PrepReportJobStatusEntry,
  type PrepReportReason,
  type ReportJob,
  type ScoutBinding,
  type ScoutReportData,
  type StoredScoutReport,
} from '@smash-tracker/shared';
import type {
  ParryggConfig,
  PrepPaidConfig,
  ReportsConfig,
  StartggConfig,
  StripeConfig,
} from '../config/env.js';
import { StartggApiError } from '../startgg/client.js';
import {
  parseScoutInput,
  ScoutCache,
  ScoutInputError,
  scoutPlayer,
  type ScoutInput,
} from '../startgg/scout.js';
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
import { bundleSlotRef, refundCredit, spendCredit, spendCredits } from '../billing/credits.js';
import { createEvent, dayShardKey } from '../events/ledger.js';
import { buildBillingEnvelope } from '../events/envelope.js';
// Phase 27 (RPT-01, Task 3): the ONE symbol the reports layer imports from
// the prep module — a deliberately ONE-WAY dependency (27-CONTEXT.md line
// 65). Nothing inside apps/api/src/prep/ imports back from reports, billing,
// or Anthropic (see prep/importGraph.test.ts, byte-unchanged by this plan).
import { readPrepBrief } from '../prep/prep.js';

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
  /**
   * Phase 27 (RPT-04): the paid-prep activation gate config. Null/omitted
   * (the default) means every `POST /reports` request carrying `reason`
   * (a prep-context request) answers 503 before any job, balance, ledger,
   * or model activity — for allowlisted and billable uids alike. Legacy
   * (non-prep) requests are completely unaffected either way.
   */
  prepPaidConfig: PrepPaidConfig | null;
}

const reportIdParamsSchema = z.object({
  id: z.string().min(1),
});

/** Phase 27 (Task 3): `GET /reports/jobs` querystring — the brief's entryKey, caller-uid-scoped. */
const reportJobsQuerySchema = z.object({
  entryKey: entryKeyInputSchema,
});

// ---------------------------------------------------------------------------
// Phase 27 (Task 2): shared types for the reusable generation internal
// ---------------------------------------------------------------------------

/**
 * One `POST /reports` failure reply shape — `status`/`error`/`message` map
 * directly onto the Fastify reply the route sends. Used for a failed scout
 * resolution (404/429/503), a failed model/storage step (429/502), and
 * (Phase 27 Task 2) the prep-only queued->running claim race (409) — one
 * type, reused, so the route has exactly one translation site.
 */
interface ReportFailureReply {
  status: 404 | 409 | 429 | 502 | 503;
  error: string;
  message: string;
}

type ScoutResolutionOutcome =
  { ok: true; scout: ScoutReportData } | { ok: false; failure: ReportFailureReply };

interface GeneratedReportRecord {
  id: string;
  createdAt: number;
  model: string;
  player: ScoutReportData['player'];
  report: StoredScoutReport;
}

type GenerationOutcome =
  { ok: true; record: GeneratedReportRecord } | { ok: false; failure: ReportFailureReply };

/** The minimal request surface `failJob`/`runReportGeneration` need — deliberately narrow so it's obvious neither depends on Fastify's full request type. */
interface ReportRequestContext {
  uid: string;
  log: { error(obj: Record<string, unknown>, msg: string): void };
}

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
 * failed | refunded`), keyed on a client-supplied (or server-generated
 * fallback) jobId. `creditRef` is the jobId itself — no separate
 * `reports:${uid}:` ref — so `credit_spent`/`credit_refunded` ledger entries
 * and the `report_started` / `report_completed` / `report_failed` B events
 * all correlate on the same key. A retry with a jobId that already
 * `succeeded` returns the cached result without spending a credit or calling
 * Anthropic again; a retry against a `running` job within the staleness
 * window 409s instead of double-generating. Execution itself stays
 * synchronous-in-request per STACK.md — only the STATE is durable.
 *
 * Phase 27 (RPT-01, Task 2/3): `POST /reports` is now a backward-compatible
 * request union — a legacy request (no `reason`) is completely unchanged,
 * and a `reason: 'prep_report'` request buys ONE curated opponent's report
 * through the SAME generation pipeline, grounded in a server-reloaded
 * `scoutBinding` rather than a client-supplied query. `runReportGeneration`
 * below (27-CONTEXT.md line 47 — "refactor the existing single-report
 * execution into a reusable internal function; do NOT duplicate its model or
 * storage pipeline") is the ONE place both branches actually generate and
 * store a report — a second generation path here (a copied model call, a
 * copied storage step, or a copied job state machine) is the specific
 * failure this extraction exists to prevent.
 */
const reportsRoutes: FastifyPluginAsyncZod<ReportsRoutesOptions> = async (app, options) => {
  const { config, startggConfig, stripeConfig, parryggConfig, prepPaidConfig } = options;

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

  /**
   * BILL-06/MEAS-03: single failure path for every failure/refund site in
   * the plugin, parameterized (Task 2) instead of closing over one
   * handler's locals — so both call sites of `runReportGeneration` below
   * and a future bundle child (27-08) can reuse it verbatim.
   *
   * Phase 27 (RPT-03): also writes the `refunded` terminal transition,
   * INSIDE this function, after the refund resolves, and ONLY when a
   * credit was actually refunded AND the job carries a prep `reason`:
   * - It happens strictly after `refundCredit` commits, never before, so a
   *   player never observes "refunded" while their balance is still short
   *   (27-CONTEXT.md line 56).
   * - It is scoped to prep jobs so legacy job behavior stays byte-identical
   *   — a legacy job's terminal status is always `failed`, never `refunded`.
   * - `reportJobsByDay`'s shard value keeps recording `failed`, NOT
   *   `refunded`, so the open reconciliation soak's day-shard tallies
   *   (STATE.md's Aug-2 blocker) are unperturbed by this addition.
   */
  async function failJob(params: {
    uid: string;
    jobId: string;
    creditRef: string;
    spent: boolean;
    reason?: PrepReportReason;
    createdAt: number;
    attempt: number;
    /** The day shard the running transition (if reached) already wrote to; null when the job never left `queued`. */
    day: string | null;
  }): Promise<void> {
    const { uid, jobId, creditRef, spent, reason, createdAt, attempt, day } = params;
    const jobRef = app.firebase.database.ref(`reportJobs/${uid}/${jobId}`);
    const now = Date.now();
    await jobRef.set(
      reportJobSchema.parse({
        status: 'failed',
        createdAt,
        updatedAt: now,
        attempt,
        creditRef,
        ...(reason ? { reason } : {}),
      }),
    );
    const resolvedDay = day ?? dayShardKey(now);
    await app.firebase.database.ref().update({
      [`reportJobsByStatus/running/${uid}/${jobId}`]: null,
      [`reportJobsByDay/${resolvedDay}/${jobId}`]: { uid, status: 'failed' },
    });
    if (spent) {
      await refundCredit(app.firebase.database, uid, creditRef);
      if (reason) {
        await jobRef.set(
          reportJobSchema.parse({
            status: 'refunded',
            createdAt,
            updatedAt: Date.now(),
            attempt,
            creditRef,
            reason,
          }),
        );
      }
    }
    void createEvent(
      app.firebase.database,
      buildBillingEnvelope({
        eventName: 'report_failed',
        source: 'job',
        actorId: uid,
        sessionId: uid,
        causationId: `${jobId}:report_failed`,
        consentState: 'unknown',
        payload: reason ? { reason } : {},
      }),
    );
  }

  /**
   * Phase 27 (Task 2): the ONE reusable generation internal — payload
   * assembly through the succeeded transition — shared by the legacy branch
   * and the prep-single branch (Task 3) of `POST /reports`. Deliberately
   * does NOT own the queued write, the spend decision, or any request-shape
   * pre-check — those differ per branch and stay in the handler. Returns
   * either the stored report record, or a typed failure the route
   * translates into the exact reply the caller already produced (each
   * `resolveScout` implementation owns its own status/error/message so this
   * function stays branch-agnostic).
   */
  async function runReportGeneration(params: {
    request: ReportRequestContext;
    jobId: string;
    creditRef: string;
    spent: boolean;
    jobCreatedAt: number;
    jobAttempt: number;
    reason?: PrepReportReason;
    resolveScout: () => Promise<ScoutResolutionOutcome>;
    payloadOptions?: { binding?: ScoutBinding; curatedCanonicalName?: string };
  }): Promise<GenerationOutcome> {
    const {
      request,
      jobId,
      creditRef,
      spent,
      jobCreatedAt,
      jobAttempt,
      reason,
      resolveScout,
      payloadOptions,
    } = params;
    const jobRef = app.firebase.database.ref(`reportJobs/${request.uid}/${jobId}`);

    const scoutOutcome = await resolveScout();
    if (!scoutOutcome.ok) {
      return { ok: false, failure: scoutOutcome.failure };
    }
    const scout = scoutOutcome.scout;

    const payload = await assembleReportPayload(
      request.uid,
      scout,
      app.firebase.database,
      payloadOptions,
    );

    // BILL-06/MEAS-03: transition to `running` immediately before the
    // Claude call — this is the durable "generation is genuinely in-flight"
    // marker the staleness check in the handler and the stuck-job sweep (a
    // later plan) rely on. `jobDay` is captured so every terminal
    // transition below clears the SAME day shard this write touches.
    const runningAt = Date.now();
    const jobDay = dayShardKey(runningAt);
    const runningRecord = reportJobSchema.parse({
      status: 'running',
      createdAt: jobCreatedAt,
      updatedAt: runningAt,
      attempt: jobAttempt,
      creditRef,
      ...(reason ? { reason } : {}),
    });

    if (reason) {
      // Phase 27 (Task 2, T-27-38 defence in depth): for PREP-CONTEXT jobs
      // only, claim the queued->running transition with a `.transaction()`
      // that aborts when the stored status is ALREADY `running` within the
      // staleness window — this narrows (without claiming to eliminate) the
      // pre-existing read-then-write race the single-writer-per-job
      // invariant otherwise assumes away for two near-simultaneous
      // executions of the SAME bundle child. Legacy jobs keep the plain
      // sequential `.set()` below, so their behavior stays byte-identical.
      const claim = await jobRef.transaction((current) => {
        const existing = current as { status?: string; updatedAt?: number } | null;
        if (
          existing &&
          existing.status === 'running' &&
          typeof existing.updatedAt === 'number' &&
          Date.now() - existing.updatedAt < REPORT_JOB_STALE_MS
        ) {
          return undefined;
        }
        return runningRecord;
      });
      if (!claim.committed) {
        return {
          ok: false,
          failure: {
            status: 409,
            error: 'Conflict',
            message: 'A report generation for this job is already in progress',
          },
        };
      }
    } else {
      await jobRef.set(runningRecord);
    }
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
        payload: reason ? { reason } : {},
      }),
    );

    let report;
    try {
      report = await generateScoutReport(client, payload);
    } catch (err) {
      if (err instanceof ReportGenerationError) {
        await failJob({
          uid: request.uid,
          jobId,
          creditRef,
          spent,
          reason,
          createdAt: jobCreatedAt,
          attempt: jobAttempt,
          day: jobDay,
        });
        const message =
          err.reason === 'refusal'
            ? 'The model declined to generate a report for this request'
            : err.reason === 'truncated'
              ? 'Report generation was truncated — try again'
              : 'The model returned a response that could not be parsed — try again';
        return { ok: false, failure: { status: 502, error: 'Bad Gateway', message } };
      }
      if (err instanceof Anthropic.RateLimitError) {
        await failJob({
          uid: request.uid,
          jobId,
          creditRef,
          spent,
          reason,
          createdAt: jobCreatedAt,
          attempt: jobAttempt,
          day: jobDay,
        });
        return {
          ok: false,
          failure: {
            status: 429,
            error: 'Too Many Requests',
            message: 'Claude is rate-limiting requests right now — try again shortly',
          },
        };
      }
      if (err instanceof Anthropic.APIError) {
        await failJob({
          uid: request.uid,
          jobId,
          creditRef,
          spent,
          reason,
          createdAt: jobCreatedAt,
          attempt: jobAttempt,
          day: jobDay,
        });
        request.log.error({ err }, 'Claude report generation failed');
        return {
          ok: false,
          failure: {
            status: 502,
            error: 'Bad Gateway',
            message: 'The model provider returned an error — try again shortly',
          },
        };
      }
      await failJob({
        uid: request.uid,
        jobId,
        creditRef,
        spent,
        reason,
        createdAt: jobCreatedAt,
        attempt: jobAttempt,
        day: jobDay,
      });
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
      await failJob({
        uid: request.uid,
        jobId,
        creditRef,
        spent,
        reason,
        createdAt: jobCreatedAt,
        attempt: jobAttempt,
        day: jobDay,
      });
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
        creditRef,
        resultRef: id,
        ...(reason ? { reason } : {}),
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
        payload: reason ? { reason } : {},
      }),
    );

    return { ok: true, record: { id, ...record } };
  }

  /**
   * Phase 27 (RPT-01, Task 3): builds the `resolveScout` callback for a
   * `reason: 'prep_report'` request. Resolution is grounded ENTIRELY in the
   * server-reloaded `binding` — the request body carries no query, source,
   * or combineWith at all (the shared schema forbids them outright on a
   * prep-context request; this is the runtime half of that guarantee,
   * 27-CONTEXT.md line 102). An unresolvable lookup, a rate limit, and an
   * unconfigured provider all map onto the SAME status codes (404/429/503)
   * the legacy single-source branches already use below, so the web app's
   * existing error handling for `POST /reports` needs no prep-specific
   * branch.
   *
   * Phase 27 (Task 2): `ctx.reason` is the EFFECTIVE reason (`prep_report`
   * normally, `prep_bundle` when this request is executing a pre-paid
   * bundle child) — never hardcoded — so a bundle child's `failJob` call
   * writes the SAME `prep_bundle` reason its job was created with.
   */
  function buildPrepResolveScout(
    binding: ScoutBinding,
    ctx: {
      uid: string;
      jobId: string;
      spent: boolean;
      jobCreatedAt: number;
      jobAttempt: number;
      reason: PrepReportReason;
    },
  ): () => Promise<ScoutResolutionOutcome> {
    const failCurrentJob = (): Promise<void> =>
      failJob({
        uid: ctx.uid,
        jobId: ctx.jobId,
        creditRef: ctx.jobId,
        spent: ctx.spent,
        reason: ctx.reason,
        createdAt: ctx.jobCreatedAt,
        attempt: ctx.jobAttempt,
        day: null,
      });

    if (binding.provider === 'startgg') {
      return async () => {
        if (!startggConfig) {
          await failCurrentJob();
          return {
            ok: false,
            failure: {
              status: 503,
              error: 'Service Unavailable',
              message: 'start.gg integration is not configured on this server',
            },
          };
        }
        // The binding's own resolved slug or numeric id — never an ordinary
        // gamer tag, and never anything read from the request body
        // (27-CONTEXT.md line 93, "no silent fallback to the canonical tag").
        const input: ScoutInput = binding.startggUserSlug
          ? { kind: 'slug', slug: binding.startggUserSlug }
          : { kind: 'playerId', playerId: binding.startggPlayerId! };
        try {
          const scout = await scoutPlayer(startggConfig.apiToken, input, fetchImpl, scoutCache);
          if (!scout) {
            await failCurrentJob();
            return {
              ok: false,
              failure: {
                status: 404,
                error: 'Not Found',
                message:
                  'The confirmed start.gg identity could not be found — it may have been removed',
              },
            };
          }
          return { ok: true, scout };
        } catch (err) {
          if (err instanceof StartggApiError && err.status === 429) {
            await failCurrentJob();
            return {
              ok: false,
              failure: {
                status: 429,
                error: 'Too Many Requests',
                message: 'start.gg is rate-limiting requests right now — try again shortly',
              },
            };
          }
          await failCurrentJob();
          throw err;
        }
      };
    }

    if (binding.provider === 'parrygg') {
      return async () => {
        if (!parryggConfig) {
          await failCurrentJob();
          return {
            ok: false,
            failure: {
              status: 503,
              error: 'Service Unavailable',
              message: 'parry.gg integration is not configured on this server',
            },
          };
        }
        // The binding's own resolved parry.gg user id (a UUID) is passed
        // directly — `resolveParryScoutPlayer` resolves a UUID-shaped query
        // straight through `getUser`, no search/tag-matching involved.
        const scout = await scoutParryPlayer(
          parryggConfig.apiKey,
          binding.parryUserId!,
          parryScoutCache,
          options.parryggClients,
        );
        if (!scout) {
          await failCurrentJob();
          return {
            ok: false,
            failure: {
              status: 404,
              error: 'Not Found',
              message:
                'The confirmed parry.gg identity could not be found — it may have been removed',
            },
          };
        }
        return { ok: true, scout };
      };
    }

    // Combined binding: both identities are resolved and merged the same
    // way V13's combined scouting already does — see `resolveCombinedScout`.
    return async () => {
      const startggQuery = binding.startggUserSlug ?? String(binding.startggPlayerId);
      const result = await resolveCombinedScout(
        [
          { query: startggQuery, source: 'startgg' },
          { query: binding.parryUserId!, source: 'parrygg' },
        ],
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
        await failCurrentJob();
        return {
          ok: false,
          failure:
            result.kind === 'rateLimited'
              ? {
                  status: 429,
                  error: 'Too Many Requests',
                  message: 'start.gg is rate-limiting requests right now — try again shortly',
                }
              : {
                  status: 404,
                  error: 'Not Found',
                  message:
                    'The confirmed identity could not be found on either site — it may have been removed',
                },
        };
      }
      return { ok: true, scout: result.report };
    };
  }

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
          // Phase 27 (Task 1): the `reason: 'prep_bundle'` accepted body —
          // a bundle submission never returns a generated report in-request.
          202: prepBundleAcceptedResponseSchema,
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
      // Phase 27 (RPT-04): load-bearing ordering — this is the FIRST
      // statement in the handler, above `freeAccess` and every other check.
      // It must precede the allowlist branch immediately below, so an
      // allowlisted uid is refused too while the gate is off (owner battery
      // item 9), and it must precede every state-changing/billable step
      // (the job write, the credit spend, the model/scout call) so a
      // gate-off request writes nothing at all (27-CONTEXT.md line 21). A
      // legacy (non-prep) request never carries `reason`, so it never hits
      // this branch and is completely unaffected by the gate either way.
      if (request.body.reason !== undefined && !prepPaidConfig) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Paid prep reports are not enabled on this server',
          statusCode: 503,
        });
      }

      // Phase 27 (RPT-02/RPT-03, Task 1): prep-bundle submission — the
      // exactly-three-opponent purchase. This branch validates completely,
      // charges exactly once atomically via `spendCredits`, and materializes
      // three deterministic pre-paid child jobs — or changes nothing at all
      // — and returns 202 (never 200; a bundle submission never generates a
      // report in-request). It deliberately does NOT reach the single-job
      // machinery below: the client executes each returned job id one at a
      // time through the ordinary `reason: 'prep_report'` path (Task 2),
      // which independently re-verifies ownership/curation/binding-
      // readiness for that specific opponent — this branch's ONLY job is
      // payment plus job/index bookkeeping.
      if (request.body.reason === 'prep_bundle') {
        const entryKey = request.body.entryKey!;
        const bundleId = request.body.bundleId!;
        const opponentNames = request.body.opponentNames!;

        // Validation, in this order, ALL before any charge (owner battery
        // item 6): a non-curated or unready opponent is rejected BEFORE the
        // caller is charged for the bundle. The schema already guarantees
        // exactly PREP_BUNDLE_SIZE DISTINCT names, so this is purely about
        // curation and report-readiness.
        const brief = await readPrepBrief(app.firebase.database, request.uid, entryKey);
        if (brief === null) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Prep brief not found',
            statusCode: 404,
          });
        }
        for (const opponentName of opponentNames) {
          if (!(opponentName in brief.likelyOpponents)) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: 'That opponent is not currently curated on this brief',
              statusCode: 400,
            });
          }
        }
        for (const opponentName of opponentNames) {
          const binding = brief.scoutBindings[opponentName];
          if (!binding || !isReportReadyBinding(binding)) {
            return reply.code(409).send({
              error: 'Conflict',
              message: 'This opponent has no confirmed, report-ready scout binding yet',
              statusCode: 409,
            });
          }
        }

        const bundleFreeAccess = config.allowedUids.has(request.uid);
        if (!bundleFreeAccess && !stripeConfig) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'AI reports are not enabled for this account',
            statusCode: 403,
          });
        }

        // Deterministic child job/slot ids — a retried submission of the
        // SAME bundleId always maps onto the SAME three jobs. `:` is the
        // slot separator; `#` is RTDB-path-illegal and would reach the
        // event dedup tree as a path segment (27-CONTEXT.md line 33).
        const buildBundleAcceptedResponse = () =>
          prepBundleAcceptedResponseSchema.parse({
            bundleId,
            jobs: opponentNames.map((opponentName, index) => ({
              opponentName,
              jobId: bundleSlotRef(bundleId, index + 1),
              slot: index + 1,
            })),
          });

        if (!bundleFreeAccess) {
          // ONE atomic three-credit debit, guarded by spendCredits' own
          // durable `creditBundleOps` operation marker — never three
          // sequential `spendCredit` calls (the owner-mandated rejection of
          // that design, 27-CONTEXT.md lines 30-41: they are compensating
          // transactions, not all-or-nothing, and `refundCredit` is not
          // balance-idempotent).
          const outcome = await spendCredits(
            app.firebase.database,
            request.uid,
            bundleId,
            PREP_BUNDLE_SIZE,
          );
          if (outcome === 'insufficient') {
            return reply.code(402).send({
              error: 'Payment Required',
              message: 'You need report credits — buy a pack to continue',
              statusCode: 402,
            });
          }
          if (outcome === 'alreadyProcessed') {
            // The credits were already taken for this bundle id — rebuild
            // the identical 202 body from the deterministic job ids instead
            // of creating (or charging for) anything (owner battery item 1).
            return reply.code(202).send(buildBundleAcceptedResponse());
          }
          // outcome === 'debited': proceed to create the three child jobs.
        } else {
          // Allowlisted uids (owner battery item 9) skip `spendCredits`
          // entirely — zero credit movement, no operation-marker debit —
          // so there is no durable marker this branch can consult for
          // idempotent replay. Job existence itself is the replay signal:
          // a slot-1 job that already exists means this exact bundleId was
          // already submitted, and the response is rebuilt without
          // rewriting (never resetting) an already-in-flight or resolved
          // child back to `queued`.
          const slotOneSnapshot = await app.firebase.database
            .ref(`reportJobs/${request.uid}/${bundleSlotRef(bundleId, 1)}`)
            .get();
          if (slotOneSnapshot.exists()) {
            return reply.code(202).send(buildBundleAcceptedResponse());
          }
        }

        const now = Date.now();
        const bundleUpdates: Record<string, unknown> = {};
        opponentNames.forEach((opponentName, index) => {
          const slot = index + 1;
          const childJobId = bundleSlotRef(bundleId, slot);
          bundleUpdates[`reportJobs/${request.uid}/${childJobId}`] = reportJobSchema.parse({
            status: 'queued',
            createdAt: now,
            updatedAt: now,
            attempt: 0,
            creditRef: childJobId,
            reason: 'prep_bundle',
          });
          bundleUpdates[`prepReportJobIndex/${request.uid}/${entryKey}/${opponentName}`] = {
            jobId: childJobId,
            updatedAt: now,
          };
        });
        // One root-level multi-path update for the three jobs and three
        // index pointers, so a partially-created bundle can never be
        // observed.
        await app.firebase.database.ref().update(bundleUpdates);

        return reply.code(202).send(buildBundleAcceptedResponse());
      }

      // Phase 27 (RPT-01, Task 3): prep-single ownership, curation, and
      // binding-readiness resolution — BEFORE `freeAccess`/the job
      // machinery below, and therefore before any spend, job write, or
      // model call (owner battery item 6, T-27-30/T-27-31). `readPrepBrief`
      // is called with `request.uid`, so a foreign entryKey 404s
      // indistinguishably from a missing one — implicit ownership, leaks
      // nothing (T-27-30).
      let prepBinding: ScoutBinding | null = null;
      if (request.body.reason === 'prep_report') {
        const entryKey = request.body.entryKey!;
        const opponentName = request.body.opponentName!;
        const brief = await readPrepBrief(app.firebase.database, request.uid, entryKey);
        if (brief === null) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Prep brief not found',
            statusCode: 404,
          });
        }
        if (!(opponentName in brief.likelyOpponents)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'That opponent is not currently curated on this brief',
            statusCode: 400,
          });
        }
        const binding = brief.scoutBindings[opponentName];
        if (!binding || !isReportReadyBinding(binding)) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'This opponent has no confirmed, report-ready scout binding yet',
            statusCode: 409,
          });
        }
        prepBinding = binding;
      }

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

      // Phase 27 (Task 2, RPT-02/RPT-03): PRE-PAID child detection — a
      // bundle submission (Task 1) writes each child job with
      // `reason: 'prep_bundle'`; the client executes ONE such child through
      // this same single-report path, always carrying `reason: 'prep_report'`
      // on the REQUEST — so `reason` on the request can never distinguish a
      // bundle child, only the STORED job's own `reason` can. A resolved
      // (failed/refunded) slot must never be re-runnable on a credit that
      // was already spent-and-returned or spent-and-lost — the second face
      // of owner battery item 4 (a replayed bundle must not obtain a free
      // generation, mirroring D3's "a replayed bundle id charges once").
      const preSpent = existingJob?.reason === 'prep_bundle';
      if (preSpent && (existingJob!.status === 'failed' || existingJob!.status === 'refunded')) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This bundle report already resolved and must be purchased again',
          statusCode: 409,
        });
      }

      const jobCreatedAt = existingJob?.createdAt ?? Date.now();
      const jobAttempt = existingJob ? existingJob.attempt + 1 : 0;

      let spent = false;
      let resolveScout: () => Promise<ScoutResolutionOutcome>;
      let payloadOptions: { binding?: ScoutBinding; curatedCanonicalName?: string } | undefined;
      // Phase 27 (Task 2): the reason threaded into the job writes,
      // `buildPrepResolveScout`'s failure path, and `runReportGeneration`'s
      // terminal transitions/events. Starts equal to the request's own
      // `reason` (undefined for legacy, `prep_report` for a normal
      // prep-single request) and is overridden ONLY when this request turns
      // out to be executing a PRE-PAID bundle child — a bundle child keeps
      // its ORIGINAL `prep_bundle` reason across every retry/resume, never
      // rewritten to `prep_report`, so `failJob`'s refunded-terminal
      // transition and the report_* event payloads stay attributable to the
      // bundle that paid for this slot.
      let effectiveReason: PrepReportReason | undefined = request.body.reason;

      if (request.body.reason === 'prep_report') {
        const binding = prepBinding!;
        const entryKey = request.body.entryKey!;
        const opponentName = request.body.opponentName!;

        if (preSpent) {
          effectiveReason = 'prep_bundle';
        }

        // Every check above this point (503/400/409/403) is a pure
        // request-shape or authorization rejection — nothing has been
        // attempted yet, so no job record is written for those. From here
        // on, the request WILL attempt generation, so the job enters
        // `queued`, carrying the enum `reason` — no entryKey, opponent
        // name, gamer tag, or provider id ever lands on the job node
        // (Information Disclosure mitigation, T-27-33).
        await jobRef.set(
          reportJobSchema.parse({
            status: 'queued',
            createdAt: jobCreatedAt,
            updatedAt: Date.now(),
            attempt: jobAttempt,
            creditRef: jobId,
            reason: effectiveReason,
          }),
        );

        if (preSpent) {
          // Phase 27 (Task 2): the credit for this slot was already spent
          // atomically by the bundle submission (or never spent at all, for
          // an allowlisted uid's bundle) — never spend a second time here.
          // `spent` is recomputed from `freeAccess` rather than trusted from
          // the stored job, because an allowlisted uid's bundle attaches no
          // credit to its children at all.
          spent = !freeAccess;
        } else if (!freeAccess) {
          // V7-C: non-allowlisted uids spend one credit per generation
          // attempt, identical to the legacy branch below.
          spent = await spendCredit(app.firebase.database, request.uid, jobId);
          if (!spent) {
            // 2026-08-03 walkthrough P2: a zero-credit attempt is a
            // REJECTED request, not a failed generation. The old failJob
            // call here overwrote a retried job's prior `refunded` terminal
            // with `failed` and emitted a false `report_failed` — no debit
            // occurred, no refund was owed. Restore the pre-overwrite row
            // verbatim (the `queued` write above already replaced it), or
            // remove the never-attempted row entirely for a fresh jobId.
            // No job terminal transition, no report_* event, no ledger
            // entry — the 402 alone is the outcome, and the checkout
            // affordance is the web app's cue.
            if (existingJob) {
              await jobRef.set(reportJobSchema.parse(existingJob));
            } else {
              await jobRef.remove();
            }
            return reply.code(402).send({
              error: 'Payment Required',
              message: 'You need report credits — buy a pack to continue',
              statusCode: 402,
            });
          }
        }

        // Phase 27 (RPT-01, 27-RESEARCH.md Pitfall 2): a convenience
        // pointer, not money-critical state — deliberately a plain `.set()`
        // rather than a transaction. It exists because job ids are
        // client-minted per click, so a reloaded page would otherwise have
        // no way to rediscover which job belongs to which curated
        // opponent. Written only AFTER the spend decision (2026-08-03 P2
        // fix) so a rejected zero-credit click can never leave the index
        // pointing at a job row that was restored or removed. Bounded by
        // the curated-opponent cap per brief, so it needs no pagination;
        // deliberately NOT added to a pruning job this phase — a recorded
        // discretionary follow-up, same spirit as the Phase 23
        // rate-limit-counter retention deferral (STATE.md).
        await app.firebase.database
          .ref(`prepReportJobIndex/${request.uid}/${entryKey}/${opponentName}`)
          .set({ jobId, updatedAt: Date.now() });

        resolveScout = buildPrepResolveScout(binding, {
          uid: request.uid,
          jobId,
          spent,
          jobCreatedAt,
          jobAttempt,
          reason: effectiveReason as PrepReportReason,
        });
        payloadOptions = { binding, curatedCanonicalName: opponentName };
      } else {
        // Schema guarantees `query` is present here — `reason` is present
        // only on the branches handled above, so this `else` is reached
        // exclusively by a legacy request, and `generateReportRequestSchema`'s
        // `superRefine` already requires `query` in that case.
        const rawQuery = request.body.query!;
        // Same source-resolution rule as POST /api/scout: a pasted parry.gg
        // profile URL always overrides `source` (or its default).
        const effectiveSource = parseParryProfileUrl(rawQuery)
          ? 'parrygg'
          : (request.body.source ?? 'startgg');

        // V13 combined scouting: a second lookup on the OTHER site is merged
        // into the report's data. combineWith targeting the SAME site is
        // ignored (the UI never produces it). Combined mode deliberately
        // SKIPS the single-source 503/400 pre-checks below: an unconfigured
        // or malformed side is gracefully dropped by the resolver so the
        // other side can still carry the report (locked "succeed with
        // whatever resolves" behavior).
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

        let input: ScoutInput | undefined;
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
        // (a client-generated, non-PII UUID) so credit_spent, the
        // creditLedger entry, and the report_* B events all correlate on
        // the same key.
        if (!freeAccess) {
          spent = await spendCredit(app.firebase.database, request.uid, jobId);
          if (!spent) {
            await failJob({
              uid: request.uid,
              jobId,
              creditRef: jobId,
              spent,
              createdAt: jobCreatedAt,
              attempt: jobAttempt,
              day: null,
            });
            return reply.code(402).send({
              error: 'Payment Required',
              message: 'You need report credits — buy a pack to continue',
              statusCode: 402,
            });
          }
        }

        if (combined) {
          resolveScout = async () => {
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
              await failJob({
                uid: request.uid,
                jobId,
                creditRef: jobId,
                spent,
                createdAt: jobCreatedAt,
                attempt: jobAttempt,
                day: null,
              });
              return {
                ok: false,
                failure:
                  result.kind === 'rateLimited'
                    ? {
                        status: 429,
                        error: 'Too Many Requests',
                        message: 'start.gg is rate-limiting requests right now — try again shortly',
                      }
                    : {
                        status: 404,
                        error: 'Not Found',
                        message: 'No player found for that query on either start.gg or parry.gg',
                      },
              };
            }
            return { ok: true, scout: result.report };
          };
        } else if (effectiveSource === 'parrygg') {
          resolveScout = async () => {
            const scout = await scoutParryPlayer(
              parryggConfig!.apiKey,
              rawQuery,
              parryScoutCache,
              options.parryggClients,
            );
            if (!scout) {
              await failJob({
                uid: request.uid,
                jobId,
                creditRef: jobId,
                spent,
                createdAt: jobCreatedAt,
                attempt: jobAttempt,
                day: null,
              });
              return {
                ok: false,
                failure: {
                  status: 404,
                  error: 'Not Found',
                  message: 'No parry.gg player found for that query',
                },
              };
            }
            return { ok: true, scout };
          };
        } else {
          resolveScout = async () => {
            try {
              const scout = await scoutPlayer(
                startggConfig!.apiToken,
                input!,
                fetchImpl,
                scoutCache,
              );
              if (!scout) {
                await failJob({
                  uid: request.uid,
                  jobId,
                  creditRef: jobId,
                  spent,
                  createdAt: jobCreatedAt,
                  attempt: jobAttempt,
                  day: null,
                });
                return {
                  ok: false,
                  failure: {
                    status: 404,
                    error: 'Not Found',
                    message: 'No start.gg player found for that query',
                  },
                };
              }
              return { ok: true, scout };
            } catch (err) {
              if (err instanceof StartggApiError && err.status === 429) {
                await failJob({
                  uid: request.uid,
                  jobId,
                  creditRef: jobId,
                  spent,
                  createdAt: jobCreatedAt,
                  attempt: jobAttempt,
                  day: null,
                });
                return {
                  ok: false,
                  failure: {
                    status: 429,
                    error: 'Too Many Requests',
                    message: 'start.gg is rate-limiting requests right now — try again shortly',
                  },
                };
              }
              await failJob({
                uid: request.uid,
                jobId,
                creditRef: jobId,
                spent,
                createdAt: jobCreatedAt,
                attempt: jobAttempt,
                day: null,
              });
              request.log.error({ err }, 'start.gg scout lookup failed during report generation');
              throw err;
            }
          };
        }
      }

      const generation = await runReportGeneration({
        request,
        jobId,
        creditRef: jobId,
        spent,
        jobCreatedAt,
        jobAttempt,
        // Phase 27 (Task 2): the EFFECTIVE reason — `prep_bundle`, not the
        // request's own `prep_report`, when this is a pre-paid child.
        reason: effectiveReason,
        resolveScout,
        payloadOptions,
      });

      if (!generation.ok) {
        return reply.code(generation.failure.status).send({
          error: generation.failure.error,
          message: generation.failure.message,
          statusCode: generation.failure.status,
        });
      }

      return generation.record;
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

  // GET /api/reports/jobs — Phase 27 (Task 3, RPT-03): the read-only
  // per-brief job-status endpoint. Registered BEFORE the parameterized
  // `/reports/:id` route below so the static `jobs` path segment is never
  // shadowed by `:id` matching the literal string "jobs".
  //
  // Deliberately OUTSIDE the activation gate (`prepPaidConfig` is never
  // consulted here): turning the gate off must never strand already-paid
  // work — completion, refunds, status reads, and result access all keep
  // working, and only NEW purchases are refused (27-CONTEXT.md line 24,
  // owner battery item 8). It also stays on the ordinary same-origin API
  // path; only generation SUBMISSIONS use the direct transport
  // (27-CONTEXT.md line 78, `VITE_API_DIRECT_URL`).
  app.get(
    '/reports/jobs',
    {
      schema: {
        querystring: reportJobsQuerySchema,
        response: {
          200: prepReportJobsResponseSchema,
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

      // uid-scoped read: a foreign/nonexistent entryKey yields the SAME
      // empty list either way — no existence signal (T-27-40).
      const indexSnapshot = await app.firebase.database
        .ref(`prepReportJobIndex/${request.uid}/${request.query.entryKey}`)
        .get();
      if (!indexSnapshot.exists()) {
        return { jobs: [] };
      }

      const pointers = indexSnapshot.val() as Record<string, { jobId?: string }>;
      const entries: PrepReportJobStatusEntry[] = [];
      for (const [opponentName, pointer] of Object.entries(pointers)) {
        const jobId = pointer?.jobId;
        if (!jobId) {
          continue;
        }
        const jobSnapshot = await app.firebase.database
          .ref(`reportJobs/${request.uid}/${jobId}`)
          .get();
        if (!jobSnapshot.exists()) {
          // The index pointer outlived its job node (should not happen
          // under the single-writer-per-job invariant, but T-27-43: one
          // corrupt/missing record must never 500 the caller's entire
          // status list) — skip it, mirroring GET /reports' stated
          // "one corrupt record must never 500 the whole library" rationale.
          continue;
        }
        const parsed = reportJobSchema.safeParse(jobSnapshot.val());
        if (!parsed.success) {
          request.log.warn(
            { jobId, issues: parsed.error.issues },
            'skipping stored report job that failed schema validation',
          );
          continue;
        }
        entries.push({
          opponentName,
          jobId,
          status: parsed.data.status,
          updatedAt: parsed.data.updatedAt,
          ...(parsed.data.resultRef ? { resultRef: parsed.data.resultRef } : {}),
        });
      }

      entries.sort((a, b) => a.opponentName.localeCompare(b.opponentName));
      return { jobs: entries };
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
