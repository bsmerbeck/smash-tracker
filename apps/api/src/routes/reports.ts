import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  countViableClaims,
  entryKeyInputSchema,
  errorResponseSchema,
  evidenceSnapshotRecordSchema,
  generateReportRequestSchema,
  isReportReadyBinding,
  MIN_VIABLE_CLAIMS,
  practicePlanResponseSchema,
  PREP_BUNDLE_SIZE,
  prepBundleAcceptedResponseSchema,
  prepReportJobsResponseSchema,
  reportJobSchema,
  reportsConfigSchema,
  scoutReportRecordSchema,
  storedPracticePlanSchema,
  synthesisJobStatusResponseSchema,
  validateReportOutput,
  type PrepReportJobStatusEntry,
  type PrepReportReason,
  type ReportFailureReason,
  type ReportJob,
  type ReportSurface,
  type ClaimSet,
  type EvidenceSnapshot,
  type ScoutBinding,
  type ScoutReportData,
  type ScoutReportRecord,
  type StoredScoutReport,
  type ValidationOutcome,
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
  REPORT_MODEL,
  type AnthropicLikeClient,
  type ReportPayload,
} from '../reports/generate.js';
import { projectScoutSelection, type ClaimSelection } from '../reports/claimSelection.js';
import { normalizeRtdbWriteShape, snapshotIdFor } from '../reports/snapshotId.js';
// Phase 28 (28-07, REV-03): the synthesis engine (28-06) — payload assembly,
// the Claude call, and post-generation citation validation. `SynthesisAnthropicClient`
// is a separate structural type from `AnthropicLikeClient` above (the
// `output_config.format` generic differs per output schema); the plugin's
// single `client` is cast at the one call site that needs it, mirroring
// 28-06-SUMMARY.md's documented rationale for keeping the two interfaces
// distinct rather than unifying them.
import {
  assembleSynthesisPayload,
  generatePracticePlan,
  projectPracticePlanSelection,
  type ProjectedPracticePlan,
  type SynthesisAnthropicClient,
  type SynthesisPayload,
} from '../reports/synthesis.js';
import {
  bundleIdFromSlotRef,
  bundleSlotRef,
  readBundleSpendFact,
  refundCredit,
  spendCredit,
  spendCredits,
} from '../billing/credits.js';
import { createEvent, dayShardKey } from '../events/ledger.js';
import { buildBillingEnvelope } from '../events/envelope.js';
// Phase 27 (RPT-01, Task 3): the ONE symbol the reports layer imports from
// the prep module — a deliberately ONE-WAY dependency (27-CONTEXT.md line
// 65). Nothing inside apps/api/src/prep/ imports back from reports, billing,
// or Anthropic (see prep/importGraph.test.ts, byte-unchanged by this plan).
import { readPrepBrief } from '../prep/prep.js';
// Phase 29 (RTEN-05A/RTEN-04, plan 29-11): the total, never-throwing
// research-subject classifier — see the refusal at the top of `POST
// /api/reports` below, and `apps/api/src/research/reportSubject.ts`'s
// module header for the full ordering/no-oracle rationale.
import { classifyReportSubject } from '../research/reportSubject.js';
// Phase 30.3 (demo-account money safety, Gate 6): the SAME allowlist
// predicate the bearer-delivery chokepoints consult. Used ONLY to widen the
// existing free-access branch (`hasFreeReportAccess` below) — never to add a
// new spend, refusal, or ordering constraint of its own.
import { isDemoAccountSubject } from '../research/demoAccount.js';

/**
 * BILL-06/MEAS-03 (Phase 10): a `running` report job older than this is
 * considered abandoned (crashed mid-generation, never reached a terminal
 * state) rather than genuinely in-flight — a retry with the same jobId is
 * allowed to proceed instead of 409ing forever. Comfortably beyond any real
 * Anthropic call; the stuck-job sweep (a later plan) uses the same window to
 * find and recover jobs that were never retried by their own client.
 */
const REPORT_JOB_STALE_MS = 15 * 60 * 1000;

/**
 * Code review R3-WR-02: the clock-skew allowance between this process and
 * the one running the stuck-job sweep. An execution whose running claim is
 * older than `REPORT_JOB_STALE_MS` minus this may already have been failed
 * AND refunded by the sweep, so it never refunds its own spend again.
 */
const SWEEP_CLOCK_SKEW_MARGIN_MS = 60 * 1000;

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

/**
 * Phase 28 (28-07, REV-03): `GET /reports/practice-plans/:planId` params —
 * uid-scoping (`practicePlans/{uid}/{planId}`) IS the ownership check, so
 * this schema only bounds shape, never identity. `entryKeyInputSchema`
 * (review WR-06): the value is interpolated straight into
 * `database.ref(...)`, so RTDB-reserved characters must 400 at the
 * boundary rather than throw synchronously inside the SDK as a 500 —
 * the exact failure mode that validator exists to prevent; RTDB push keys
 * always satisfy it.
 */
