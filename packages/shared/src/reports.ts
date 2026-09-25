import { z } from 'zod';
import { CLAIM_PREDICATES } from './evidence/claims.js';
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

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-06, D-08/RPT-10): the PERSISTED claim contracts.
//
// Every field below is ADDITIVE and `.nullish()` on the stored records:
// ABSENCE means a legacy/unvalidated record — there is no backfill, no
// migration and no `createdAt` cutoff anywhere in the read path.
//
// RTDB write semantics these shapes are built for (reviews C1-H5 + C2-H1):
// RTDB deletes a null-valued member FIRST, the empty object that deletion
// leaves behind is then deleted too, cascading upward to the first non-empty
// parent; an empty array or `{}` written directly is deleted the same way;
// and an array carrying a `null` member reads back sparse/short. So:
// - every collection is a KEYED MAP, never a positional array of nullable
//   members;
// - `.nullish()` (or a `.default`) reaches EVERY level that can vanish — not
//   only the four top-level maps (`claims`, `sections`, `actions`, `rows`),
//   but `subject` itself and each axis inside it: a `recent_form` or
//   `cohort_disclosure` claim carries all four axes `null`, RTDB deletes all
//   four keys, then deletes `subject`;
// - a required `z.record(...)` would fail its own schema on the cold-start
//   state (an empty map reads back ABSENT) — the empty-OBJECT sibling of the
//   2026-08-03 empty-ARRAY incident `storedScoutReportSchema` records below.
// ---------------------------------------------------------------------------

const confidenceTierRecordSchema = z.enum(['low', 'medium', 'high']);

/** The persisted `SampleMeta` (`evidence/types.ts`). `dateRange`/`confidenceTier` are `null` on an empty or sub-floor sample, so both are `.nullish()`; every other member is a number or literal RTDB keeps. */
const sampleMetaRecordSchema = z.object({
  rawSampleSize: z.number().int().nonnegative(),
  eligibleDenominator: z.number().int().nonnegative(),
  knownFieldCoverage: z.number(),
  dateRange: z.object({ firstMs: z.number(), lastMs: z.number() }).nullish(),
  refreshedAt: z.number(),
  evidencePolicyVersion: z.number().int(),
  recencyTreatment: z.literal('unweighted'),
  confidenceTier: confidenceTierRecordSchema.nullish(),
});

/** The persisted `ClaimSubject` — every axis `.nullish()`, and the whole object `.nullish()` wherever it is used (an axis-free subject vanishes entirely on write). */
export const claimSubjectRecordSchema = z.object({
  myFighterId: z.number().int().nullish(),
  opponentFighterId: z.number().int().nullish(),
  stageId: z.number().int().nullish(),
  opponentTag: z.string().nullish(),
});

/** The persisted `ClaimValue` — the five closed arms, none of which carries a nullable member. */
const claimValueRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('record'),
    wins: z.number().int(),
    losses: z.number().int(),
    games: z.number().int(),
  }),
  z.object({ kind: z.literal('rate'), numerator: z.number().int(), denominator: z.number().int() }),
  z.object({ kind: z.literal('count'), count: z.number().int() }),
  z.object({ kind: z.literal('entity'), entityKind: z.string(), entityId: z.string() }),
  z.object({ kind: z.literal('abstained'), gamesNeeded: z.number().int() }),
]);

/**
 * The persisted mirror of the shared `ClaimAtom` (`evidence/claims.ts`).
 * `evidenceIds` is an array of non-empty STRINGS (safe — it is arrays of
 * NULLABLE members RTDB shreds) with a `[]` default for the same empty-array
 * reason every stored array here has one. `subject` is `.nullish()` as a
 * WHOLE (review C2-H1), `tier` is `null` on an abstained claim.
 */
export const claimAtomSchema = z.object({
  id: z.string().min(1),
  predicate: z.enum(CLAIM_PREDICATES),
  subject: claimSubjectRecordSchema.nullish(),
  value: claimValueRecordSchema,
  claimKind: z.enum(['fact', 'inference', 'recommendation']),
  evidenceIds: z.array(z.string().min(1)).default([]),
  tier: confidenceTierRecordSchema.nullish(),
  policyVersion: z.number().int(),
  sample: sampleMetaRecordSchema,
});
export type ClaimAtomRecord = z.infer<typeof claimAtomSchema>;

/** One persisted evidence row (`EvidenceRow`, `evidence/snapshot.ts`) — the same vanishing rules as a claim's subject. */
export const evidenceRowRecordSchema = z.object({
  predicate: z.enum(CLAIM_PREDICATES),
  subject: claimSubjectRecordSchema.nullish(),
  value: claimValueRecordSchema,
  sample: sampleMetaRecordSchema,
});

