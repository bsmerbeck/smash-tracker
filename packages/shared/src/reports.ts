import { z } from 'zod';
import { scoutPlayerIdentitySchema } from './startgg.js';

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
 * `scoutReports/{uid}/{pushKey}` — a stored AI-generated report. `player` is
 * the identity `ScoutReportData` resolved for this scout (so past reports
 * remain readable/attributable even if the user later re-scouts and gets a
 * fresher `ScoutReportData`).
 */
export const scoutReportRecordSchema = z.object({
  id: z.string().min(1),
  /** Epoch ms when the report was generated. Server-set. */
  createdAt: z.number().int().nonnegative(),
  /** The Claude model id that generated this report, e.g. "claude-opus-4-8". */
  model: z.string().min(1),
  player: scoutPlayerIdentitySchema,
  report: generatedScoutReportSchema,
});
export type ScoutReportRecord = z.infer<typeof scoutReportRecordSchema>;

/** POST /api/reports request body — same input semantics as POST /api/scout. */
export const generateReportRequestSchema = z.object({
  query: z.string().min(1),
});
export type GenerateReportRequest = z.infer<typeof generateReportRequestSchema>;

/** GET /api/reports/config response — whether the signed-in caller can generate AI reports. */
export const reportsConfigSchema = z.object({
  enabled: z.boolean(),
});
export type ReportsConfig = z.infer<typeof reportsConfigSchema>;
