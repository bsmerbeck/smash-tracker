import { z } from 'zod';
import { entryKeyInputSchema } from './prep.js';
import {
  combineWithLookupSchema,
  scoutPlayerIdentitySchema,
  scoutSourceSchema,
} from './startgg.js';

/**
 * V7-B: AI-generated pre-bracket scouting reports, powered by the Claude API,
 * layered on top of the V7-A scout data layer (`ScoutReportData`). Everything
 * here concerns the STRUCTURED REPORT Claude produces and the stored record
 * wrapping it — the raw data assembly (`ScoutReportData` + the user's own
 * match history) lives in apps/api's `reports/generate.ts`.
 *
 * Kept to plain strings/arrays/objects deliberately: structured outputs
 * (`output_config.format`) don't support JSON Schema min/max/length
 * constraints, so none are added here even where they'd read naturally
 * (e.g. `overview` being "2-4 sentences").
 */

/**
 * The report Claude generates for one scouted opponent. Grounded entirely in
 * the JSON payload assembled server-side (the scout data, the caller's own
 * head-to-head history, aggregate tendencies against similar characters, and
 * any saved opponent note) — see the SYSTEM_PROMPT in reports/generate.ts for
 * the grounding rules enforced on the model.
 */
export const generatedScoutReportSchema = z.object({
  /** 2-4 sentence read on the opponent: who they are, how they play, what stands out. */
  overview: z.string(),
  /** Actionable bullets for how to approach the set. */
  gameplan: z.array(z.string()),
  /**
   * Character-pick strategy (V7-B.1), co-equal in importance with stage
   * strategy: which of the USER'S OWN characters to reach for against this
   * opponent, and when to switch. Never recommends a character the user
   * doesn't demonstrably play — see the SYSTEM_PROMPT grounding rules.
   */
  characterStrategy: z.object({
    /** Which of the user's own characters to reach for, e.g. game-1 pick(s). */
    picks: z.array(z.string()),
    /** Why — grounded in myCharacterRecords vs. the opponent's top characters, plus in-set adjustments (e.g. "Game 1: X; if they swap to Y, counter with Z"). */
    reasoning: z.string(),
  }),
  /** Stage strike/pick strategy, grounded in the opponent's sampled stage results. */
  stageStrategy: z.object({
    /** Stages to strike/ban against this opponent. */
    bans: z.array(z.string()),
    /** Stages to counterpick toward. */
    picks: z.array(z.string()),
    /** Why — tied to the opponent's actual sampled stage performance. */
    reasoning: z.string(),
  }),
  /** Summary of the caller's own history against this specific player; null when there is none. */
  headToHead: z.string().nullable(),
  /** Habits/threats to watch for, drawn from sampled sets and any saved opponent note. */
  watchFor: z.array(z.string()),
  /** Explicit sample-size caveats (e.g. "only 3 games on this character — light sample"). */
  confidenceNotes: z.string(),
});
export type GeneratedScoutReport = z.infer<typeof generatedScoutReportSchema>;

/**
 * Stored-record variant of the generated report — differs from
 * `generatedScoutReportSchema` in two absence-tolerances, both required for
 * reading real RTDB rows back:
 *
 * - `characterStrategy` is OPTIONAL: reports written before V7-B.1 lack the
 *   field entirely. New reports always have it (the model is required to
 *   produce it — see SYSTEM_PROMPT).
 * - `headToHead` is NULLISH (nullable AND optional), not just nullable:
 *   Firebase RTDB deletes null-valued keys on write, so a record persisted
 *   with `headToHead: null` (no head-to-head history — a common, legitimate
 *   model output) comes back with the key ABSENT, and a merely-`.nullable()`
 *   schema rejects it ("expected string, received undefined"), corrupting
 *   the whole stored record. Confirmed against production data (V9-B).
 *   The GENERATION schema deliberately stays `.nullable()` — the model must
 *   still emit the field explicitly; only the stored/read shape tolerates
 *   RTDB having stripped it. This is the general rule for this schema: any
 *   `.nullable()` field in a STORED record must be `.nullish()` here
 *   (`headToHead` is currently the only nullable field in the record shape).
 */