const practicePlanParamsSchema = z.object({
  planId: entryKeyInputSchema,
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

/**
 * `record` is the PARSED stored record (schema defaults applied, e.g. an
 * omitted empty `claimIds` read back as `[]`) — the only form a 200 may send,
 * because the response serializer ENCODES and never applies a default.
 */
type GenerationOutcome =
  { ok: true; record: ScoutReportRecord } | { ok: false; failure: ReportFailureReply };

/**
 * Phase 39 (RPT-05/D-07): the claim-set surface a `runReportGeneration` job
 * is validated against, derived from its job-KIND `reason`. A pre-paid
 * bundle child keeps its stored `prep_bundle` reason, so it validates as a
 * bundle child; a legacy (reason-free) job is the scout surface.
 */
function reportSurfaceFor(reason: PrepReportReason | undefined): ReportSurface {
  switch (reason) {
    case 'prep_bundle':
      return 'prep_bundle_child';
    case 'prep_report':
      return 'prep_report';
    case 'post_event_synthesis':
      return 'post_event_synthesis';
    default:
      return 'scout';
  }
}

/** The stored scout-report record minus its push key — the schema the store step checks and whose PARSED output the 200 response sends. */
const storedScoutReportRecordSchema = scoutReportRecordSchema.omit({ id: true });

/**
 * `record` is the WRITE form (an empty `claimIds` omitted, since RTDB would
 * drop it); `parsed` is the same record through the stored schema — the
 * read-back form, and the only form the 200 response may send.
 */
type ValidatedScoutReportBuild =
  | {
      ok: true;
      record: Omit<GeneratedReportRecord, 'id'>;
      parsed: Omit<ScoutReportRecord, 'id'>;
      outcome: ValidationOutcome;
    }
  | { ok: false };

/** Keeps an action slot only when the claim it rests on SURVIVED validation (rule R8) — a dropped action is counted, never stored. */
function survivingActionOrNull(
  action: ClaimSelection['action1'],
  surviving: ReadonlySet<string>,
): ClaimSelection['action1'] {
  return action !== null && action.claimId !== null && surviving.has(action.claimId)
    ? action
    : null;
}

/**
 * Phase 39 (D-06/D-07/RPT-07, reviews C1-B1/C1-H4/C2-H2/C3-M1): runs the
 * pure validator over the model's selection and, on `passed`, builds the
 * stored record from the SURVIVING claims only — so a claim the validator
 * dropped can never contribute a stage name to `stageStrategy`, and a
 * section whose prose lost its licence is stored with an empty connective.
 * TOTAL by construction: a `failed` outcome, a throw anywhere in validation
 * or projection, and a record the stored schema rejects (`safeParse`, never
 * a bare `.parse`) all return `{ ok: false }`, which the caller routes into
 * its ONE `failJob({ failureReason: 'validation' })` call. Never touches the
 * database and never refunds.
 */
function buildValidatedScoutReport(params: {
  selection: ClaimSelection;
  payload: ReportPayload;
  surface: ReportSurface;
  snapshotId: string;
  player: ScoutReportData['player'];
  log: ReportRequestContext['log'];
}): ValidatedScoutReportBuild {
  const { selection, payload, surface, snapshotId, player, log } = params;
  try {
    const outcome = validateReportOutput({
      snapshot: payload.snapshot,
      issuedClaims: payload.claimSet.claims,
      output: selection,
      surface,
    });
    if (outcome.status === 'failed') {
      return { ok: false };
    }
    const surviving = new Set(outcome.survivingClaimIds);
    const survivingClaims = payload.claimSet.claims.filter((claim) => surviving.has(claim.id));
    const selectionForStore: ClaimSelection = {
      ...selection,
      action1: survivingActionOrNull(selection.action1, surviving),
      action2: survivingActionOrNull(selection.action2, surviving),
      action3: survivingActionOrNull(selection.action3, surviving),
    };
    // RTDB deletes null-valued keys on write, so a nullable field is stored
    // by conditional spread in exactly the shape it reads back in. (The
    // projection omits `headToHead` by construction; the strip stays for any
    // future nullable field.)
    const { headToHead, ...reportRest } = projectScoutSelection({
      selection: selectionForStore,
      claims: survivingClaims,
      strippedSectionIds: outcome.strippedSectionIds,
    });
    const report: StoredScoutReport = {
      ...reportRest,
      ...(headToHead != null ? { headToHead } : {}),
      validation: {
        status: 'passed',
        policyVersion: outcome.policyVersion,
        snapshotId,
        claimSchemaVersion: outcome.claimSchemaVersion,
      },
      ...(outcome.droppedClaimCount > 0 ? { droppedClaimCount: outcome.droppedClaimCount } : {}),
    };
    // Code review API-IN-02: the ONE model constant the generation call uses.
    const record = { createdAt: Date.now(), model: REPORT_MODEL, player, report };
    const checked = storedScoutReportRecordSchema.safeParse(record);
    if (!checked.success) {
      log.error(
        { issues: checked.error.issues.map((issue) => ({ path: issue.path, code: issue.code })) },
        'Stored scout report failed its schema — routed to the validation failure branch',
      );
      return { ok: false };
    }
    return { ok: true, record, parsed: checked.data, outcome };
  } catch (err) {
    log.error(
      { err },
      'Scout report validation/projection threw — routed to the validation failure branch',
    );
    return { ok: false };
  }
}

type ValidatedPracticePlanBuild =
  { ok: true; record: ProjectedPracticePlan; outcome: ValidationOutcome } | { ok: false };

/**
 * Phase 39 (plan 39-08, D-02/D-06/D-07, reviews C1-B1/C2-H2): the synthesis
 * twin of `buildValidatedScoutReport` above — the ONE shared validator over
 * the model's selection (the `post_event_synthesis` surface's minimum), then,
 * on `passed`, `projectPracticePlanSelection` over the SURVIVING claims only.
 * TOTAL by construction: a `failed` outcome, a throw anywhere in validation
 * or projection, and a record `storedPracticePlanSchema` rejects (`safeParse`,
 * never a bare `.parse` — the shipped `.parse` sat OUTSIDE the try that wraps
 * `ref.set`, so a ZodError escaped with no refund, the job left `running`
 * and the credit held until the stale-job sweep) all return `{ ok: false }`,
 * which the caller routes into its ONE `failCurrentJob(day, 'validation')`.
 * Never touches the database and never refunds.
 */
function buildValidatedPracticePlan(params: {
  selection: ClaimSelection;
  snapshot: EvidenceSnapshot;
  claimSet: ClaimSet;
  snapshotId: string;
  entryKey: string;
  log: ReportRequestContext['log'];
}): ValidatedPracticePlanBuild {
  const { selection, snapshot, claimSet, snapshotId, entryKey, log } = params;
  try {
    const outcome = validateReportOutput({
      snapshot,
      issuedClaims: claimSet.claims,
      output: selection,
      surface: 'post_event_synthesis',
    });
    if (outcome.status === 'failed') {
      return { ok: false };
    }
    const surviving = new Set(outcome.survivingClaimIds);
    const survivingClaims = claimSet.claims.filter((claim) => surviving.has(claim.id));
    const record = projectPracticePlanSelection({
      entryKey,
      createdAt: Date.now(),
      selection: {
        ...selection,
        action1: survivingActionOrNull(selection.action1, surviving),
        action2: survivingActionOrNull(selection.action2, surviving),
        action3: survivingActionOrNull(selection.action3, surviving),
      },
      claims: survivingClaims,
      strippedSectionIds: outcome.strippedSectionIds,
      droppedClaimCount: outcome.droppedClaimCount,
      validation: {
        status: 'passed',
        policyVersion: outcome.policyVersion,
        snapshotId,
        claimSchemaVersion: outcome.claimSchemaVersion,
      },
    });
    const checked = storedPracticePlanSchema.safeParse(record);
    if (!checked.success) {
      log.error(
        { issues: checked.error.issues.map((issue) => ({ path: issue.path, code: issue.code })) },
        'Stored practice plan failed its schema — routed to the validation failure branch',
      );
      return { ok: false };
    }
    return { ok: true, record, outcome };
  } catch (err) {
    log.error(
      { err },
      'Practice plan validation/projection threw — routed to the validation failure branch',
    );
    return { ok: false };
  }
}

/**
 * Phase 28 (28-07): `runSynthesisGeneration`'s outcome — deliberately NOT
 * `GenerationOutcome` above (a practice plan has no scouted `player` and no
 * `scoutReports` record shape). `jobId`/`resultRef` let the route build the
 * 202 body without a second RTDB read of the job it just wrote.
 */
type SynthesisGenerationOutcome =
  | { ok: true; jobId: string; status: 'succeeded'; updatedAt: number; resultRef: string }
  | { ok: false; failure: ReportFailureReply };

/**
 * Code review R3-WR-02 (iteration 3): one request execution's settlement
 * latch. Its failure paths can chain — a resolver fails the job, then
 * rethrows into the post-spend guard — and since the guard can refund this
 * execution's own spend even when the job record is no longer its own, the
 * second attempt must be a no-op. `failOwnedJob` sets it once its first
 * settle has RESOLVED (review R4-WR-01) and returns immediately on any later
 * call. A settle that throws leaves it open, so the post-spend guard can
 * still settle the execution; the settle decision, once made, is final.
 */
interface ExecutionSettlement {
  settled: boolean;
}

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
/**
 * Code review R2-IN-04: a loggable copy of `err` with every occurrence of
 * `uid` in its message and stack replaced — RTDB errors name the path they
 * failed on, and a report job's path carries the uid. Never mutates `err`.
 */
function redactUid(err: unknown, uid: string): Record<string, unknown> {
  const redact = (text: string): string => (uid.length > 0 ? text.split(uid).join('<uid>') : text);
  if (err instanceof Error) {
    return {
      type: err.name,
      message: redact(err.message),
      ...(typeof err.stack === 'string' ? { stack: redact(err.stack) } : {}),
    };
  }
  return { message: redact(String(err)) };
}

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
   * Phase 30.3 (Gate 6): the ONE free-access predicate every branch in this
   * plugin consults — the pre-existing `REPORTS_ALLOWED_UIDS` allowlist,
   * widened by the demo-account allowlist. A demo account is an ordinary,
   * login-bearing account whose walkthrough must exercise report generation
   * without a purchase, so it is granted an ENTITLEMENT (the spend branch
   * is skipped entirely) rather than a credit grant — no `spendCredit`, no
   * `creditLedger` row, no `credits/{uid}/balance` mutation, no ledger
   * churn to reconcile afterwards.
   *
   * `isDemoAccountSubject` returns false whenever the allowlist is
   * unconfigured OR the uid is absent from it, so every non-demo subject's
   * behavior here is byte-identical to before this phase.
   */
  const hasFreeReportAccess = (uid: string): boolean =>
    config.allowedUids.has(uid) || isDemoAccountSubject(app.demoAccountConfig, uid);

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
    hasFreeReportAccess(uid) || stripeConfig !== null;

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
    /**
     * Phase 39 (D-07): WHY the job failed, written by conditional spread on
     * the terminal record(s). Deliberately NOT `reason` above — that is the
     * job KIND (a prep enum) and must never carry a failure cause.
     */
    failureReason?: ReportFailureReason;
  }): Promise<void> {
    const { uid, jobId, creditRef, spent, reason, createdAt, attempt, day, failureReason } = params;
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
        ...(failureReason ? { failureReason } : {}),
        // Post-plan fix (39-10): the spend fact rides BOTH terminal writes
        // (C1-H1 — the second `.set()` below replaces the node). A boolean,
        // never null, so it is always a safe RTDB value.
        wasCharged: spent,
      }),
    );
    const resolvedDay = day ?? dayShardKey(now);
    await app.firebase.database.ref().update({
      [`reportJobsByStatus/running/${uid}/${jobId}`]: null,
      [`reportJobsByDay/${resolvedDay}/${jobId}`]: { uid, status: 'failed' },
    });
    if (spent) {
      await refundCredit(app.firebase.database, uid, creditRef);
    }
    // Phase 27 (RPT-03): the `refunded` terminal is written strictly AFTER
    // `refundCredit` commits when a credit was actually spent, so a player
    // never observes "refunded" while their balance is still short.
    //
    // Phase 28 (review CR-02): a ZERO-SPEND post_event_synthesis failure
    // (free-access/allowlisted uid — there is no credit to refund) ALSO
    // terminates at `refunded`: the synthesis arm's one-job-per-entryKey
    // rule permits resubmission only from a `refunded` pointer, so resting
    // at `failed` permanently bricked the entry after one flaky model call
    // (and kept the web client polling the 4s "pending refund" state
    // forever). No `refundCredit` call happens on this branch — `failJob`
    // stays the sole refund path and a refund still fires exactly once,
    // only when `spent` is true. `prep_report`/`prep_bundle`/legacy
    // zero-spend failures keep their Phase 27 `failed` terminal
    // byte-identically (their retry contracts mint fresh jobIds and never
    // gate on `refunded`).
    if (reason && (spent || reason === 'post_event_synthesis')) {
      // Phase 39 (review C1-H1): `.set()` REPLACES the whole node, so this
      // second terminal write is AUTHORITATIVE and erases any field the
      // `failed` write above carried but this one omits — every field added
      // to the terminal record must be carried on BOTH writes.
      await jobRef.set(
        reportJobSchema.parse({
          status: 'refunded',
          createdAt,
          updatedAt: Date.now(),
          attempt,
          creditRef,
          reason,
          ...(failureReason ? { failureReason } : {}),
          wasCharged: spent,
        }),
      );
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
    // Phase 39 (AI-SPEC §7): an ADDITIONAL occurrence event for the
    // validation cause — the funnel readout counts by event NAME, so the
    // unchanged `report_failed` above cannot tell `'validation'` apart from
    // the pre-existing causes. `report_failed`'s own shape is untouched.
    if (failureReason === 'validation') {
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_failed_validation',
          source: 'job',
          actorId: uid,
          sessionId: uid,
          causationId: `${jobId}:report_failed_validation`,
          consentState: 'unknown',
          payload: reason ? { reason } : {},
        }),
      );
    }
  }

  /**
   * Post-plan fix (39-10, owner decision 2026-09-25): records `wasCharged` —
   * the `spent` fact the money path just settled — on a job whose `queued`
   * row was written BEFORE the spend resolved (prep single, legacy scout).
   * Sites whose queued write follows the spend (bundle children, synthesis)
   * carry the field on that write instead, and every later whole-node
   * `.set()` (running claim, succeeded, both `failJob` terminals) carries it
   * too, so no failed/refunded record the web can read ever lacks it.
   *
   * Deliberately BEST-EFFORT: this write sits after a committed spend and
   * before any `failJob` coverage, so a throw here must never become a 500
   * that strands a spent credit on a `queued` job the sweep never visits.
   * Nothing downstream depends on it — the running write re-states it.
   */
  async function recordSpendFact(
    jobRef: ReturnType<typeof app.firebase.database.ref>,
    spent: boolean,
    log: FastifyBaseLogger,
  ): Promise<void> {
    try {
      await jobRef.update({ wasCharged: spent });
    } catch (err) {
      log.warn({ err }, 'could not record the spend fact on a queued report job');
    }
  }

  /**
   * Code review R2-CR-01 (iteration 2): the ONE atomic settle for a failure
   * that happens while a job is still this execution's own. A single
   * `jobRef.transaction()` moves the job to `failed` ONLY when its stored
   * status is one of `from` AND its `executionId` is this execution's own
   * token; anything else — `succeeded`, `failed`, `refunded`, a status not in
   * `from`, or a row another execution of the same job id wrote — aborts
   * with nothing written. Returns true only when THIS transaction committed
   * the `failed` row, which is what licenses the one refund (`failJob`).
   *
   * Two executions of one job id can both pass the handler's read-then-write
   * duplicate check. `refundCredit` is not balance-idempotent, so the old
   * re-read-then-`failJob` guard refunded twice when both threw, and failed
   * and refunded a bundle child the other execution had already DELIVERED
   * (minting a credit). A pre-paid bundle child's credit belongs to the job,
   * not to either execution, so only the execution that still owns the row
   * may return it.
   *
   * RTDB transactions first run against the SDK's local cache, which is
   * `null` on a listener-less server even when the node exists (review
   * CR-01's abort-on-null trap). A null input is therefore returned
   * unchanged to force the server compare; a node that truly does not exist
   * commits that no-op and is reported as not settled.
   */
  async function settleOwnedJob(params: {
    jobRef: ReturnType<typeof app.firebase.database.ref>;
    executionId: string;
    from: ReadonlyArray<'queued' | 'running'>;
  }): Promise<boolean> {
    const { jobRef, executionId, from } = params;
    const result = await jobRef.transaction((current) => {
      if (current === null || current === undefined) {
        return null;
      }
      const job = current as { status?: unknown; executionId?: unknown };
      if (!(from as readonly unknown[]).includes(job.status) || job.executionId !== executionId) {
        return undefined;
      }
      return { ...(current as Record<string, unknown>), status: 'failed', updatedAt: Date.now() };
    });
    const settled = result.snapshot.val() as { status?: unknown; executionId?: unknown } | null;
    return result.committed && settled?.status === 'failed' && settled.executionId === executionId;
  }

  /**
   * `failJob` behind `settleOwnedJob`: the job is failed, and a spent credit
   * refunded, only when this execution's atomic settle committed. Used by
   * every failure path that can run while a concurrent execution of the same
   * job id may own the job — the post-spend guard, the prep resolver's own
   * failure branches (a bundle child is the shared case) and, since review
   * R3-WR-01, every failure after the running claim. Returns whether it
   * settled, so a caller can tell a no-op apart from a failure.
   */
  async function failOwnedJob(params: {
    uid: string;
    jobRef: ReturnType<typeof app.firebase.database.ref>;
    executionId: string;
    from: ReadonlyArray<'queued' | 'running'>;
    jobId: string;
    creditRef: string;
    spent: boolean;
    reason?: PrepReportReason;
    createdAt: number;
    attempt: number;
    day: string | null;
    failureReason?: ReportFailureReason;
    /** R3-WR-02: see `refundLostExecutionSpend`. */
    perExecutionSpend: boolean;
    /** R3-WR-02: when this execution wrote its `running` claim, or null when it never did. */
    claimedAt: number | null;
    /** R3-WR-02: this execution's latch — the first call settles, any later call is a no-op. */
    settlement: ExecutionSettlement;
  }): Promise<boolean> {
    const { jobRef, executionId, from, perExecutionSpend, claimedAt, settlement, ...failParams } =
      params;
    if (settlement.settled) {
      return false;
    }
    // Code review R4-WR-01: the latch closes only once the settle has
    // RESOLVED. A settle that throws (a transient RTDB error) has written
    // nothing and refunded nothing, so the latch stays open and the
    // post-spend guard (`failOwnedJobThenRethrow`) can still settle this
    // execution. Latching first stranded the spent credit on a `queued` job.
    const owned = await settleOwnedJob({ jobRef, executionId, from });
    settlement.settled = true;
    if (!owned) {
      await refundLostExecutionSpend({
        uid: failParams.uid,
        creditRef: failParams.creditRef,
        spent: failParams.spent,
        perExecutionSpend,
        claimedAt,
      });
      return false;
    }
    await failJob(failParams);
    return true;
  }

  /**
   * Code review R3-WR-02 (iteration 3): the refund of THIS execution's own
   * spend when it has lost the job to another execution. The ownership gate
   * (`settleOwnedJob`) decides who may write the JOB RECORD; it must not
   * decide whose money comes back. A prep single or a legacy job spends one
   * credit PER EXECUTION (`spendCredit`, the job id as its ref), so a crafted
   * duplicate of the same client-sent job id spends twice, and the execution
   * that lost the job used to keep the user's second credit. It is refunded
   * here, exactly once, and the job record is never touched. A pre-paid
   * bundle child's one credit belongs to the JOB (`perExecutionSpend` false),
   * so only the owner's `failJob` returns it.
   *
   * The one other refunder of a per-execution spend is the stuck-job sweep,
   * which fails and refunds a `running` row older than the staleness window
   * — this execution's own row if it was still the owner then. When this
   * execution's running claim is that old (less a clock-skew margin), the
   * sweep may already have returned its credit, so nothing is refunded here:
   * the one failure mode left is a user out one credit after a generation
   * that ran past the window, never a minted credit.
   */
  async function refundLostExecutionSpend(params: {
    uid: string;
    creditRef: string;
    spent: boolean;
    perExecutionSpend: boolean;
    claimedAt: number | null;
  }): Promise<void> {
    const { uid, creditRef, spent, perExecutionSpend, claimedAt } = params;
    if (!perExecutionSpend || !spent) {
      return;
    }
    if (
      claimedAt !== null &&
      Date.now() - claimedAt >= REPORT_JOB_STALE_MS - SWEEP_CLOCK_SKEW_MARGIN_MS
    ) {
      return;
    }
    await refundCredit(app.firebase.database, uid, creditRef);
  }

  /**
   * Code review R2-IN-04 (iteration 2): `failOwnedJob` for a failure that is
   * already on its way out as a thrown error. The settle can throw too (a
   * refund transaction that fails, an unreachable database) — that error is
   * logged here and swallowed, and the ORIGINAL `cause` is rethrown, so the
   * provider or assembly root cause is what reaches the 500 handler and its
   * log. The settle error is logged with the uid redacted from its message
   * and stack (RTDB errors name the path they failed on); no token is ever
   * part of a database error.
   */
  async function failOwnedJobThenRethrow(
    params: Parameters<typeof failOwnedJob>[0] & { log: ReportRequestContext['log'] },
    cause: unknown,
  ): Promise<never> {
    const { log, ...settleParams } = params;
    try {
      await failOwnedJob(settleParams);
    } catch (settleErr) {
      log.error(
        { err: redactUid(settleErr, settleParams.uid) },
        'could not settle a report job after a failure; the original error is rethrown',
      );
    }
    throw cause;
  }

  /**
   * Phase 39 (D-05/RPT-07): persists a job's evidence snapshot ONCE at its
   * CONTENT-ADDRESSED path `evidenceSnapshots/{uid}/{snapshotId}` and returns
   * the id. The path is derived from the snapshot's content (`snapshotIdFor`)
   * and never from a job id, so a swept-then-retried attempt over drifted
   * evidence writes a NEW node instead of mutating the old one. The write is
   * create-if-absent: the transaction aborts when a value already exists, so
   * a concurrent or repeated attempt over identical evidence is a no-op, not
   * a rewrite. The record goes through `evidenceSnapshotRecordSchema.parse`
   * (after the RTDB write-shape normalisation) so an undefined-bearing or
   * malformed payload fails HERE rather than inside the SDK.
   */
  async function writeEvidenceSnapshot(uid: string, snapshot: EvidenceSnapshot): Promise<string> {
    const snapshotId = snapshotIdFor(snapshot);
    const snapshotRecord = evidenceSnapshotRecordSchema.parse({
      ...(normalizeRtdbWriteShape(snapshot) as Record<string, unknown>),
      createdAt: Date.now(),
    });
    await app.firebase.database
      .ref(`evidenceSnapshots/${uid}/${snapshotId}`)
      .transaction((current) => (current === null ? snapshotRecord : undefined));
    return snapshotId;
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
    /** R2-CR-01: this request execution's own token, written on the job's queued row by the caller. */
    executionId: string;
    /**
     * R3-WR-02: true when `spent` is this execution's OWN `spendCredit` (a
     * prep single, a legacy job); false for a pre-paid bundle child, whose
     * credit belongs to the job. See `refundLostExecutionSpend`.
     */
    perExecutionSpend: boolean;
    /** R3-WR-02: this execution's settlement latch, shared with its resolver. */
    settlement: ExecutionSettlement;
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
      executionId,
      perExecutionSpend,
      settlement,
      resolveScout,
      payloadOptions,
    } = params;
    const jobRef = app.firebase.database.ref(`reportJobs/${request.uid}/${jobId}`);

    // Code review API-WR-01: everything between the spend (made by the
    // caller) and the `running` claim below — scout resolution and payload
    // assembly (the row builder, the claim builder, the action ranker, the
    // canonical digest, the stored-row schema parses) — is guarded. A throw
    // here used to return a 500 with the job left `queued` and the credit
    // spent; the stuck-job sweep reads only the `running` index, so nothing
    // ever recovered it. Now the job fails and refunds through the ONE
    // existing `failJob`, exactly once.
    //
    // Code review R2-CR-01: "exactly once" is enforced by ONE atomic
    // transaction (`failOwnedJob`), not by a re-read. It moves the job
    // `queued` -> `failed` only when the queued row is still this
    // execution's own, and the refund happens only when that transaction
    // committed. A resolver that already failed the job, a concurrent
    // execution of the same job id that re-queued it, claimed it `running`
    // or delivered it `succeeded` — all of them make this a no-op for the
    // job record. Review R3-WR-02: a credit THIS execution spent itself (a
    // prep single, a legacy job) is still refunded once in that case
    // (`refundLostExecutionSpend`); a bundle child's job-owned credit is not.
    let scout: ScoutReportData;
    let payload: ReportPayload;
    try {
      const scoutOutcome = await resolveScout();
      if (!scoutOutcome.ok) {
        return { ok: false, failure: scoutOutcome.failure };
      }
      scout = scoutOutcome.scout;
      payload = await assembleReportPayload(
        request.uid,
        scout,
        app.firebase.database,
        payloadOptions,
      );
    } catch (err) {
      return failOwnedJobThenRethrow(
        {
          log: request.log,
          uid: request.uid,
          jobRef,
          executionId,
          from: ['queued'],
          jobId,
          creditRef,
          spent,
          reason,
          createdAt: jobCreatedAt,
          attempt: jobAttempt,
          day: null,
          perExecutionSpend,
          claimedAt: null,
          settlement,
        },
        err,
      );
    }

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
      // Post-plan fix (39-10): every whole-node write carries the spend fact.
      wasCharged: spent,
      // R2-CR-01: the running row is this execution's own, like the queued one.
      executionId,
    });

    // Code review R2-WR-02 (iteration 2): the claim below and the running
    // index write after it sit after the spend, so a throw at either must not
    // strand the credit. A claim that throws leaves the job `queued` (nothing
    // sweeps it) — or, if the write applied before the call failed, `running`
    // under THIS execution's token — so it settles from either, ownership
    // checked. An index write that throws leaves the job `running` with no
    // `reportJobsByStatus/running` entry, the only index the stuck-job sweep
    // reads, so it settles from `running` and clears the shard it claimed.
    // Both go through the same atomic settle as the post-spend guard, and the
    // original error is rethrown.
    try {
      if (reason) {
        // Phase 27 (Task 2, T-27-38 defence in depth): for PREP-CONTEXT jobs
        // only, claim the queued->running transition with a `.transaction()`.
        // Review R3-WR-01 (iteration 3): the claim commits ONLY over this
        // execution's own `queued` row (its status is `queued` and its token
        // is this execution's). The old rule aborted only on a fresh
        // `running` row, so a duplicate execution that re-queued the job over
        // this one's claim could claim it as well. Anything else — another
        // execution's row, a resolved job, a missing node — is a 409. A null
        // first-run input (the SDK's local cache) is returned unchanged to
        // force the server compare; a node that truly does not exist commits
        // that no-op and is reported as not claimed. Legacy jobs keep the
        // plain sequential `.set()` below, so their behavior is unchanged.
        const claim = await jobRef.transaction((current) => {
          if (current === null || current === undefined) {
            return null;
          }
          const existing = current as { status?: unknown; executionId?: unknown };
          if (existing.status !== 'queued' || existing.executionId !== executionId) {
            return undefined;
          }
          return runningRecord;
        });
        const claimed = claim.snapshot.val() as { status?: unknown; executionId?: unknown } | null;
        if (
          !claim.committed ||
          claimed?.status !== 'running' ||
          claimed.executionId !== executionId
        ) {
          // R3-WR-02: another execution holds the job, so this one writes no
          // job record — but a credit it spent itself is still its own.
          if (!settlement.settled) {
            settlement.settled = true;
            await refundLostExecutionSpend({
              uid: request.uid,
              creditRef,
              spent,
              perExecutionSpend,
              claimedAt: null,
            });
          }
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
    } catch (err) {
      return failOwnedJobThenRethrow(
        {
          log: request.log,
          uid: request.uid,
          jobRef,
          executionId,
          jobId,
          creditRef,
          spent,
          reason,
          createdAt: jobCreatedAt,
          attempt: jobAttempt,
          from: ['queued', 'running'],
          day: null,
          perExecutionSpend,
          claimedAt: runningAt,
          settlement,
        },
        err,
      );
    }
    try {
      await app.firebase.database.ref().update({
        [`reportJobsByStatus/running/${request.uid}/${jobId}`]: true,
        [`reportJobsByDay/${jobDay}/${jobId}`]: { uid: request.uid, status: 'running' },
      });
    } catch (err) {
      return failOwnedJobThenRethrow(
        {
          log: request.log,
          uid: request.uid,
          jobRef,
          executionId,
          jobId,
          creditRef,
          spent,
          reason,
          createdAt: jobCreatedAt,
          attempt: jobAttempt,
          from: ['running'],
          day: jobDay,
          perExecutionSpend,
          claimedAt: runningAt,
          settlement,
        },
        err,
      );
    }
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

    // Phase 39 (D-05/RPT-07, review C4-H1), corrected by review R3-WR-01
    // (iteration 3): everything from here to the model call sits STRICTLY
    // BELOW the queued->running claim above. The claim alone is NOT a
    // single-writer window: a duplicate execution that read the job before
    // this claim and wrote its own `queued` row after it used to erase this
    // execution's `running` row and claim the job too, and a bare `failJob`
    // on both sides then returned one spend twice (`refundCredit` is NOT
    // balance-idempotent: an unconditional increment transaction plus a
    // ledger append; only its `credit_refunded` EVENT is deduped), or failed
    // and refunded a job the other side had already delivered. Two guards
    // close it together. The handler's prep queued write is a compare-and-set
    // against the row it read, and the prep claim commits only over this
    // execution's OWN queued row, so a straddling duplicate is turned away
    // with a 409 before it can take the job. And every failure below settles
    // through `failOwnedJob` from `running` with this execution's token, so
    // only the execution that still owns the running row can fail or refund
    // the job. Legacy (no-`reason`) jobs keep the plain `.set()` queued write
    // and running write; their failures below go through the same owned
    // settle.
    const ownedRunningFailure = {
      uid: request.uid,
      jobRef,
      executionId,
      from: ['running'] as const,
      jobId,
      creditRef,
      spent,
      reason,
      createdAt: jobCreatedAt,
      attempt: jobAttempt,
      day: jobDay,
      perExecutionSpend,
      claimedAt: runningAt,
      settlement,
    };
    const surface = reportSurfaceFor(reason);
    const issuedClaims = payload.claimSet.claims;
    let snapshotId: string;
    try {
      snapshotId = await writeEvidenceSnapshot(request.uid, payload.snapshot);
    } catch (err) {
      // A snapshot that cannot be persisted is an internal fault, not a
      // validation outcome: the catch-all sibling shape (one owned settle,
      // then rethrow) so the job never rests `running` with the credit held.
      return failOwnedJobThenRethrow({ ...ownedRunningFailure, log: request.log }, err);
    }

    // Phase 39 (D-21, owner decision 2026-09-20): FAIL FAST on thin evidence.
    // The EVIDENCED claim count is known before the model is called (D-23,
    // 2026-09-26: `countViableClaims` — abstentions never count, the same
    // helper the validator's status uses), so a workspace already below the
    // surface minimum — including one issuing only abstentions — makes NO
    // model call — the
    // job goes through the owned settle (`failOwnedJob`, whose `failJob` is
    // the one unchanged refund) with `failureReason: 'validation'`, and
    // nothing is stored. The
    // snapshot above IS still written on this path, deliberately: it is the
    // evidence for WHY the job failed, it is content-addressed so the write
    // is idempotent, and a refunded job with no snapshot would leave the
    // owner unable to tell a genuinely thin workspace from a broken
    // assembler. This replaces the charged cold-read report the path used to
    // deliver — that is the decision, not a gap to backfill with a degraded
    // report.
    if (countViableClaims(issuedClaims) < MIN_VIABLE_CLAIMS[surface]) {
      await failOwnedJob({
        ...ownedRunningFailure,
        failureReason: 'validation',
      });
      return {
        ok: false,
        failure: {
          status: 502,
          error: 'Bad Gateway',
          message: 'There is not enough match evidence yet to build a verified report',
        },
      };
    }

    let report;
    try {
      report = await generateScoutReport(client, payload);
    } catch (err) {
      if (err instanceof ReportGenerationError) {
        await failOwnedJob(ownedRunningFailure);
        const message =
          err.reason === 'refusal'
            ? 'The model declined to generate a report for this request'
            : err.reason === 'truncated'
              ? 'Report generation was truncated — try again'
              : 'The model returned a response that could not be parsed — try again';
        return { ok: false, failure: { status: 502, error: 'Bad Gateway', message } };
      }
      if (err instanceof Anthropic.RateLimitError) {
        await failOwnedJob(ownedRunningFailure);
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
        await failOwnedJob(ownedRunningFailure);
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
      return failOwnedJobThenRethrow({ ...ownedRunningFailure, log: request.log }, err);
    }

    // Phase 39 (D-06/D-07/RPT-07, review C2-H2): the validator seam and the
    // store-step build, between the model's return and the store. After the
    // model returns, EVERY outcome ends in exactly one of {a stored valid
    // record + `report_completed`} or {one `failJob` with
    // `failureReason: 'validation'`} — never an uncaught throw. A validation
    // failure, a projection that throws, and a record the stored schema
    // rejects all take the SAME single-call-then-return branch: a schema
    // `.parse` (or any throw) outside the refund path would turn a future
    // projection defect into a 500 with the job left `running` and the credit
    // held until the stale-job sweeper, and — before this branch existed — an
    // invalid record surfaced as a response-serialization failure AFTER the
    // job was already marked `succeeded`.
    const built = buildValidatedScoutReport({
      selection: report,
      payload,
      surface,
      snapshotId,
      player: scout.player,
      log: request.log,
    });
    if (!built.ok) {
      await failOwnedJob({
        ...ownedRunningFailure,
        failureReason: 'validation',
      });
      return {
        ok: false,
        failure: {
          status: 502,
          error: 'Bad Gateway',
          message:
            'The generated report could not be verified against your match evidence — try again',
        },
      };
    }
    const { record, parsed, outcome } = built;

    const ref = app.firebase.database.ref(`scoutReports/${request.uid}`).push();
    try {
      await ref.set(record);
    } catch (err) {
      return failOwnedJobThenRethrow({ ...ownedRunningFailure, log: request.log }, err);
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
        wasCharged: spent,
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
    // Phase 39 (AI-SPEC §7, review C3-M1/D-20): occurrence signals for a
    // DELIVERED report that lost claims or section prose. No count rides the
    // payload — the ledger is aggregate-only; the counts live on the stored
    // record the owner samples. Separate names rather than keys on
    // `report_completed`, because that envelope's payload is pinned by
    // exact-key assertions (`Object.keys(payload)` toEqual `['reason']` in
    // `reports.test.ts` and `reportsSynthesis.test.ts`) this phase has no
    // reason to loosen.
    if (outcome.droppedClaimCount > 0) {
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_claims_dropped',
          source: 'job',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: `${jobId}:report_claims_dropped`,
          consentState: 'unknown',
          payload: reason ? { reason } : {},
        }),
      );
    }
    if (outcome.strippedSectionIds.length > 0) {
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_prose_stripped',
          source: 'job',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: `${jobId}:report_prose_stripped`,
          consentState: 'unknown',
          payload: reason ? { reason } : {},
        }),
      );
    }

    // Post-plan fix (39-08): answer with the PARSED record, never the raw
    // write form. The serializer encodes without applying `.default([])`, so
    // a raw record with an omitted empty `claimIds` 500'd here — after the
    // job was `succeeded`, the report stored and the credit spent.
    return { ok: true, record: { id, ...parsed } };
  }

  /**
   * Phase 28 (28-07, REV-03): the `post_event_synthesis` sibling of
   * `runReportGeneration` above — RESEARCH Q4.5's "add a sibling internal,
   * not a fork of the job machine": the queued->running claim transaction
   * shape, `failJob` (verbatim), and the terminal-transition +
   * `report_started`/`report_completed`/`report_failed` event shapes are
   * ALL reused; only the model call, the post-generation validation hook
   * (Phase 39, plan 39-08: the ONE shared `validateReportOutput`, which
   * replaced 28-06's citation set-membership check), and the storage tree (`practicePlans/{uid}` instead of
   * `scoutReports/{uid}`) are distinct, because a practice plan has no
   * scouted player and a different output schema.
   *
   * `reason` is always `'post_event_synthesis'` here — a synthesis job is
   * never a legacy job, so (unlike `runReportGeneration`) this function
   * always takes the transaction-claim branch, never the plain `.set()`.
   */
  async function runSynthesisGeneration(params: {
    request: ReportRequestContext;
    jobId: string;
    creditRef: string;
    spent: boolean;
    jobCreatedAt: number;
    jobAttempt: number;
    entryKey: string;
    payload: SynthesisPayload;
    /** Phase 39 (D-05): the immutable snapshot over the synthesis rows — written below the claim, before the model call. */
    snapshot: EvidenceSnapshot;
    /** Phase 39 (D-01/D-02): the issued `vod_annotation` claim set the validator checks the selection against. */
    claimSet: ClaimSet;
  }): Promise<SynthesisGenerationOutcome> {
    const {
      request,
      jobId,
      creditRef,
      spent,
      jobCreatedAt,
      jobAttempt,
      entryKey,
      payload,
      snapshot,
      claimSet,
    } = params;
    const reason: PrepReportReason = 'post_event_synthesis';
    const jobRef = app.firebase.database.ref(`reportJobs/${request.uid}/${jobId}`);

    const failCurrentJob = (
      day: string | null,
      failureReason?: ReportFailureReason,
    ): Promise<void> =>
      failJob({
        uid: request.uid,
        jobId,
        creditRef,
        spent,
        reason,
        createdAt: jobCreatedAt,
        attempt: jobAttempt,
        day,
        ...(failureReason ? { failureReason } : {}),
      });

    // BILL-06/MEAS-03: transition to `running` immediately before the
    // Claude call — mirrors `runReportGeneration`'s prep-variant claim
    // transaction (`reason` is ALWAYS present for a synthesis job, so this
    // is the only branch that ever applies here, T-27-38 defence in depth).
    const runningAt = Date.now();
    const jobDay = dayShardKey(runningAt);
    const runningRecord = reportJobSchema.parse({
      status: 'running',
      createdAt: jobCreatedAt,
      updatedAt: runningAt,
      attempt: jobAttempt,
      creditRef,
      reason,
      // Post-plan fix (39-10): every whole-node write carries the spend fact.
      wasCharged: spent,
    });
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
          message: 'A synthesis generation for this job is already in progress',
        },
      };
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
        payload: { reason },
      }),
    );

    // Phase 39 (D-05/D-21/RPT-07, review C4-H1): the snapshot write and the
    // D-21 count check sit STRICTLY BELOW this function's claim transaction
    // and its `!claim.committed` 409 return above, and above the model call.
    // That claim is the only thing serialising two near-simultaneous
    // executions of the SAME jobId, and `refundCredit` is NOT
    // balance-idempotent (`billing/credits.ts`: an unconditional increment
    // transaction plus a ledger append; only its `credit_refunded` EVENT is
    // deduped on the credit ref, so the event count cannot see a second
    // refund — the balance and the ledger can). Above the claim, two
    // executions would each take the D-21 branch and return one spend twice;
    // here the loser gets the existing 409 like every sibling failure
    // branch's loser. (On this surface the route also mints a fresh
    // `randomUUID()` job id per submission behind the
    // `prepSynthesisJobIndex/{uid}/{entryKey}` pointer transaction, so a
    // second execution of one synthesis jobId is stopped even earlier.)
    let snapshotId: string;
    try {
      snapshotId = await writeEvidenceSnapshot(request.uid, snapshot);
    } catch (err) {
      // An unpersistable snapshot is an internal fault, not a validation
      // outcome: the catch-all sibling shape (one failCurrentJob, rethrow).
      await failCurrentJob(jobDay);
      throw err;
    }

    // Phase 39 (D-21, owner decision 2026-09-20): FAIL FAST on thin evidence.
    // The EVIDENCED claim count (D-23: `countViableClaims`, abstentions never
    // count) is known before the model is called, so an event whose
    // annotations issue fewer evidenced claims than the surface minimum makes NO
    // model call — the job takes the SAME `failCurrentJob` wrapper every
    // sibling branch here uses (the one `failJob`, its unchanged refund and
    // this path's zero-spend `refunded` terminal) with
    // `failureReason: 'validation'`, and nothing is stored. The snapshot
    // above IS still written: it is the evidence for why the job failed, and
    // it is content-addressed, so the write is idempotent.
    if (countViableClaims(claimSet.claims) < MIN_VIABLE_CLAIMS['post_event_synthesis']) {
      await failCurrentJob(jobDay, 'validation');
      return {
        ok: false,
        failure: {
          status: 502,
          error: 'Bad Gateway',
          message: 'There is not enough annotated evidence yet to build a verified practice plan',
        },
      };
    }

    let generated;
    try {
      generated = await generatePracticePlan(
        client as unknown as SynthesisAnthropicClient,
        payload,
      );
    } catch (err) {
      if (err instanceof ReportGenerationError) {
        await failCurrentJob(jobDay);
        const message =
          err.reason === 'refusal'
            ? 'The model declined to generate a practice plan for this request'
            : err.reason === 'truncated'
              ? 'Practice plan generation was truncated — try again'
              : 'The model returned a response that could not be parsed — try again';
        return { ok: false, failure: { status: 502, error: 'Bad Gateway', message } };
      }
      if (err instanceof Anthropic.RateLimitError) {
        await failCurrentJob(jobDay);
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
        await failCurrentJob(jobDay);
        request.log.error({ err }, 'Claude practice-plan generation failed');
        return {
          ok: false,
          failure: {
            status: 502,
            error: 'Bad Gateway',
            message: 'The model provider returned an error — try again shortly',
          },
        };
      }
      await failCurrentJob(jobDay);
      throw err;
    }

    // Phase 39 (plan 39-08, D-02/D-06/D-07/RPT-07, review C2-H2): the
    // validator seam, between the model's return and the store. The ONE
    // shared validator replaced 28-06's citation set-membership check here
    // (its rule is now the validator's R1 evidence-id membership over the
    // `vod_annotation` rows). After the model returns, EVERY outcome ends in
    // exactly one of {a stored valid plan + `report_completed`} or {one
    // `failCurrentJob(jobDay, 'validation')`} — never an uncaught throw.
    // PRESERVED byte-for-byte on this path, do not "tidy": (1) the spend that
    // precedes the queued write, (2) the always-transaction running claim,
    // (3) the retry window keyed on the job-KIND `reason`, (4) the `refunded`
    // terminal that fires for `post_event_synthesis` even without a spend.
    const built = buildValidatedPracticePlan({
      selection: generated,
      snapshot,
      claimSet,
      snapshotId,
      entryKey,
      log: request.log,
    });
    if (!built.ok) {
      await failCurrentJob(jobDay, 'validation');
      return {
        ok: false,
        failure: {
          status: 502,
          error: 'Bad Gateway',
          message:
            'The generated practice plan could not be verified against your annotated moments — try again',
        },
      };
    }
    const { record, outcome } = built;

    const ref = app.firebase.database.ref(`practicePlans/${request.uid}`).push();
    try {
      await ref.set(record);
    } catch (err) {
      await failCurrentJob(jobDay);
      throw err;
    }

    const planId = ref.key;
    if (!planId) {
      // Mirrors `runReportGeneration`'s identical guard: the plan was
      // generated and stored — this is a server bug (push() failing to
      // yield a key), not a failed generation, so the spent credit is NOT
      // refunded here; the job is deliberately left `running` for the
      // stuck-job sweep to recover.
      throw new Error('Failed to generate a push key for the new practice plan');
    }

    const succeededAt = Date.now();
    await jobRef.set(
      reportJobSchema.parse({
        status: 'succeeded',
        createdAt: jobCreatedAt,
        updatedAt: succeededAt,
        attempt: jobAttempt,
        creditRef,
        resultRef: planId,
        reason,
        wasCharged: spent,
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
        payload: { reason },
      }),
    );
    // Phase 39 (AI-SPEC §7, review C3-M1/D-20): the same occurrence signals,
    // in the same occurrence-only shape, the scout path emits for a DELIVERED
    // report that lost claims or section prose — no count in the payload.
    if (outcome.droppedClaimCount > 0) {
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_claims_dropped',
          source: 'job',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: `${jobId}:report_claims_dropped`,
          consentState: 'unknown',
          payload: { reason },
        }),
      );
    }
    if (outcome.strippedSectionIds.length > 0) {
      void createEvent(
        app.firebase.database,
        buildBillingEnvelope({
          eventName: 'report_prose_stripped',
          source: 'job',
          actorId: request.uid,
          sessionId: request.uid,
          causationId: `${jobId}:report_prose_stripped`,
          consentState: 'unknown',
          payload: { reason },
        }),
      );
    }

    return { ok: true, jobId, status: 'succeeded', updatedAt: succeededAt, resultRef: planId };
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
      executionId: string;
      /** R3-WR-02: false for a pre-paid bundle child, whose credit belongs to the job. */
      perExecutionSpend: boolean;
      /** R3-WR-02: the execution's settlement latch, shared with `runReportGeneration`. */
      settlement: ExecutionSettlement;
    },
  ): () => Promise<ScoutResolutionOutcome> {
    // Code review R2-CR-01: a prep job (a pre-paid bundle child above all)
    // can have two concurrent executions, so the resolver's own failure
    // branches settle through the same atomic, ownership-checked transaction
    // as the post-spend guard — never a bare `failJob` over a job the other
    // execution re-queued, claimed or delivered. Review R3-WR-02: losing the
    // job record does not forfeit a prep single's own spend, which is still
    // refunded once (`refundLostExecutionSpend`).
    const failCurrentJob = async (): Promise<void> => {
      await failOwnedJob({
        uid: ctx.uid,
        jobRef: app.firebase.database.ref(`reportJobs/${ctx.uid}/${ctx.jobId}`),
        executionId: ctx.executionId,
        from: ['queued'],
        jobId: ctx.jobId,
        creditRef: ctx.jobId,
        spent: ctx.spent,
        reason: ctx.reason,
        createdAt: ctx.jobCreatedAt,
        attempt: ctx.jobAttempt,
        day: null,
        perExecutionSpend: ctx.perExecutionSpend,
        claimedAt: null,
        settlement: ctx.settlement,
      });
    };

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
      const freeAccess = hasFreeReportAccess(request.uid);
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
          // Phase 28 (28-07): `reason: 'post_event_synthesis'` ALSO answers
          // 202 (its generation is synchronous-in-request per STACK.md, but
          // the wire contract mirrors the async-accepted shape the polling
          // hooks already expect — 28-02-PLAN.md's pinned wire contract) —
          // a union, since fastify-type-provider-zod's serializer parses
          // the response through the ONE schema registered per status code.
          202: z.union([prepBundleAcceptedResponseSchema, synthesisJobStatusResponseSchema]),
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

      // Phase 29 (RTEN-05A/RTEN-04, plan 29-11, D-10): the research-subject
      // refusal — inserted STRICTLY AFTER the activation-gate block above
      // and BEFORE every other branch (prep_bundle/post_event_synthesis/
      // prep_report/legacy), so it applies uniformly regardless of
      // `reason`. The gate block above MUST remain the first statement in
      // this handler; inserting anything above it would break the gate-off
      // 503 contract the locked "paid prep activation gate" test protects.
      //
      // This route's evidence (readPrepBrief), payload
      // (assembleReportPayload), and results (scoutReports/{request.uid})
      // are ALL keyed by the caller's own uid — a report generated here is
      // never ABOUT the tenant named by the header, so waiving a charge on
      // that basis would subsidize a report built from the admin's OWN
      // personal data. Rather than ship that, a research-subject (or an
      // unresolvable-subject) request is refused fail-closed here, before
      // any evidence read, payload assembly, job creation, spend, or
      // emission. See this plan's re-scope block and plan 29-02's
      // assumption-register row for the full RTEN-05A/RTEN-05B split —
      // Phase 32 (RTEN-05B) is where the waiver is actually wired, onto a
      // generalized subject model this route does not yet have.
      const activeSubjectHeaderRaw = request.headers['x-active-subject'];
      const activeSubjectHeader = Array.isArray(activeSubjectHeaderRaw)
        ? activeSubjectHeaderRaw[0]
        : activeSubjectHeaderRaw;
      const reportSubjectClassification = await classifyReportSubject({
        database: app.firebase.database,
        uid: request.uid,
        header: activeSubjectHeader,
      });
      if (reportSubjectClassification !== 'not-applicable') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'AI reports are not available for this workspace',
          statusCode: 403,
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

        const bundleFreeAccess = hasFreeReportAccess(request.uid);
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
            // Post-plan fix (39-10): spend time for a bundle child IS the
            // bundle debit above — `'debited'` is the only non-free outcome
            // that reaches this line, so the slot was charged exactly when
            // the uid is not free-access.
            wasCharged: !bundleFreeAccess,
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

      // Phase 28 (28-07, REV-03): post_event_synthesis — the post-event
      // practice-plan purchase. A fully self-contained branch (mirrors
      // `prep_bundle`'s shape immediately above), returning BEFORE reaching
      // the shared `freeAccess`/prep_report/legacy machinery below, so this
      // arm can never fall through into `scoutReports` accounting or
      // `runReportGeneration` (RESEARCH Q4.5 — a sibling internal, not a
      // fork of the job machine). Reuses `spendCredit` + the SAME
      // 402-restores-prior-state shape the prep-single branch uses below
      // (NOT `prep_bundle`'s `spendCredits` — this is a single-job, one
      // credit purchase), and `failJob` verbatim inside
      // `runSynthesisGeneration` — no second gate, no second refund path
      // (owner-locked, ROADMAP.md).
      if (request.body.reason === 'post_event_synthesis') {
        const entryKey = request.body.entryKey!;

        // Ownership/activation — implicit ownership via request.uid; a
        // foreign or never-activated entryKey 404s indistinguishably,
        // mirroring the prep-single precedent (T-27-30) immediately below.
        const synthBrief = await readPrepBrief(app.firebase.database, request.uid, entryKey);
        if (synthBrief === null) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Prep brief not found',
            statusCode: 404,
          });
        }

        // Synthesis exists only on the review surface (28-01/28-04): a
        // brief that hasn't converted (no frozen `reviewAt`) has nothing to
        // synthesize yet.
        if (synthBrief.reviewAt == null) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'This event has not converted to review mode yet',
            statusCode: 409,
          });
        }

        const synthFreeAccess = hasFreeReportAccess(request.uid);
        if (!synthFreeAccess && !stripeConfig) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'AI reports are not enabled for this account',
            statusCode: 403,
          });
        }

        // One job per entryKey (reports-route-owns-the-index precedent):
        // `prepSynthesisJobIndex/{uid}/{entryKey}` always names the LATEST
        // job. An outstanding job (queued/running/fresh-failed) or a
        // succeeded job 409s a new submission — a REFUNDED terminal (or a
        // stale crash-window remnant, see `synthRetryable` below) permits
        // retry, which overwrites the pointer with the new jobId (owner
        // "no purchase churn on one entry" rule).
        const indexRef = app.firebase.database.ref(
          `prepSynthesisJobIndex/${request.uid}/${entryKey}`,
        );
        const existingIndexSnapshot = await indexRef.get();
        const existingPointer = existingIndexSnapshot.exists()
          ? (existingIndexSnapshot.val() as { jobId?: string; updatedAt?: number } | null)
          : null;
        let existingSynthJob: ReportJob | null = null;
        if (existingPointer?.jobId) {
          const existingJobSnapshot = await app.firebase.database
            .ref(`reportJobs/${request.uid}/${existingPointer.jobId}`)
            .get();
          if (existingJobSnapshot.exists()) {
            // Tolerant safeParse-and-warn (review IN-03, T-27-43 precedent —
            // mirrors the sibling GET): one corrupt job node must never
            // permanently 500 the purchase path. Unparseable is treated as
            // "no existing job" (the same `{job: null}` answer the GET
            // gives), so the entry stays purchasable.
            const parsedExistingJob = reportJobSchema.safeParse(existingJobSnapshot.val());
            if (parsedExistingJob.success) {
              existingSynthJob = parsedExistingJob.data;
            } else {
              request.log.warn(
                { jobId: existingPointer.jobId, issues: parsedExistingJob.error.issues },
                'ignoring stored synthesis job that failed schema validation on submission',
              );
            }
          }
        }
        // Review CR-02 (crash-window recovery): besides the ordinary
        // `refunded` retry terminal, a pointer at a STALE `queued` job (a
        // crash between the queued write and the running transition — the
        // stuck-job sweep reads only the `running` index and never recovers
        // these) or a STALE `failed` job (a refund that crashed mid-`failJob`,
        // or a sweep-recovered job whose sweep terminal is `failed`) must not
        // 409 the entry forever. Within the staleness window both states
        // still 409 — a genuinely in-flight request, or a refund that is
        // still committing, is protected. A stranded spend behind a stale
        // job is a bounded crash-window casualty (the same class the
        // review's spend-first ordering accepts); retrying never
        // double-refunds because `failJob` remains the sole refund path.
        let synthRetryable: boolean;
        if (existingPointer?.jobId == null) {
          // No pointer (or an empty one) — a first-ever submission.
          synthRetryable = true;
        } else if (existingSynthJob == null) {
          // Dangling/corrupt pointer target. Retryable only once the
          // POINTER is stale: with the WR-04 spend-first ordering below, a
          // FRESH dangling pointer is another request's in-flight claim
          // whose queued write simply hasn't landed yet — treating it as
          // retryable would reopen the concurrent double-spend WR-01's
          // claim transaction exists to close. A stale one is a crash
          // remnant (or the IN-03 corrupt-node case) and unblocks.
          const pointerUpdatedAt =
            typeof existingPointer.updatedAt === 'number' ? existingPointer.updatedAt : 0;
          synthRetryable = Date.now() - pointerUpdatedAt > REPORT_JOB_STALE_MS;
        } else {
          const synthJobIsStale = Date.now() - existingSynthJob.updatedAt > REPORT_JOB_STALE_MS;
          synthRetryable =
            existingSynthJob.status === 'refunded' ||
            ((existingSynthJob.status === 'queued' || existingSynthJob.status === 'failed') &&
              synthJobIsStale);
        }
        if (!synthRetryable) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A synthesis for this event is already outstanding or complete',
            statusCode: 409,
          });
        }

        // Evidence precondition: zero stored annotations is a GUARANTEED
        // fail-and-refund (28-06's citation validator can never survive an
        // empty evidence universe) — refused up front, before any spend,
        // mirroring the UI's own no-purchase precondition
        // (`needAnnotations`, 28-09-SUMMARY.md). The assembled payload is
        // KEPT for the generation step below — never re-assembled.
        const assembled = await assembleSynthesisPayload(
          app.firebase.database,
          request.uid,
          entryKey,
        );
        if (!assembled.found) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Prep brief not found',
            statusCode: 404,
          });
        }
        if (assembled.evidenceCount === 0) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Annotate at least one VOD moment before generating a practice plan',
            statusCode: 409,
          });
        }

        // Every check above this point (404/409/403) is a pure
        // request-shape/authorization/precondition rejection — nothing has
        // been attempted yet, so no job record is written for those. From
        // here on, the request WILL attempt generation: the job enters
        // `queued`, carrying the enum `reason` — no entryKey or plan
        // content ever lands on the job node (D-14, Information Disclosure
        // mitigation).
        // CR-01 (Phase 28 review): ALWAYS server-minted — the shared schema
        // forbids `jobId` outright for this reason (reports.ts superRefine),
        // and this line must never fall back to a client value: the
        // 402-restore below is only correct because this id can never name a
        // pre-existing job node (a client-supplied id could clobber, then
        // delete, a succeeded prep job's durable record and collide its
        // `creditRef`/causation ids in the billing ledger).
        const synthJobId = randomUUID();
        const synthJobRef = app.firebase.database.ref(`reportJobs/${request.uid}/${synthJobId}`);
        const synthJobCreatedAt = Date.now();

        // WR-01 (Phase 28 review): claim the index pointer with a
        // `.transaction()` BEFORE any spend or durable job write — the
        // previous read-then-`set()` let two concurrent submissions
        // (double-click, retry racing a slow first request) both observe a
        // retryable pointer, both spend a credit, and both generate, with
        // the losing plan orphaned behind a last-writer-wins pointer. The
        // transaction commits only when the stored pointer still names the
        // SAME job the pre-read above resolved as retryable (or is absent);
        // exactly one concurrent claimant wins, and the loser 409s having
        // written and spent NOTHING. Mirrors `spendCredits`' claim-marker
        // shape (Phase 27 creditBundleOps precedent).
        const priorJobId = existingPointer?.jobId ?? null;
        const claimValue = { jobId: synthJobId, updatedAt: synthJobCreatedAt };
        const claim = await indexRef.transaction((current) => {
          const ptr = current as { jobId?: string } | null;
          if (ptr == null) {
            // First run always sees the SDK's null local cache (the same
            // real-RTDB semantics `freezeReviewAtIfDue` documents): return
            // the claim optimistically — a hash mismatch re-runs this
            // function with the REAL stored pointer.
            return claimValue;
          }
          if (ptr.jobId != null && ptr.jobId !== priorJobId) {
            // A concurrent submission claimed the entry after our pre-read
            // — abort; never overwrite another request's live claim.
            return undefined;
          }
          return claimValue;
        });
        if (!claim.committed) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A synthesis for this event is already outstanding or complete',
            statusCode: 409,
          });
        }

        // WR-04 (owner invariant "402 before any durable job/index write"):
        // spend BEFORE the queued job write. A zero-credit attempt restores
        // the pointer to its prior value verbatim (or removes it, for a
        // fresh entryKey's first-ever submission) and answers 402 with NO
        // job node ever having been written — the crash window that could
        // previously strand a phantom `queued` job at the pointer is gone;
        // a crash between the claim and the restore leaves only a dangling
        // pointer, which the staleness-gated dangling-pointer rule above
        // self-heals. 2026-08-03 P2 fix class (routes/reports.ts
        // prep-single precedent): a zero-credit attempt is a REJECTED
        // request, not a failed generation — never `failJob` here, never a
        // spurious `report_failed`, never a phantom refund.
        let synthSpent = false;
        if (!synthFreeAccess) {
          synthSpent = await spendCredit(app.firebase.database, request.uid, synthJobId);
          if (!synthSpent) {
            if (existingPointer) {
              await indexRef.set(existingPointer);
            } else {
              await indexRef.remove();
            }
            return reply.code(402).send({
              error: 'Payment Required',
              message: 'You need report credits — buy a pack to continue',
              statusCode: 402,
            });
          }
        }

        // The durable queued write lands only after the spend has succeeded
        // (or was skipped for free access) — `failJob` covers every
        // post-spend failure from here on.
        await synthJobRef.set(
          reportJobSchema.parse({
            status: 'queued',
            createdAt: synthJobCreatedAt,
            updatedAt: synthJobCreatedAt,
            attempt: 0,
            creditRef: synthJobId,
            reason: 'post_event_synthesis',
            // Post-plan fix (39-10): the spend has already resolved, so the
            // queued record is written WITH its spend fact.
            wasCharged: synthSpent,
          }),
        );

        const generation = await runSynthesisGeneration({
          request,
          jobId: synthJobId,
          creditRef: synthJobId,
          spent: synthSpent,
          jobCreatedAt: synthJobCreatedAt,
          jobAttempt: 0,
          entryKey,
          payload: assembled.payload,
          snapshot: assembled.snapshot,
          claimSet: assembled.claimSet,
        });

        if (!generation.ok) {
          return reply.code(generation.failure.status).send({
            error: generation.failure.error,
            message: generation.failure.message,
            statusCode: generation.failure.status,
          });
        }

        return reply.code(202).send(
          synthesisJobStatusResponseSchema.parse({
            job: {
              jobId: generation.jobId,
              status: generation.status,
              updatedAt: generation.updatedAt,
              resultRef: generation.resultRef,
            },
          }),
        );
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

      const freeAccess = hasFreeReportAccess(request.uid);

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
      // Code review R3-WR-01: the raw row as read, the expected value of the
      // prep branch's compare-and-set queued write below. A copy, so no later
      // in-place change to a returned snapshot value can move it.
      const readJobRow: unknown = existingSnapshot.exists()
        ? structuredClone(existingSnapshot.val())
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
      // Code review R2-CR-01: this request execution's own token, written on
      // the queued and running rows it owns. Failure paths settle the job
      // only while it still carries this token (`settleOwnedJob`).
      const executionId = randomUUID();
      // Code review R3-WR-02: this execution settles (fails the job, or
      // refunds its own lost spend) at most once, across all its paths.
      const settlement: ExecutionSettlement = { settled: false };

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

        // Code review API-CR-01: a pre-paid child's spend fact is the one its
        // bundle recorded at PURCHASE (`wasCharged` on the stored child, set
        // from the bundle debit). Free-access status is a live input (the
        // allowlist and the demo allowlist can both change between purchase
        // and execution), so re-deriving it here could mint a refund for a
        // credit never spent, or withhold one for a credit that was.
        // Code review R2-IN-03: a pre-39-10 child carries no recorded fact, so
        // it reads the bundle's DURABLE purchase record instead —
        // `creditBundleOps/{uid}/{bundleId}`, the marker `spendCredits` wrote
        // (`debited` = charged; `insufficient` or absent = not), the bundle id
        // derived from the child's own slot ref.
        // Code review R3-IN-03 (iteration 3): live free access is NEVER
        // consulted. A paid bundle's children are written only after its
        // `debited` marker, and markers are never deleted, so a child whose
        // bundle has no marker was submitted free. Any fact still unknown
        // below — a stranded `claiming` marker, whose children can only come
        // from a later free submission of the same id, or a row whose id is
        // not a slot ref, which the bundle route never writes — is taken as
        // NOT charged, so a refund can never be minted from it.
        let recordedSpend: boolean | null =
          preSpent && typeof existingJob!.wasCharged === 'boolean' ? existingJob!.wasCharged : null;
        if (preSpent && recordedSpend === null) {
          const bundleId = bundleIdFromSlotRef(jobId);
          if (bundleId !== null) {
            recordedSpend = await readBundleSpendFact(app.firebase.database, request.uid, bundleId);
          }
        }
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
        //
        // Code review R3-WR-01 (iteration 3): the queued write is a
        // COMPARE-AND-SET against the row this request read above. The old
        // plain `.set()` let a duplicate execution that read the job before
        // another execution's running claim erase that claim afterwards and
        // take the job too (the straddle): a bundle child's one credit was
        // then refunded twice, or refunded after the other execution had
        // delivered. Any write to the node since the read — a claim, a
        // re-queue, a settle — aborts this one with a 409, before any spend.
        const queuedRecord = reportJobSchema.parse({
          status: 'queued',
          createdAt: jobCreatedAt,
          updatedAt: Date.now(),
          attempt: jobAttempt,
          creditRef: jobId,
          reason: effectiveReason,
          // API-CR-01: the write replaces the node — a pre-paid child keeps
          // its recorded spend fact across this rewrite (conditional
          // spread: absent on a pre-39-10 child, never null).
          ...(recordedSpend !== null ? { wasCharged: recordedSpend } : {}),
          executionId,
        });
        const queuedWrite = await jobRef.transaction((current) => {
          if (current === null || current === undefined) {
            // The SDK's local cache reads null on a listener-less server even
            // when the node exists. For a fresh job id null IS the row that was
            // read, so the record commits; otherwise null is returned
            // unchanged, forcing the server compare (a node that truly
            // vanished commits that no-op and is reported as not queued).
            return readJobRow === null ? queuedRecord : null;
          }
          return isDeepStrictEqual(current, readJobRow) ? queuedRecord : undefined;
        });
        const queuedRow = queuedWrite.snapshot.val() as { executionId?: unknown } | null;
        if (!queuedWrite.committed || queuedRow?.executionId !== executionId) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A report generation for this job is already in progress',
            statusCode: 409,
          });
        }

        if (preSpent) {
          // Phase 27 (Task 2): the credit for this slot was already spent
          // atomically by the bundle submission (or never spent at all, for
          // an allowlisted uid's bundle) — never spend a second time here.
          // API-CR-01: trust the fact recorded at purchase (R2-IN-03: or the
          // bundle's durable op record). R3-IN-03: an unknown fact is NOT
          // charged — never re-derived from live free access.
          spent = recordedSpend ?? false;
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

        // Post-plan fix (39-10): the queued row above was written before the
        // spend resolved, so record the spend fact on it now.
        await recordSpendFact(jobRef, spent, request.log);

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
        // Code review API-WR-01: this write sits after the spend and before
        // any `failJob` coverage, so — like `recordSpendFact` — it is
        // best-effort: a throw here must never become a 500 that strands a
        // spent credit on a `queued` job.
        try {
          await app.firebase.database
            .ref(`prepReportJobIndex/${request.uid}/${entryKey}/${opponentName}`)
            .set({ jobId, updatedAt: Date.now() });
        } catch (err) {
          request.log.warn({ err }, 'could not write the prep report job index pointer');
        }

        resolveScout = buildPrepResolveScout(binding, {
          uid: request.uid,
          jobId,
          spent,
          jobCreatedAt,
          jobAttempt,
          reason: effectiveReason as PrepReportReason,
          executionId,
          perExecutionSpend: !preSpent,
          settlement,
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
            executionId,
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

        // Post-plan fix (39-10): as the prep branch above — the queued row
        // predates the spend, so the spend fact is recorded on it here.
        await recordSpendFact(jobRef, spent, request.log);

        // Code review R4-WR-01 (closes R3-IN-04 and R4-IN-03): the legacy
        // resolver settles through the same owned settle as every other
        // failure path. The job is failed only while its queued row is still
        // this execution's own, so a crafted duplicate can no longer clobber
        // a delivered legacy record; a lost row still refunds this
        // execution's OWN spend once (`refundLostExecutionSpend`). The latch
        // closes only after the settle resolves, so a settle that throws
        // leaves the post-spend guard free to retry it, and a settle that
        // completed makes the guard's later call a no-op (never a second
        // refund).
        const failLegacyJob = async (): Promise<void> => {
          await failOwnedJob({
            uid: request.uid,
            jobRef,
            executionId,
            from: ['queued'],
            jobId,
            creditRef: jobId,
            spent,
            createdAt: jobCreatedAt,
            attempt: jobAttempt,
            day: null,
            perExecutionSpend: true,
            claimedAt: null,
            settlement,
          });
        };

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
              await failLegacyJob();
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
              await failLegacyJob();
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
                await failLegacyJob();
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
                await failLegacyJob();
                return {
                  ok: false,
                  failure: {
                    status: 429,
                    error: 'Too Many Requests',
                    message: 'start.gg is rate-limiting requests right now — try again shortly',
                  },
                };
              }
              await failLegacyJob();
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
        executionId,
        // R3-WR-02: every execution spends its own credit except a pre-paid
        // bundle child, whose one credit was spent by the bundle for the job.
        perExecutionSpend: !preSpent,
        settlement,
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
          // Phase 39 (plan 39-10, D-21): the terminal cause the paid card
          // captions. Conditional spread — absent on every job without one.
          ...(parsed.data.failureReason ? { failureReason: parsed.data.failureReason } : {}),
          // Post-plan fix (39-10): the spend fact, so the card's refund
          // wording reads the record. `typeof` (not truthiness): `false` is
          // a value; absent/null stays absent (unknown).
          ...(typeof parsed.data.wasCharged === 'boolean'
            ? { wasCharged: parsed.data.wasCharged }
            : {}),
        });
      }

      entries.sort((a, b) => a.opponentName.localeCompare(b.opponentName));
      return { jobs: entries };
    },
  );

  // GET /api/reports/synthesis — Phase 28 (28-07, REV-03): the read-only
  // per-entry synthesis job-status endpoint (mirrors `GET /reports/jobs`
  // immediately above). Registered BEFORE the parameterized `/reports/:id`
  // route below for readability — Fastify's static-route precedence makes
  // this correct regardless of registration order (the literal segment
  // `synthesis` is never shadowed by `:id` matching that string).
  //
  // Deliberately OUTSIDE the activation gate (`prepPaidConfig` is never
  // consulted here) — same Phase 27 rule `GET /reports/jobs` documents:
  // turning the gate off must never strand already-paid work; only NEW
  // purchases (the POST arm) are refused.
  app.get(
    '/reports/synthesis',
    {
      schema: {
        querystring: reportJobsQuerySchema,
        response: {
          200: synthesisJobStatusResponseSchema,
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
      // `{job: null}` either way — no existence signal, mirroring
      // `GET /reports/jobs`'s T-27-40 precedent.
      const indexSnapshot = await app.firebase.database
        .ref(`prepSynthesisJobIndex/${request.uid}/${request.query.entryKey}`)
        .get();
      if (!indexSnapshot.exists()) {
        return { job: null };
      }

      const pointer = indexSnapshot.val() as { jobId?: string } | null;
      const jobId = pointer?.jobId;
      if (!jobId) {
        return { job: null };
      }

      const jobSnapshot = await app.firebase.database
        .ref(`reportJobs/${request.uid}/${jobId}`)
        .get();
      if (!jobSnapshot.exists()) {
        // The index pointer outlived its job node — should not happen
        // under the single-writer-per-job invariant, but one corrupt
        // pointer must never 500 the caller (T-27-43 precedent).
        return { job: null };
      }
      const parsed = reportJobSchema.safeParse(jobSnapshot.val());
      if (!parsed.success) {
        request.log.warn(
          { jobId, issues: parsed.error.issues },
          'skipping stored synthesis job that failed schema validation',
        );
        return { job: null };
      }

      return {
        job: {
          jobId,
          status: parsed.data.status,
          updatedAt: parsed.data.updatedAt,
          ...(parsed.data.resultRef ? { resultRef: parsed.data.resultRef } : {}),
          // Phase 39 (plan 39-10, D-21): as `GET /reports/jobs` above.
          ...(parsed.data.failureReason ? { failureReason: parsed.data.failureReason } : {}),
          // Post-plan fix (39-10): as `GET /reports/jobs` above.
          ...(typeof parsed.data.wasCharged === 'boolean'
            ? { wasCharged: parsed.data.wasCharged }
            : {}),
        },
      };
    },
  );

  // GET /api/reports/practice-plans/:planId — Phase 28 (28-07, REV-03): the
  // stored practice-plan read. `practicePlans/{uid}/{planId}` is uid-scoped
  // — that scoping IS the ownership check (no cross-uid path is
  // constructible), so a foreign or missing planId 404s indistinguishably.
  // Ungated (mirrors `GET /reports/synthesis` above) and parsed through the
  // TOLERANT `storedPracticePlanSchema` (INV-7: every array defaults to
  // `[]` on read, surviving RTDB's empty-array strip).
  app.get(
    '/reports/practice-plans/:planId',
    {
      schema: {
        params: practicePlanParamsSchema,
        response: {
          200: practicePlanResponseSchema,
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
        .ref(`practicePlans/${request.uid}/${request.params.planId}`)
        .get();
      if (!snapshot.exists()) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Practice plan ${request.params.planId} not found`,
          statusCode: 404,
        });
      }

      return { plan: storedPracticePlanSchema.parse(snapshot.val()) };
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
