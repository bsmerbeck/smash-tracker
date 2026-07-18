import { z } from 'zod';
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
 * POST /api/reports request body — same input semantics as POST /api/scout,
 * including the same optional `source` (V9-B Feature 4) for bare-query
 * disambiguation between start.gg and parry.gg, and the same optional
 * `combineWith` (V13) that merges a second-site scout into the report's data
 * (see `scoutQuerySchema`). `jobId` (BILL-06/Phase 10) is a client-generated
 * UUID, one per "Generate report" click, used to key the durable
 * `reportJobs/{uid}/{jobId}` state machine for idempotent retries. Optional
 * so an un-updated client (deploy-first) never 400s — the server falls back
 * to a server-generated jobId when absent, same convention as
 * `checkoutRequestSchema.attemptId`.
 */
export const generateReportRequestSchema = z.object({
  query: z.string().min(1),
  source: scoutSourceSchema.optional(),
  combineWith: combineWithLookupSchema.optional(),
  jobId: z.string().min(1).optional(),
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
});
export type ReportJob = z.infer<typeof reportJobSchema>;

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
