import { z } from 'zod';
import {
  ACTION_ID_VOCABULARY,
  ACTION_SLOT_KEYS,
  CLAIM_ID_VOCABULARY,
  CLAIM_SCHEMA_VERSION,
  resolveSubjectDisplayName,
  type ClaimAtom,
  type ClaimAtomRecord,
  type ClaimSubject,
  type ReportSelectionOutput,
  type StoredScoutReport,
} from '@smash-tracker/shared';

/**
 * Phase 39 (plan 39-06, D-01/RPT-05): the model's output schema. The model
 * no longer AUTHORS a report — it SELECTS engine-issued claims by id and
 * writes the connective prose between them. Every number, stage, character
 * and confidence phrase the app displays comes from a claim the engine
 * built; the schema makes it structurally impossible for the model to put a
 * number in a field the app will render.
 *
 * Constraints the API does NOT enforce (AI-SPEC §3 Pitfall 2): the SDK strips
 * `maxItems`/`minItems`, `minimum`/`maximum` and `minLength`/`maxLength`
 * from the JSON Schema it sends and validates them client-side only. The
 * design therefore depends on none of them for the MODEL's behaviour:
 *
 * - "at most three actions" is STRUCTURAL — three named nullable slots, no
 *   array — so a fourth action is unrepresentable rather than rejected;
 * - the claim-id space is closed by a Zod `enum` over the FIXED
 *   `CLAIM_ID_VOCABULARY` (identical for every job, so the emitted schema is
 *   byte-identical and the provider's 24-hour schema-compilation cache is
 *   hit); whether an id was actually ISSUED for this job is the validator's
 *   rule R1 (plan 39-04), never a per-job enum.
 *
 * FINDING (plan 39-06, proven offline in `claimSelection.test.ts`): the
 * installed `@anthropic-ai/sdk` (0.110.0) `zodOutputFormat` helper does NOT
 * forward `enum` as a JSON-Schema keyword — its `transformJSONSchema` folds
 * every key it does not recognise into the node's `description` as
 * `{enum: [...]}`. The API supports `enum`; this helper does not send it. So
 * today the vocabulary reaches the model as a description, and is ENFORCED
 * client-side: an out-of-vocabulary id fails the Zod parse inside
 * `messages.parse` (an `AnthropicError`, handled by the route's existing
 * catch-all `failJob` branch) and an in-vocabulary but unissued id is R1.
 * Restoring a sent `enum` (an SDK upgrade, or post-processing the helper's
 * output) is a request-shape change on a live money path and is recorded as
 * an owner decision, not made here.
 */

/**
 * One named report section: which issued claims it references (order = the
 * model's emphasis) and the connective prose written around them.
 *
 * `connective: z.string().min(1)` is the ONE deliberate exception to the
 * "no design dependency on a provider-stripped constraint" rule above, and
 * it must not be deleted as an unenforced constraint. The provider strips
 * `minLength` from the emitted JSON Schema, so the MODEL is not held to it —
 * but OUR Zod schema still runs when the SDK parses the response
 * (`@anthropic-ai/sdk/helpers/zod`'s `parse` calls `safeParse` and throws an
 * `AnthropicError` on failure; `lib/parser.js` rethrows it from
 * `client.messages.parse`). An empty connective therefore never reaches the
 * store step: it lands on the route's EXISTING catch-all failure branch in
 * `runReportGeneration` — one `failJob` call (its existing refund), then
 * rethrow — exactly the path any schema-invalid model output takes today.
 * No new failure branch exists on the money path; what `.min(1)` buys is
 * that `projectScoutSelection` below never has to invent prose for an empty
 * section, which is what makes it TOTAL.
 */
export const claimSelectionSectionSchema = z.object({
  claimIds: z.array(z.enum(CLAIM_ID_VOCABULARY)),
  connective: z.string().min(1),
});

/**
 * One of the three fixed D-12 action slots: the engine-ranked candidate the
 * model chose, and the claim it rests on. Mirrors plan 39-04's
 * `ReportSelectionAction` exactly (the claim reference is independently
 * nullable — an action resting on no claim is the validator's rule R8).
 */
const claimSelectionActionSchema = z.object({
  actionId: z.enum(ACTION_ID_VOCABULARY),
  claimId: z.enum(CLAIM_ID_VOCABULARY).nullable(),
});

/**
 * The claim-selection output schema passed to `zodOutputFormat` in
 * `generate.ts`. Its shape is plan 39-04's `ReportSelectionOutput` exactly —
 * sections under a named `sections` object (an OBJECT, never a positional
 * array: an array of nullable members is the RTDB null-stripping trap the
 * moment the shape is persisted) plus `action1`/`action2`/`action3` — so the
 * parser and the validator cannot drift (see the compile-time assertion
 * below). The three sections are the three legacy prose fields the stored
 * record keeps: `overview`, `gameplan`, `watchFor`.
 */
