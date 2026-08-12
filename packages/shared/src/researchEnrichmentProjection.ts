import type { MatchStage } from './stage.js';
import { UNKNOWN_STAGE, getStageById } from './stageData.js';
import type {
  ResearchEnrichmentProjectionStateRecord,
  ResearchLiquipediaStageForm,
} from './researchEnrichment.js';

/**
 * Phase 30.2 Plan 08 (ENR-07/ENR-08, cycle-1 review HIGH 2/HIGH 3): ONE
 * pure merge resolver, shared by both write paths that decide whether a
 * Liquipedia-sourced stage or VOD fact may occupy a match-row member —
 * `apps/api/src/research/enrichment/projection.ts`'s crash-safe two-phase
 * applier (task 2) and `apps/api/src/research/ingestion/projection.ts`'s
 * additive overlay parameter on the Phase 30 projection (task 3). Both
 * callers delegate their ownership decisions HERE so the two write paths
 * cannot disagree (30.2-08-PLAN.md key_link).
 *
 * MANDATORY IMPORT GRAPH (researchEnrichment.ts cycle-1 review HIGH 1):
 * this module imports ONLY `./researchEnrichment.js` (for the projection
 * state record shape and the Liquipedia stage-form vocabulary) plus the
 * pre-existing, ingestion-independent `./stage.js` / `./stageData.js`
 * modules. It MUST NOT import `./researchIngestion.js` (the Phase 30
 * provider-ingestion schema module) in any form, not even type-only — a
 * later refactor could silently turn a type import into a value import and
 * reintroduce a cycle the header comment on `researchEnrichment.ts`
 * forbids.
 *
 * WHY A WITNESS AT ALL: the shipped fill-empty-only merge
 * (`mergePreservedMatchMembers` in the ingestion projection) cannot tell a
 * user-entered URL from a previously projected one — both are simply
 * "existing, non-empty" — so a projected value can never be corrected or
 * removed under that rule alone. The witness supplies the missing
 * distinction. The witness must live OUTSIDE the match row
 * (`researchEnrichmentProjection/{tenantId}/{matchKey}`, never on
 * `matches/{tenantId}/{key}`) because the edit form's PATCH is a full
 * overwrite (`apps/web/src/components/match-form/EditMatchForm.tsx`) — any
 * ownership member stored on the row would be silently stripped the next
 * time a user saves their own edit, permanently and silently converting a
 * user edit into "still source-owned".
 *
 * WHY THE ACCEPTED SET HAS TWO MEMBERS, NOT ONE (cycle-1 review HIGH 3): a
 * witness write and a match-row write cannot be made atomic in RTDB — there
 * is no cross-tree transaction — so between them there is always a window.
 * With a single COMMITTED value alone, a crash inside that window leaves a
 * stored value the witness does not (yet) vouch for, which the ownership
 * rule would then have to classify user-owned — permanently and silently
 * freezing a projected value as uncorrectable and unremovable, and
 * mis-incrementing the user-owned skip counter. Admitting the PENDING value
 * into the accepted set closes every such window WITHOUT weakening the
 * user-data guarantee, because a value the run itself is in the middle of
 * writing is, by construction, not a value the user typed.
 *
 * THE STAGE CONTRACT, STATED HONESTLY: on a research-projected row the
 * stage member (`map`) is provider-owned by shipped Phase 30 design — it
 * appears in neither the preserved list nor the provider-replaced list and
 * is emitted UNCONDITIONALLY, so a user edit to it is already reverted by
 * every refresh today. This phase does NOT change that, and deliberately
 * does not add the stage member to any preserved list — doing so would
 * alter Phase 30's locked projection semantics, which this phase has no
 * authority to reopen. The enrichment stage therefore occupies ONLY the
 * slot the provider would otherwise fill with the unknown sentinel
 * (`{ id: 0, name: 'unknown' }`), which is strictly an improvement over the
 * shipped behaviour and never a new overwrite: a provider-resolved stage
 * always wins, unconditionally.
 */

// ---------------------------------------------------------------------------
// Outcome unions
// ---------------------------------------------------------------------------

export type EnrichmentVodOutcome =
  | 'unchanged'
  | 'filled-empty'
  | 'source-corrected'
  | 'source-removed'
  | 'skipped-user-owned'
  | 'skipped-provider-owned';

export type EnrichmentStageOutcome = 'provider-authoritative' | 'enriched' | 'unknown';

// ---------------------------------------------------------------------------
// Witness patch actions
// ---------------------------------------------------------------------------

export interface EnrichmentVodWitnessWrite {
  url: string;
  observationId?: string;
  sourceRevisionId?: number;
  parserVersion?: string;
}