/** The persisted `CohortComposition` (`evidence/cohort.ts`) — the two labels are `null` on a single-bucket or empty sample. */
const cohortRecordSchema = z.object({
  online: z.number().int(),
  offline: z.number().int(),
  unspecified: z.number().int(),
  manual: z.number().int(),
  startgg: z.number().int(),
  parrygg: z.number().int(),
  mixedContext: z.boolean(),
  minorityShare: z.number(),
  minorityLabel: z.string().nullish(),
  majorityLabel: z.string().nullish(),
});

/**
 * `evidenceSnapshots/{uid}/{snapshotId}` (D-05; written create-if-absent by
 * plan 39-07, content-addressed by the API's `snapshotIdFor`). `rows` is a
 * keyed map and is `.nullish()`: a snapshot over an EMPTY evidence set is an
 * expected state, not an error, and RTDB deletes a `{}` it is written as.
 * `createdAt` is the write time a writer may add; `refreshedAt` mirrors the
 * in-memory `EvidenceSnapshot`.
 */
export const evidenceSnapshotRecordSchema = z.object({
  policyVersion: z.number().int(),
  claimSchemaVersion: z.number().int(),
  refreshedAt: z.number(),
  createdAt: z.number().int().nonnegative().nullish(),
  cohort: cohortRecordSchema,
  rows: z.record(z.string(), evidenceRowRecordSchema).nullish(),
  matchIdDigest: z.object({ count: z.number().int().nonnegative(), hash: z.string() }),
});
export type EvidenceSnapshotRecord = z.infer<typeof evidenceSnapshotRecordSchema>;

/** The stored validation block (D-08): present only on a record that PASSED validation; absent means unvalidated/legacy. */
export const reportValidationSchema = z.object({
  status: z.literal('passed'),
  policyVersion: z.number().int(),
  snapshotId: z.string(),
  claimSchemaVersion: z.number().int(),
});

/** One stored report section: the ordered claim ids it references and its connective prose (`''` when the validator stripped it). `claimIds` defaults to `[]` — an empty list vanishes on write. */
export const storedReportSectionSchema = z.object({
  claimIds: z.array(z.string()).default([]),
  connective: z.string(),
});

/** The three fixed D-12 action slot names — the only keys the stored `actions` map may carry. */
export const ACTION_SLOT_KEYS = ['action1', 'action2', 'action3'] as const;

/** One stored action slot — mirrors the model selection's `{ actionId, claimId }`. */
export const storedActionSlotSchema = z.object({
  actionId: z.string().min(1),
  claimId: z.string().nullish(),
});

/**
 * The Phase 39 additive fields shared by BOTH stored report schemas. Every
 * one is `.nullish()`: written by conditional spread, never as an explicit
 * null, and absent on every legacy record.
 */
const claimRecordFields = {
  claimSchemaVersion: z.number().int().nullish(),
  validation: reportValidationSchema.nullish(),
  /** Keyed map claim id -> claim atom. `.nullish()` — a cold-start `{}` reads back ABSENT (C1-H5). */
  claims: z.record(z.string(), claimAtomSchema).nullish(),
  /** Keyed map section name -> `{ claimIds, connective }` — what plan 39-09 renders claim-anchored bullets from. */
  sections: z.record(z.string(), storedReportSectionSchema).nullish(),
  /** Keyed slot map (`action1`/`action2`/`action3`): a slot the model left empty simply has no key, never a shredded positional null. */
  actions: z.partialRecord(z.enum(ACTION_SLOT_KEYS), storedActionSlotSchema).nullish(),
  /**
   * D-20 / review C3-M1: how many sections' prose the validator STRIPPED.
   * Persisted because a prose fault strips a section without dropping a
   * claim (plan 39-04's penalty decoupling), so `droppedClaimCount` stays
   * zero and `report_claims_dropped` never fires for it — without this
   * field systematic prose stripping is invisible at every rate. Derived
   * from the validator outcome's `strippedSectionIds.length`; absent means
   * zero (never written as an explicit `0`).
   */
  strippedSectionCount: z.number().int().nonnegative().nullish(),
};

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
    /** Count of claims the validator dropped, if any (plan 39-07) — the same definition the practice plan carries. */
    droppedClaimCount: z.number().int().nonnegative().nullish(),
    ...claimRecordFields,
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

/**
 * The prep/synthesis-context reasons a `POST /api/reports` request can
 * carry. Widened in Phase 28 (28-02) to add `post_event_synthesis` — this
 * enum is reused verbatim by `reportJobSchema.reason`, so a stored job
 * carrying the new literal is read by an old (pre-28) server via the
 * jobs-GET `safeParse` (routes/reports.ts:1528-1535), which simply skips an
 * unrecognized reason rather than 500ing. This is why the API must deploy
 * before the web app for this feature (28-RESEARCH.md Pitfall 8, A4).
 */