export const claimSelectionSchema = z.object({
  sections: z.object({
    overview: claimSelectionSectionSchema,
    gameplan: claimSelectionSectionSchema,
    watchFor: claimSelectionSectionSchema,
  }),
  action1: claimSelectionActionSchema.nullable(),
  action2: claimSelectionActionSchema.nullable(),
  action3: claimSelectionActionSchema.nullable(),
});
export type ClaimSelection = z.infer<typeof claimSelectionSchema>;

/** The three named sections, in the order the stored record's legacy fields are derived from them. */
export const CLAIM_SELECTION_SECTION_IDS = ['overview', 'gameplan', 'watchFor'] as const;
export type ClaimSelectionSectionId = (typeof CLAIM_SELECTION_SECTION_IDS)[number];

/**
 * Compile-time binding (plan 39-06 Task 1): the parsed model output must be
 * assignable to the validator's input type, so a drift between the parser
 * and `validateReportOutput` is a TYPECHECK failure, never a runtime
 * surprise. Never read at runtime.
 */
export const CLAIM_SELECTION_IS_REPORT_SELECTION_OUTPUT: (
  selection: ClaimSelection,
) => ReportSelectionOutput = (selection) => selection;

export interface ProjectScoutSelectionInput {
  selection: ClaimSelection;
  /**
   * The claims the projection may draw ENGINE-derived specifics from. Plan
   * 39-06 passes the ISSUED claim set (no validator exists yet); plan 39-07
   * re-points this at the claims that SURVIVED validation.
   */
  claims: readonly ClaimAtom[];
  /** Sections whose prose the validator stripped (D-20) — projected as empty prose, never re-derived. */
  strippedSectionIds?: readonly string[];
}

/** De-duplicates stage names in first-seen (claim) order — one stage never appears twice in one list. */
function uniqueInOrder(names: readonly string[]): string[] {
  return Array.from(new Set(names));
}

/**
 * Stage names of the `stage_record` claims whose recorded value is a
 * LOSING (`bans`) or WINNING (`picks`) record on a KNOWN stage, in claim
 * (rank) order. Names come from plan 39-04's `resolveSubjectDisplayName` —
 * the SAME resolver the prose lint builds its licensed-entity set from and
 * the model-facing payload's `displayName` uses (review C2-M6) — never a
 * local stage lookup and never the first-seen stored `map.name`.
 */
function stageNamesWhere(claims: readonly ClaimAtom[], outcome: 'losing' | 'winning'): string[] {
  const names: string[] = [];
  for (const claim of claims) {
    if (claim.predicate !== 'stage_record' || claim.subject.stageId === null) {
      continue;
    }
    if (claim.value.kind !== 'record') {
      continue;
    }
    const { wins, losses } = claim.value;
    const matches = outcome === 'losing' ? losses > wins : wins > losses;
    if (matches) {
      names.push(resolveSubjectDisplayName('stage', claim.subject.stageId));
    }
  }
  return uniqueInOrder(names);
}

/**
 * The C1-B1 projection: a claim selection plus the claims it may draw on,
 * projected onto a record the UNCHANGED `storedScoutReportSchema` accepts.
 * Pure and TOTAL — never throws, never calls a model, never invents a
 * sentence. The mapping:
 *
 * | stored field            | source                                                      |
 * |-------------------------|-------------------------------------------------------------|
 * | `overview`              | `sections.overview.connective` (`''` when stripped)          |
 * | `gameplan`              | `[sections.gameplan.connective]` (`[]` when stripped)        |
 * | `watchFor`              | `[sections.watchFor.connective]` (`[]` when stripped)        |
 * | `stageStrategy.bans`    | ENGINE: losing `stage_record` claims, resolved stage names   |
 * | `stageStrategy.picks`   | ENGINE: winning `stage_record` claims, same resolver         |
 * | `stageStrategy.reasoning` | `sections.gameplan.connective` (`''` when stripped)        |
 * | `characterStrategy`     | OMITTED (optional on the stored schema)                     |
 * | `headToHead`            | OMITTED (`.nullish()`; the claim renders from the claim set) |
 * | `confidenceNotes`       | `''` — D-03 moved confidence language onto each claim's tier |
 * |                         | phrase, rendered by the app through i18n; the API composes  |
 * |                         | no English sentence here                                    |
 *
 * Why the legacy prose fields still exist: an un-migrated reader — the
 * stored-record schema, the 200 response, `apps/web/src/pages/Scout/reportMarkdown.ts`
 * and the print/PDF path — keeps working unchanged, while plan 39-09's
 * claim-anchored rendering reads the claim set instead. The engine-derived
 * `stageStrategy` is strictly MORE grounded than the model-written one it
 * replaces: it is D-01 applied to a field that previously came from prose.
 */