export type EnrichmentVodWitnessPreWriteAction =
  | { kind: 'none' }
  | { kind: 'set'; write: EnrichmentVodWitnessWrite }
  /** For a removal: write `pendingVodRemoval: true` instead of a pending URL. */
  | { kind: 'mark-removal' };

export type EnrichmentVodWitnessCommitAction =
  | { kind: 'none' }
  | { kind: 'set'; write: EnrichmentVodWitnessWrite }
  /** Clears the committed AND pending VOD halves; `released: true` marks that a committed claim existed and `vodOwnershipReleasedAtMs` should be stamped by the caller. */
  | { kind: 'clear'; released: boolean };

export interface EnrichmentStageWitnessWrite {
  stageId: number;
  stageName: string;
  raw?: string;
  form?: ResearchLiquipediaStageForm;
  observationId?: string;
  sourceRevisionId?: number;
  parserVersion?: string;
}

export interface EnrichmentStageWitnessRawOnlyWrite {
  raw?: string;
  form?: ResearchLiquipediaStageForm;
  observationId?: string;
  sourceRevisionId?: number;
  parserVersion?: string;
}

export type EnrichmentStageWitnessPreWriteAction =
  | { kind: 'none' }
  | { kind: 'set'; write: EnrichmentStageWitnessWrite }
  | { kind: 'set-raw-only'; write: EnrichmentStageWitnessRawOnlyWrite };

export type EnrichmentStageWitnessCommitAction =
  | { kind: 'none' }
  | { kind: 'set'; write: EnrichmentStageWitnessWrite }
  | { kind: 'set-raw-only'; write: EnrichmentStageWitnessRawOnlyWrite }
  /** THE WITNESS-CLEAR WRITER on provider-stage-wins (cycle-2 review HIGH 2): a provider stage resolved for a game that previously carried a stage witness. */
  | { kind: 'clear' };