export const storedScoutReportSchema = generatedScoutReportSchema
  .partial({
    characterStrategy: true,
  })
  .extend({
    headToHead: z.string().nullish(),
    // RTDB strips EMPTY ARRAYS from stored objects exactly like it strips
    // null values (2026-08-03 walkthrough P1: five paid reports generated
    // with stageStrategy.bans/picks [] vanished from the library and 500'd
    // on direct reads — the generation schema's required arrays came back
    // ABSENT). Every array field in the stored/read shape defaults to []
    // when the key is missing, restoring the wire round-trip. The
    // GENERATION schema deliberately keeps them required — the model must
    // still emit the fields; only the stored/read shape tolerates RTDB
    // having stripped them.
    gameplan: z.array(z.string()).default([]),
    watchFor: z.array(z.string()).default([]),
    characterStrategy: z
      .object({
        picks: z.array(z.string()).default([]),
        reasoning: z.string(),
      })
      .optional(),
    stageStrategy: z.object({
      bans: z.array(z.string()).default([]),
      picks: z.array(z.string()).default([]),
      reasoning: z.string(),
    }),
  });
export type StoredScoutReport = z.infer<typeof storedScoutReportSchema>;

/**
 * `scoutReports/{uid}/{pushKey}` — a stored AI-generated report. `player` is
 * the identity `ScoutReportData` resolved for this scout (so past reports
 * remain readable/attributable even if the user later re-scouts and gets a
 * fresher `ScoutReportData`). Uses `storedScoutReportSchema` (not
 * `generatedScoutReportSchema` directly) so pre-V7-B.1 records missing
 * `characterStrategy` still round-trip through GET /api/reports.
 */
export const scoutReportRecordSchema = z.object({
  id: z.string().min(1),
  /** Epoch ms when the report was generated. Server-set. */
  createdAt: z.number().int().nonnegative(),
  /** The Claude model id that generated this report, e.g. "claude-opus-4-8". */
  model: z.string().min(1),
  player: scoutPlayerIdentitySchema,
  report: storedScoutReportSchema,
});
export type ScoutReportRecord = z.infer<typeof scoutReportRecordSchema>;

/**
 * Phase 27 (RPT-02, revised wording): "A prep bundle contains exactly three
 * selected opponents, consumes exactly three credits for billable users,
 * and rejects any other selection count." This constant is the ONE place
 * that number is spelled out — `.length(PREP_BUNDLE_SIZE)` below is where
 * the "rejects any other selection count" half is enforced at the schema
 * layer, before any handler code runs.
 */
export const PREP_BUNDLE_SIZE = 3;

/** The two prep-context reasons a `POST /api/reports` request can carry. */
export const prepReportReasonSchema = z.enum(['prep_report', 'prep_bundle']);
export type PrepReportReason = z.infer<typeof prepReportReasonSchema>;

/**
 * POST /api/reports request body — a backward-compatible union (27-CONTEXT.md
 * "Pipeline reuse"):
 *
 * - Legacy (reason absent): same input semantics as POST /api/scout,
 *   including the same optional `source` (V9-B Feature 4) for bare-query
 *   disambiguation between start.gg and parry.gg, and the same optional
 *   `combineWith` (V13) that merges a second-site scout into the report's
 *   data (see `scoutQuerySchema`). `query` is required on this branch —
 *   `.optional()` at the object level exists only so the flattened shape can
 *   also represent the prep branches below; the `.superRefine` restores the
 *   legacy requirement.
 * - `reason: 'prep_report'`: one curated opponent (`entryKey` + `opponentName`).
 * - `reason: 'prep_bundle'`: exactly `PREP_BUNDLE_SIZE` DISTINCT curated
 *   opponents (`entryKey` + `bundleId` + `opponentNames`) — a duplicate
 *   would map two paid slots onto one opponent.
 * - Whenever `reason` is present, `query`/`source`/`combineWith` are
 *   FORBIDDEN outright — not silently ignored. This is a deliberate
 *   correction to RESEARCH Pattern 5, which proposed carrying a per-opponent
 *   `query`: 27-CONTEXT.md locks "the server reloads the stored bindings and
 *   IGNORES client-supplied provider identities", so a caller cannot smuggle
 *   a provider identity the server would otherwise resolve itself.
 *
 * `jobId` (BILL-06/Phase 10) is a client-generated UUID, one per "Generate
 * report" click, used to key the durable `reportJobs/{uid}/{jobId}` state
 * machine for idempotent retries. Optional so an un-updated client
 * (deploy-first) never 400s — the server falls back to a server-generated
 * jobId when absent, same convention as `checkoutRequestSchema.attemptId`.
 *
 * Schema validity is not authorization: the handler must ALSO re-check that
 * the caller owns the brief and that every requested opponent is currently
 * curated on it (RPT-02/RPT-03) — this schema only rejects malformed shapes.
 */