export function projectScoutSelection(input: ProjectScoutSelectionInput): StoredScoutReport {
  const { selection, claims } = input;
  const stripped = new Set(input.strippedSectionIds ?? []);
  const proseOf = (sectionId: ClaimSelectionSectionId): string | null =>
    stripped.has(sectionId) ? null : selection.sections[sectionId].connective;

  const overview = proseOf('overview');
  const gameplan = proseOf('gameplan');
  const watchFor = proseOf('watchFor');

  const actions = persistActions(selection);

  return {
    overview: overview ?? '',
    gameplan: gameplan === null ? [] : [gameplan],
    watchFor: watchFor === null ? [] : [watchFor],
    stageStrategy: {
      bans: stageNamesWhere(claims, 'losing'),
      picks: stageNamesWhere(claims, 'winning'),
      reasoning: gameplan ?? '',
    },
    confidenceNotes: '',
    // Phase 39 additive fields (D-08) — each by CONDITIONAL SPREAD, never an
    // explicit null, so the written shape IS the read-back shape.
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    ...(claims.length > 0
      ? { claims: Object.fromEntries(claims.map((claim) => [claim.id, persistClaim(claim)])) }
      : {}),
    sections: Object.fromEntries(
      CLAIM_SELECTION_SECTION_IDS.map((sectionId) => [
        sectionId,
        persistSection(selection.sections[sectionId], proseOf(sectionId)),
      ]),
    ),
    ...(actions ? { actions } : {}),
    ...(stripped.size > 0 ? { strippedSectionCount: stripped.size } : {}),
  };
}

// ---------------------------------------------------------------------------
// Persisted-form converters (reviews C1-H5 + C2-H1): typed conditional
// spreads that drop every `null` member and every member that would vanish,
// so what `ref.set` writes is exactly what RTDB hands back — and TOTAL (a
// generic normaliser that could throw has no place on the store step, which
// runs after the credit is spent). `snapshotId.test.ts` asserts these fields
// are a fixed point of `normalizeRtdbWriteShape`.
// ---------------------------------------------------------------------------

type PersistedClaim = ClaimAtomRecord;
type PersistedSubject = NonNullable<PersistedClaim['subject']>;

function persistSubject(subject: ClaimSubject): PersistedSubject | null {
  const persisted: PersistedSubject = {
    ...(subject.myFighterId !== null ? { myFighterId: subject.myFighterId } : {}),
    ...(subject.opponentFighterId !== null ? { opponentFighterId: subject.opponentFighterId } : {}),
    ...(subject.stageId !== null ? { stageId: subject.stageId } : {}),
    ...(subject.opponentTag !== null ? { opponentTag: subject.opponentTag } : {}),
  };
  return Object.keys(persisted).length > 0 ? persisted : null;
}

function persistClaim(claim: ClaimAtom): PersistedClaim {
  const subject = persistSubject(claim.subject);
  const { dateRange, confidenceTier, ...sampleRest } = claim.sample;
  return {
    id: claim.id,
    predicate: claim.predicate,
    ...(subject ? { subject } : {}),
    value: claim.value,
    claimKind: claim.claimKind,
    evidenceIds: [...claim.evidenceIds],
    ...(claim.tier !== null ? { tier: claim.tier } : {}),
    policyVersion: claim.policyVersion,
    sample: {
      ...sampleRest,
      ...(dateRange !== null ? { dateRange } : {}),
      ...(confidenceTier !== null ? { confidenceTier } : {}),
    },
  };
}

function persistSection(
  section: ClaimSelection['sections'][ClaimSelectionSectionId],
  prose: string | null,
): { claimIds: string[]; connective: string } {
  // An empty `claimIds` list is OMITTED on write (RTDB would drop it). The
  // cast is only because the stored schema's OUTPUT type makes `claimIds`
  // required — it defaults to `[]` when the key is absent on read.
  return {
    ...(section.claimIds.length > 0 ? { claimIds: [...section.claimIds] } : {}),
    connective: prose ?? '',
  } as { claimIds: string[]; connective: string };
}

function persistActions(
  selection: ClaimSelection,
): Partial<
  Record<(typeof ACTION_SLOT_KEYS)[number], { actionId: string; claimId?: string }>
> | null {
  const slots = Object.fromEntries(
    ACTION_SLOT_KEYS.flatMap((slot) => {
      const action = selection[slot];
      if (action === null) {
        return [];
      }
      return [
        [
          slot,
          {
            actionId: action.actionId,
            ...(action.claimId !== null ? { claimId: action.claimId } : {}),
          },
        ],
      ];
    }),
  );
  return Object.keys(slots).length > 0 ? slots : null;
}