export const prepReportReasonSchema = z.enum([
  'prep_report',
  'prep_bundle',
  'post_event_synthesis',
]);
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
 * - `reason: 'post_event_synthesis'` (28-02): `entryKey` only. Grounding for
 *   a synthesis is the caller's OWN stored annotations for that entry,
 *   resolved server-side from `entryKey` alone — there is deliberately no
 *   field on this branch through which a client could inject evidence, an
 *   opponent identity, or a citation target. `opponentName`, `bundleId`, and
 *   `opponentNames` are all FORBIDDEN on this branch (the synthesis arm has
 *   no opponent concept).
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
 * `entryKeyInputSchema` on `jobId` and `bundleId` (28-review CR-01 item 4,
 * WR-06 template): both values are interpolated straight into
 * `database.ref(...)` paths — `reportJobs/{uid}/{jobId}`,
 * `creditBundleOps/{uid}/{bundleId}`, and the bundle children
 * `reportJobs/{uid}/{bundleId}:{slot}` — so RTDB-reserved characters
 * (`. # $ [ ] /` and control chars) must 400 at the schema boundary rather
 * than throw synchronously inside the SDK as a 500. Client UUIDs and
 * bundleSlotRef ids always satisfy the validator (`:` is RTDB-legal). The
 * validation is deliberately FIELD-level, not per-reason in superRefine:
 * the legacy (no-reason) arm writes `reportJobs/{uid}/{jobId}` too
 * (`request.body.jobId ?? randomUUID()`), the identical 500 vector. The
 * post_event_synthesis arm still 400s on any client jobId — a field-level
 * failure just reports the character message instead of the "not allowed"
 * one. The implicit max(200) bound (previously unbounded here) is
 * intentional: real clients mint 36-char UUIDs, and it matches entryKey's
 * own bound.
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
    jobId: entryKeyInputSchema.optional(),
    reason: prepReportReasonSchema.optional(),
    entryKey: entryKeyInputSchema.optional(),
    opponentName: z.string().min(1).optional(),
    bundleId: entryKeyInputSchema.optional(),
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

    if (value.reason === 'post_event_synthesis') {
      if (!value.entryKey) {
        ctx.addIssue({
          code: 'custom',
          message: 'entryKey is required for reason: post_event_synthesis',
          path: ['entryKey'],
        });
      }
      // CR-01 (Phase 28 review): unlike `prep_report` (whose retry contract
      // is BUILT on a client-generated jobId), a synthesis jobId is ALWAYS
      // server-minted — the route's 402-restore assumes the freshly minted
      // id can never name a pre-existing job node, so a client-supplied one
      // must be rejected at the schema boundary, never silently accepted.
      if (value.jobId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'jobId is not allowed for reason: post_event_synthesis',
          path: ['jobId'],
        });
      }
      if (value.opponentName !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'opponentName is not allowed for reason: post_event_synthesis',
          path: ['opponentName'],
        });
      }
      if (value.bundleId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'bundleId is not allowed for reason: post_event_synthesis',
          path: ['bundleId'],
        });
      }
      if (value.opponentNames !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'opponentNames is not allowed for reason: post_event_synthesis',
          path: ['opponentNames'],
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
/** Phase 39 (plan 39-06): why a report job failed — the four causes, `'validation'` being D-07's new one. */
export const reportFailureReasonSchema = z.enum([
  'refusal',
  'truncated',
  'unparseable',
  'validation',
]);
export type ReportFailureReason = z.infer<typeof reportFailureReasonSchema>;

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
  // TRAP (39-RESEARCH Pitfall 1): `failureReason` is NOT `reason` above —
  // `reason` is the job KIND (consumed by bundle-slot detection and the
  // synthesis retry window) and must never gain a failure-cause member — and
  // it is NOT `ReportGenerationError`'s constructor argument either. It is
  // the WHY of a failed/refunded job, `.nullish()` because it is a stored
  // field written by conditional spread (plan 39-07).
  failureReason: reportFailureReasonSchema.nullish(),
  /**
   * Post-plan fix (39-10, owner decision 2026-09-25): whether THIS job took a
   * credit — the exact `spent` fact the route's money path acts on (true only
   * after a successful `spendCredit`/`spendCredits` debit, or for a pre-paid
   * bundle child), written at spend time and carried on every later
   * whole-node `.set()`. It lets the web word a failure truthfully ("refunded"
   * vs "no credit was used") without consulting the viewer's CURRENT
   * free-access status, which can change after the job ran. A RECORD of the
   * money path, never an input to it: nothing reads it to decide a spend or a
   * refund. `.nullish()` — older jobs (and any writer that predates this
   * field) have no value, and readers must treat absence as unknown, never
   * as false.
   */
  wasCharged: z.boolean().nullish(),
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
  /**
   * Phase 39 (plan 39-10, D-21): the job's failure CAUSE, projected from
   * `reportJobSchema.failureReason` so the paid prep card can caption a
   * validation failure. Present only when the stored job carries one.
   * Deliberately an OPEN string on the wire, not the enum: a cause added
   * later must never fail an older client's whole status parse — the client
   * allowlists the single value it captions and renders nothing for any other.
   */
  failureReason: z.string().min(1).optional(),
  /**
   * Post-plan fix (39-10): `reportJobSchema.wasCharged`, projected so the paid
   * card can word a failure truthfully. Present only when the stored job
   * carries a boolean; absent means UNKNOWN (an older job), never "not charged".
   */
  wasCharged: z.boolean().optional(),
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
 * Phase 28 (28-02, REV-03): the post-event practice-plan generation shape —
 * the STRICT model-output schema used with `zodOutputFormat` (28-06).
 * Grounded entirely in the caller's OWN stored annotations for the entry
 * (resolved server-side from `entryKey`), never in opponent data — a
 * synthesis has no opponent concept.
 *
 * `evidence` is markdown carrying `{{cite:matchId=...;seconds=...;label=...}}`
 * tokens (the citation grammar defined in `coachingReview.ts`) — schemas
 * here store BODIES containing tokens, never parsed token objects
 * (self-contained snapshot stance, mirroring `storedScoutReportSchema`).
 * A `focusArea` is a SUBSTANTIVE CLAIM: post-generation validation (28-06)
 * drops any focusArea that lacks at least one citation token resolving by
 * set-membership to the server-assembled evidence, and a plan whose every
 * focusArea is dropped fails the job and refunds (owner invariants 1-2).
 */
export const generatedPracticePlanSchema = z.object({
  /** Overview prose for the whole plan; citations welcome but not required. */
  summary: z.string().min(1),
  focusAreas: z
    .array(
      z.object({
        title: z.string().min(1),
        /** Markdown carrying `{{cite:...}}` tokens grounding this claim. */
        evidence: z.string().min(1),
        drills: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});
export type GeneratedPracticePlan = z.infer<typeof generatedPracticePlanSchema>;

/**
 * Stored/read variant of `generatedPracticePlanSchema` — mirrors the
 * `storedScoutReportSchema` split exactly (2026-08-03 P1 lesson): RTDB
 * strips EMPTY ARRAYS from stored objects exactly like it strips null
 * values, so EVERY array field here defaults to an empty array when the
 * key is missing, and every optional stored field is `.nullish()`. The
 * GENERATION schema deliberately keeps its arrays required/min-length —
 * the model must still emit them; only the stored/read shape tolerates
 * RTDB having stripped them (INV-7).
 */
export const storedPracticePlanSchema = z.object({
  entryKey: z.string().min(1),
  /** Epoch ms when the plan was generated. Server-set. */
  createdAt: z.number().int().nonnegative(),
  summary: z.string().min(1),
  focusAreas: z
    .array(
      z.object({
        title: z.string().min(1),
        evidence: z.string().min(1),
        drills: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
  /** Count of focusAreas dropped by 28-06's citation validation, if any. */
  droppedClaimCount: z.number().int().nonnegative().nullish(),
  ...claimRecordFields,
});
export type StoredPracticePlan = z.infer<typeof storedPracticePlanSchema>;

/**
 * GET /api/reports/synthesis?entryKey=... response — the job-status contract
 * for a `post_event_synthesis` submission. `job: null` means no synthesis
 * has ever been submitted for this entry (or the pointer was pruned). One
 * job per entryKey: `prepSynthesisJobIndex/{uid}/{entryKey}` always names
 * the LATEST job — a retry-after-refund overwrites it, so the UI always
 * resolves to exactly one current job for a given entry.
 */
export const synthesisJobStatusResponseSchema = z.object({
  job: z
    .object({
      jobId: z.string().min(1),
      status: reportJobStatusSchema,
      updatedAt: z.number(),
      resultRef: z.string().optional(),
      /** Phase 39 (plan 39-10, D-21): as `prepReportJobStatusEntrySchema.failureReason` — an open string, present only when the stored job carries one. */
      failureReason: z.string().min(1).optional(),
      /** Post-plan fix (39-10): as `prepReportJobStatusEntrySchema.wasCharged` — absent means unknown. */
      wasCharged: z.boolean().optional(),
    })
    .nullable(),
});
export type SynthesisJobStatusResponse = z.infer<typeof synthesisJobStatusResponseSchema>;

/** GET /api/reports/practice-plans/:planId response — a stored practice plan read. */
export const practicePlanResponseSchema = z.object({
  plan: storedPracticePlanSchema,
});
export type PracticePlanResponse = z.infer<typeof practicePlanResponseSchema>;

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