export const generateReportRequestSchema = z
  .object({
    query: z.string().min(1).optional(),
    source: scoutSourceSchema.optional(),
    combineWith: combineWithLookupSchema.optional(),
    jobId: z.string().min(1).optional(),
    reason: prepReportReasonSchema.optional(),
    entryKey: entryKeyInputSchema.optional(),
    opponentName: z.string().min(1).optional(),
    bundleId: z.string().min(1).optional(),
    opponentNames: z.array(z.string().min(1)).length(PREP_BUNDLE_SIZE).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.reason === undefined) {
      if (!value.query) {
        ctx.addIssue({ code: 'custom', message: 'query is required', path: ['query'] });
      }
      return;
    }

    if (value.query !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'query is not allowed on a prep-context request',
        path: ['query'],
      });
    }
    if (value.source !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'source is not allowed on a prep-context request',
        path: ['source'],
      });
    }
    if (value.combineWith !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'combineWith is not allowed on a prep-context request',
        path: ['combineWith'],
      });
    }

    if (value.reason === 'prep_report') {
      if (!value.entryKey) {
        ctx.addIssue({
          code: 'custom',
          message: 'entryKey is required for reason: prep_report',
          path: ['entryKey'],
        });
      }
      if (!value.opponentName) {
        ctx.addIssue({
          code: 'custom',
          message: 'opponentName is required for reason: prep_report',
          path: ['opponentName'],
        });
      }
      if (value.bundleId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'bundleId is not allowed for reason: prep_report',
          path: ['bundleId'],
        });
      }
      if (value.opponentNames !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'opponentNames is not allowed for reason: prep_report',
          path: ['opponentNames'],
        });
      }
    }

    if (value.reason === 'prep_bundle') {
      if (!value.entryKey) {
        ctx.addIssue({
          code: 'custom',
          message: 'entryKey is required for reason: prep_bundle',
          path: ['entryKey'],
        });
      }
      if (!value.bundleId) {
        ctx.addIssue({
          code: 'custom',
          message: 'bundleId is required for reason: prep_bundle',
          path: ['bundleId'],
        });
      }
      if (!value.opponentNames) {
        ctx.addIssue({
          code: 'custom',
          message: `opponentNames (exactly ${PREP_BUNDLE_SIZE}) is required for reason: prep_bundle`,
          path: ['opponentNames'],
        });
      } else if (new Set(value.opponentNames).size !== value.opponentNames.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'opponentNames must be distinct',
          path: ['opponentNames'],
        });
      }
      if (value.opponentName !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'opponentName is not allowed for reason: prep_bundle',
          path: ['opponentName'],
        });
      }
    }
  });
export type GenerateReportRequest = z.infer<typeof generateReportRequestSchema>;

/**
 * BILL-06/MEAS-03 (Phase 10): the durable report-job state machine.
 * `reportJobs/{uid}/{jobId}` — turns synchronous, state-less report
 * generation into an idempotent, resumable `queued -> running ->
 * succeeded | failed | refunded` job. `creditRef` is set to the jobId itself
 * (a client-generated, non-PII UUID) so `credit_spent`/`credit_refunded`
 * ledger entries and the `report_*` B events all correlate on the same key.
 * `resultRef` (the `scoutReports/{uid}` push key) is present only once the
 * job reaches `succeeded`.
 *
 * Single-writer-per-job invariant: only the request that CREATED a jobId
 * (i.e. wrote its `queued` state) ever writes to that job's node again —
 * there is no concurrent-writer scenario for a given `{uid, jobId}` pair, so
 * these transitions are plain sequential writes, not `.transaction()`s (the
 * stuck-job sweep, a later plan, is the one other writer, and it only acts
 * on jobs that have gone stale, never racing a live in-flight request).
 */