export interface EnrichmentWitnessPatch {
  vodPreWrite: EnrichmentVodWitnessPreWriteAction;
  vodCommit: EnrichmentVodWitnessCommitAction;
  stagePreWrite: EnrichmentStageWitnessPreWriteAction;
  stageCommit: EnrichmentStageWitnessCommitAction;
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** The stored ownership witness for one match row — both halves (plan 01's `ResearchEnrichmentProjectionStateRecord`), minus its own key members. */
export type EnrichmentOwnershipWitness = Omit<
  ResearchEnrichmentProjectionStateRecord,
  'matchKey' | 'targetSetId'
>;

export interface EnrichmentVodSourceInput {
  observationId: string;
  sourceRevisionId: number;
  parserVersion: string;
}

export interface EnrichmentStageSourceInput {
  /** Untrusted third-party source text — never dropped, always distinct from the canonical mapping. */
  raw?: string;
  form?: ResearchLiquipediaStageForm;
  /** Present only when the raw stage text was successfully mapped to a canonical stage id. */
  canonicalStageId?: number;
  observationId: string;
  sourceRevisionId?: number;
  parserVersion?: string;
}

export interface EnrichedMatchMembersInput {
  /** The value currently stored on the match row (`matches/{tenantId}/{key}.vodUrl`), or absent. */
  existingVodUrl?: string;
  /** The provider's own fill-empty-only VOD channel (D-21) — never on the emitted `MatchRecord`. */
  providerVodUrl?: string;
  /** The Liquipedia-derived VOD URL currently available for this row, or absent. */
  enrichmentVodUrl?: string;
  enrichmentVodSource?: EnrichmentVodSourceInput;
  /** The stage member the provider projection is about to emit — either its resolved identity or the unknown sentinel. */
  providerStage: MatchStage;
  enrichmentStage?: EnrichmentStageSourceInput;
  witness?: EnrichmentOwnershipWitness | null;
}

export interface EnrichedMatchMembersResult {
  /** Absent, never `''` and never `null`, when there is no VOD to project. */
  vodUrl?: string;
  vodOutcome: EnrichmentVodOutcome;
  stage: MatchStage;
  stageOutcome: EnrichmentStageOutcome;
  witnessPatch: EnrichmentWitnessPatch;
}

// ---------------------------------------------------------------------------
// Ownership predicate
// ---------------------------------------------------------------------------

/**
 * Source ownership is decided against the SET of values the witness vouches
 * for — its committed projected value and its pending projected value
 * (cycle-1 review HIGH 3). Exported as its own named pure function so both
 * write paths and every test reference one definition.
 */
export function isSourceOwnedVodValue(
  storedValue: string | undefined,
  witness: Pick<EnrichmentOwnershipWitness, 'projectedVodUrl' | 'pendingVodUrl'> | null | undefined,
): boolean {
  if (storedValue == null || storedValue.length === 0) {
    return false;
  }
  if (!witness) {
    return false;
  }
  return storedValue === witness.projectedVodUrl || storedValue === witness.pendingVodUrl;
}

function isEmptyString(value: string | null | undefined): boolean {
  return value == null || value.length === 0;
}

function isUnknownStage(stage: MatchStage): boolean {
  return stage.id === UNKNOWN_STAGE.id && stage.name === UNKNOWN_STAGE.name;
}

// ---------------------------------------------------------------------------
// VOD resolution
// ---------------------------------------------------------------------------

interface VodResolution {
  url?: string;
  outcome: EnrichmentVodOutcome;
  preWrite: EnrichmentVodWitnessPreWriteAction;
  commit: EnrichmentVodWitnessCommitAction;
}

function hasAnyVodWitnessClaim(witness: EnrichmentOwnershipWitness | null | undefined): boolean {
  if (!witness) {
    return false;
  }
  return (
    witness.projectedVodUrl != null ||
    witness.pendingVodUrl != null ||
    witness.pendingVodRemoval === true
  );
}

function resolveVod(input: EnrichedMatchMembersInput): VodResolution {
  const { existingVodUrl, providerVodUrl, enrichmentVodUrl, enrichmentVodSource, witness } = input;
  const existingEmpty = isEmptyString(existingVodUrl);
  const pendingVal = witness?.pendingVodUrl;
  const pendingRemoval = witness?.pendingVodRemoval === true;

  if (existingEmpty) {
    if (!isEmptyString(providerVodUrl)) {
      // Behavior 7: provider preferred over enrichment when the field is
      // empty and both are available — the witness records NO enrichment
      // ownership in that case, so release any stale claim.
      return {
        url: providerVodUrl,
        outcome: 'skipped-provider-owned',
        preWrite: { kind: 'none' },
        commit: hasAnyVodWitnessClaim(witness)
          ? { kind: 'clear', released: witness?.projectedVodUrl != null }
          : { kind: 'none' },
      };
    }
    if (!isEmptyString(enrichmentVodUrl) && enrichmentVodSource) {
      const write: EnrichmentVodWitnessWrite = {
        url: enrichmentVodUrl!,
        observationId: enrichmentVodSource.observationId,
        sourceRevisionId: enrichmentVodSource.sourceRevisionId,
        parserVersion: enrichmentVodSource.parserVersion,
      };
      return {
        url: enrichmentVodUrl,
        outcome: 'filled-empty',
        preWrite: { kind: 'set', write },
        commit: { kind: 'set', write },
      };
    }
    if (!isEmptyString(pendingVal)) {
      // The interrupted-write case: a crash after the witness pre-write and
      // before the row write. Complete the transition rather than stall.
      const write: EnrichmentVodWitnessWrite = {
        url: pendingVal!,
        observationId: witness?.pendingVodObservationId ?? undefined,
        sourceRevisionId: witness?.pendingVodSourceRevisionId ?? undefined,
      };
      return {
        url: pendingVal ?? undefined,
        outcome: 'filled-empty',
        preWrite: { kind: 'none' },
        commit: { kind: 'set', write },
      };
    }
    if (pendingRemoval) {
      // Row already reflects the removal; finalize the witness.
      return {
        url: undefined,
        outcome: 'unchanged',
        preWrite: { kind: 'none' },
        commit: { kind: 'clear', released: witness?.projectedVodUrl != null },
      };
    }
    return {
      url: undefined,
      outcome: 'unchanged',
      preWrite: { kind: 'none' },
      commit: { kind: 'none' },
    };
  }

  // Existing, non-empty value.
  const owned = isSourceOwnedVodValue(existingVodUrl, witness);
  if (!owned) {
    return {
      url: existingVodUrl,
      outcome: 'skipped-user-owned',
      preWrite: { kind: 'none' },
      commit: { kind: 'none' },
    };
  }

  if (!isEmptyString(enrichmentVodUrl) && enrichmentVodSource) {
    const write: EnrichmentVodWitnessWrite = {
      url: enrichmentVodUrl!,
      observationId: enrichmentVodSource.observationId,
      sourceRevisionId: enrichmentVodSource.sourceRevisionId,
      parserVersion: enrichmentVodSource.parserVersion,
    };
    if (enrichmentVodUrl === existingVodUrl) {
      // Already the target value. Promote a pending half if one exists;
      // otherwise this is a true no-op (idempotent replay).
      const needsPromotion = pendingVal === existingVodUrl;
      return {
        url: existingVodUrl,
        outcome: 'unchanged',
        preWrite: { kind: 'none' },
        commit: needsPromotion ? { kind: 'set', write } : { kind: 'none' },
      };
    }
    return {
      url: enrichmentVodUrl,
      outcome: 'source-corrected',
      preWrite: { kind: 'set', write },
      commit: { kind: 'set', write },
    };
  }

  // Source stopped supplying a value: removal.
  return {
    url: undefined,
    outcome: 'source-removed',
    preWrite: { kind: 'mark-removal' },
    commit: { kind: 'clear', released: true },
  };
}

// ---------------------------------------------------------------------------
// Stage resolution
// ---------------------------------------------------------------------------

interface StageResolution {
  stage: MatchStage;
  outcome: EnrichmentStageOutcome;
  preWrite: EnrichmentStageWitnessPreWriteAction;
  commit: EnrichmentStageWitnessCommitAction;
}

function hasAnyStageWitnessClaim(witness: EnrichmentOwnershipWitness | null | undefined): boolean {
  if (!witness) {
    return false;
  }
  return (
    witness.projectedStageId != null ||
    witness.projectedStageRaw != null ||
    witness.pendingStageId != null ||
    witness.pendingStageRaw != null
  );
}

function resolveStageMember(input: EnrichedMatchMembersInput): StageResolution {
  const { providerStage, enrichmentStage, witness } = input;

  if (!isUnknownStage(providerStage)) {
    // A provider-resolved stage always wins, unconditionally.
    return {
      stage: providerStage,
      outcome: 'provider-authoritative',
      preWrite: { kind: 'none' },
      commit: hasAnyStageWitnessClaim(witness) ? { kind: 'clear' } : { kind: 'none' },
    };
  }

  if (enrichmentStage?.canonicalStageId != null) {
    const canonical = getStageById(enrichmentStage.canonicalStageId);
    if (canonical) {
      const alreadyCommittedIdentical =
        witness?.projectedStageId === canonical.id &&
        witness?.projectedStageName === canonical.name &&
        witness?.projectedStageRaw === enrichmentStage.raw &&
        witness?.projectedStageForm === enrichmentStage.form &&
        witness?.pendingStageId == null;
      const write: EnrichmentStageWitnessWrite = {
        stageId: canonical.id,
        stageName: canonical.name,
        raw: enrichmentStage.raw,
        form: enrichmentStage.form,
        observationId: enrichmentStage.observationId,
        sourceRevisionId: enrichmentStage.sourceRevisionId,
        parserVersion: enrichmentStage.parserVersion,
      };
      return {
        stage: { id: canonical.id, name: canonical.name },
        outcome: 'enriched',
        preWrite: alreadyCommittedIdentical ? { kind: 'none' } : { kind: 'set', write },
        commit: alreadyCommittedIdentical ? { kind: 'none' } : { kind: 'set', write },
      };
    }
  }

  // Unresolved: unknown stays unknown, but the raw source text — if any —
  // is still recorded on the witness so the UI can show what the source
  // said (the raw-vs-canonical requirement — unmapped symbols are never
  // silently dropped).
  if (enrichmentStage?.raw != null) {
    const alreadyRecorded =
      witness?.projectedStageRaw === enrichmentStage.raw &&
      witness?.projectedStageForm === enrichmentStage.form &&
      witness?.projectedStageId == null &&
      witness?.pendingStageRaw == null;
    const write: EnrichmentStageWitnessRawOnlyWrite = {
      raw: enrichmentStage.raw,
      form: enrichmentStage.form,
      observationId: enrichmentStage.observationId,
      sourceRevisionId: enrichmentStage.sourceRevisionId,
      parserVersion: enrichmentStage.parserVersion,
    };
    return {
      stage: providerStage,
      outcome: 'unknown',
      preWrite: alreadyRecorded ? { kind: 'none' } : { kind: 'set-raw-only', write },
      commit: alreadyRecorded ? { kind: 'none' } : { kind: 'set-raw-only', write },
    };
  }

  return {
    stage: providerStage,
    outcome: 'unknown',
    preWrite: { kind: 'none' },
    commit: { kind: 'none' },
  };
}

// ---------------------------------------------------------------------------
// Combined resolver
// ---------------------------------------------------------------------------

/**
 * A pure, total function of its input: identical inputs always produce
 * identical outputs, with no clock and no I/O. Decides BOTH ownership
 * questions — VOD and stage — in one call so both write paths (the
 * enrichment applier's crash-safe two-phase witness protocol, and the
 * ingestion projection's additive overlay) delegate to the same rules and
 * cannot disagree.
 */
export function resolveEnrichedMatchMembers(
  input: EnrichedMatchMembersInput,
): EnrichedMatchMembersResult {
  const vod = resolveVod(input);
  const stage = resolveStageMember(input);

  return {
    vodUrl: vod.url,
    vodOutcome: vod.outcome,
    stage: stage.stage,
    stageOutcome: stage.outcome,
    witnessPatch: {
      vodPreWrite: vod.preWrite,
      vodCommit: vod.commit,
      stagePreWrite: stage.preWrite,
      stageCommit: stage.commit,
    },
  };
}