export const reportJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'refunded',
]);
export type ReportJobStatus = z.infer<typeof reportJobStatusSchema>;

export const reportJobSchema = z.object({
  status: reportJobStatusSchema,
  /** Epoch ms — when this job's `queued` state was first written. */
  createdAt: z.number(),
  /** Epoch ms — updated on every state transition; drives the stuck-job sweep's staleness check. */
  updatedAt: z.number(),
  /** Retry/resume counter — incremented if a job is ever resumed from a non-terminal state. */
  attempt: z.number().int().min(0),
  /** The credit-ledger correlation key for this job — always equal to the jobId. */
  creditRef: z.string(),
  /** The `scoutReports/{uid}` push key once generation succeeds; absent until then. */
  resultRef: z.string().optional(),
  /**
   * Phase 27 (D-14): `.nullish()` (not `.optional()`) because this is a
   * STORED record shape and RTDB strips absent values on write/read. This
   * is the ONLY prep context ever stored on the job node — no entryKey, no
   * opponent name, and no provider ID ever lands here (Information
   * Disclosure mitigation).
   */
  reason: prepReportReasonSchema.nullish(),
});
export type ReportJob = z.infer<typeof reportJobSchema>;

/**
 * GET /api/reports/jobs response entry — one row per prep child job, keyed
 * by the curated opponent it belongs to. `resultRef` mirrors
 * `reportJobSchema.resultRef` and is present only once `status` reaches
 * `succeeded`.
 */
export const prepReportJobStatusEntrySchema = z.object({
  opponentName: z.string().min(1),
  jobId: z.string().min(1),
  status: reportJobStatusSchema,
  updatedAt: z.number(),
  resultRef: z.string().optional(),
});
export type PrepReportJobStatusEntry = z.infer<typeof prepReportJobStatusEntrySchema>;

/** GET /api/reports/jobs response — single-or-batch job-status read for the prep paid card's polling hook. */
export const prepReportJobsResponseSchema = z.object({
  jobs: z.array(prepReportJobStatusEntrySchema),
});
export type PrepReportJobsResponse = z.infer<typeof prepReportJobsResponseSchema>;

/**
 * The 202 body a `reason: 'prep_bundle'` submission returns. A bundle
 * submission does NOT return reports — it returns the three pre-paid child
 * job ids (already charged, one per `slot`) the client then executes and
 * polls via `GET /api/reports/jobs`.
 */
export const prepBundleAcceptedResponseSchema = z.object({
  bundleId: z.string().min(1),
  jobs: z.array(
    z.object({
      opponentName: z.string().min(1),
      jobId: z.string().min(1),
      slot: z.number().int().min(1).max(PREP_BUNDLE_SIZE),
    }),
  ),
});
export type PrepBundleAcceptedResponse = z.infer<typeof prepBundleAcceptedResponseSchema>;

/**
 * GET /api/reports/config response — whether the signed-in caller can
 * generate AI reports. `enabled` is true when the caller is allowlisted
 * (`REPORTS_ALLOWED_UIDS`, free/unlimited) OR when Stripe billing (V7-C) is
 * configured on this deployment (meaning anyone can buy credits and
 * generate) — kept for back-compat with pre-V7-C clients that only look at
 * `enabled`. `freeAccess`/`billingEnabled` are additive and OPTIONAL so old
 * clients (and old cached responses) parsing this shape don't break.
 */
export const reportsConfigSchema = z.object({
  enabled: z.boolean(),
  /** True when the caller is on `REPORTS_ALLOWED_UIDS` — free/unlimited generation. */
  freeAccess: z.boolean().optional(),
  /** True when this deployment has Stripe configured, i.e. non-allowlisted callers can buy credits. */
  billingEnabled: z.boolean().optional(),
});
export type ReportsConfig = z.infer<typeof reportsConfigSchema>;
