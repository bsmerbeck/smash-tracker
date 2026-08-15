import type { MatchStage } from './stage.js';
import { UNKNOWN_STAGE, getStageById } from './stageData.js';
// 30.3 Gate 5: the reviewed character map — like `./stage.js`/`./stageData.js`
// an ingestion-independent reference-data module, so the mandatory import
// graph below (no `./researchIngestion.js` edge, even type-only) is intact.
import { resolveLiquipediaFighterId } from './liquipediaCharacterMap.js';
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

/**
 * 30.3 Gate 5 — character evidence outcomes. Characters never write a match
 * row member (`fighter_id`/`opponent_id` are REQUIRED provider-derived
 * members; a game row without provider characters is never projected at
 * all), so this half is WITNESS-ONLY evidence for attribution surfaces.
 * `abstained-*` states are the directive's stop conditions: orientation
 * unproven, or the observation's game scope is not explicitly Ultimate.
 */
export type EnrichmentCharsOutcome =
  | 'none'
  | 'enriched'
  | 'partial-unmapped'
  | 'abstained-orientation'
  | 'abstained-game-scope'
  | 'source-removed';

/**
 * 30.3 Gate 5 — stocks outcomes. `stocksLeft` IS a match-row member, so
 * this half follows the VOD half's full fill/correct/remove/skip
 * discipline, PLUS the directive's stock-specific gates: stocks may become
 * `stocksLeft` ONLY when the seat alignment (orientation) and the
 * winner-seat evidence agree with the row's own `win` member.
 */
export type EnrichmentStocksOutcome =
  | 'none'
  | 'unchanged'
  | 'filled-empty'
  | 'source-corrected'
  | 'source-removed'
  | 'skipped-owned'
  | 'abstained-orientation'
  | 'abstained-game-scope'
  | 'abstained-winner-disagreement'
  | 'abstained-value';

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

// -- 30.3 Gate 5: character / stocks witness actions -------------------------

export interface EnrichmentCharsWitnessWrite {
  /** The PROVEN orientation: which source seat the subject occupies. */
  subjectSeat: 1 | 2;
  subjectCharRaw?: string;
  /** Present only when the raw name passed the reviewed character map — absent = flagged unmapped, never guessed. */
  subjectFighterId?: number;
  opponentCharRaw?: string;
  opponentFighterId?: number;
  observationId: string;
  sourceRevisionId?: number;
  parserVersion?: string;
}

/** Characters write no match-row member, so a single commit-time action suffices — there is no row write to bracket with a pending half. */
export type EnrichmentCharsWitnessCommitAction =
  { kind: 'none' } | { kind: 'set'; write: EnrichmentCharsWitnessWrite } | { kind: 'clear' };

export interface EnrichmentStocksWitnessWrite {
  stocksLeft: number;
  observationId: string;
  sourceRevisionId?: number;
  parserVersion?: string;
}

export type EnrichmentStocksWitnessPreWriteAction =
  { kind: 'none' } | { kind: 'set'; write: EnrichmentStocksWitnessWrite };

export type EnrichmentStocksWitnessCommitAction =
  { kind: 'none' } | { kind: 'set'; write: EnrichmentStocksWitnessWrite } | { kind: 'clear' };

export interface EnrichmentWitnessPatch {
  vodPreWrite: EnrichmentVodWitnessPreWriteAction;
  vodCommit: EnrichmentVodWitnessCommitAction;
  stagePreWrite: EnrichmentStageWitnessPreWriteAction;
  stageCommit: EnrichmentStageWitnessCommitAction;
  charsCommit: EnrichmentCharsWitnessCommitAction;
  stocksPreWrite: EnrichmentStocksWitnessPreWriteAction;
  stocksCommit: EnrichmentStocksWitnessCommitAction;
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** The stored ownership witness for one match row — both halves (plan 01's `ResearchEnrichmentProjectionStateRecord`), minus its own key members. */
export type EnrichmentOwnershipWitness = Omit<
  ResearchEnrichmentProjectionStateRecord,
  'matchKey' | 'targetSetId'
>;

/**
 * All members are individually optional (not just the whole object) because
 * `apps/api/src/research/enrichment/projection.ts`'s `buildEnrichmentOverlay`
 * deliberately returns `enrichedVodUrlByKey` as a plain `Record<string,
 * string>` — a set-level VOD URL with no per-row provenance breakdown. A
 * caller with less provenance than it would like still gets a correct
 * fill/correct/remove decision; it just stamps a thinner witness record.
 */
export interface EnrichmentVodSourceInput {
  observationId?: string;
  sourceRevisionId?: number;
  parserVersion?: string;
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

/**
 * 30.3 Gate 5 — one game row's raw character/stock evidence, exactly as the
 * observation stated it, keyed by SOURCE SEAT (the wiki's opponent1/
 * opponent2 order — an order that says NOTHING about which seat is the
 * subject until orientation is proven).
 *
 * `seatTags` and the caller's `rowOpponentTag` must be normalized by the
 * CALLER with ONE normalizer applied to both sides (the API applier uses
 * `normalizeOpponentTag`, the same normalizer the ingestion projection used
 * to author the row's `opponent` member) — this module compares them for
 * exact equality and never re-normalizes.
 */
export interface EnrichmentGameEvidenceInput {
  /** The observation's wiki game scope (`game` member), e.g. `ultimate`. */
  game?: string;
  /** Set-level player tags by source seat, PRE-NORMALIZED; null = the source stated no tag for that seat. */
  seatTags?: [string | null, string | null];
  rawChars?: [string | null, string | null];
  stocks?: [number | null, number | null];
  winnerSeat?: 1 | 2;
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
  // -- 30.3 Gate 5: character/stock evidence context -------------------------
  /**
   * MUST be `true` for the character/stock halves to act AT ALL — including
   * their removal/clear paths. The ingestion projection's overlay caller
   * (`mergePreservedMatchMembers`) does not supply evidence context, and an
   * absent-evidence input there must mean "not consulted" (inert), never
   * "the source stopped supplying characters" (removal). Only the
   * enrichment applier — which loads the full evidence universe for the
   * set — sets this flag.
   */
  enrichmentEvidenceConsulted?: boolean;
  enrichmentGameEvidence?: EnrichmentGameEvidenceInput;
  /** The row's provider-authored `opponent` member, normalized by the caller with the same normalizer as `seatTags`. */
  rowOpponentTag?: string;
  /** The row's `win` member (subject won). */
  rowWin?: boolean;
  /** The row's current `stocksLeft` member, or absent. */
  existingStocksLeft?: number;
}

/** The witness-only character evidence a resolution produced (mirrors the commit write, absent when nothing is projected). */
export interface EnrichedCharsEvidence {
  subjectSeat: 1 | 2;
  subjectCharRaw?: string;
  subjectFighterId?: number;
  opponentCharRaw?: string;
  opponentFighterId?: number;
}

export interface EnrichedMatchMembersResult {
  /** Absent, never `''` and never `null`, when there is no VOD to project. */
  vodUrl?: string;
  vodOutcome: EnrichmentVodOutcome;
  stage: MatchStage;
  stageOutcome: EnrichmentStageOutcome;
  /** The FINAL `stocksLeft` member value for the row — absent means the member should be absent. Callers that do not manage `stocksLeft` may ignore it (it echoes `existingStocksLeft` whenever the stocks half did not act). */
  stocksLeft?: number;
  stocksOutcome: EnrichmentStocksOutcome;
  charsOutcome: EnrichmentCharsOutcome;
  chars?: EnrichedCharsEvidence;
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

/**
 * The STAGE analog of {@link isSourceOwnedVodValue} (30.3 Gate 5 commit 1 —
 * the latent stage-witness hazard): decides whether a stored row stage is the
 * enrichment applier's OWN earlier projection, against the SAME two-member
 * accepted set (committed ∪ pending). The enrichment applier consults this
 * BEFORE building its resolver input: a stored stage this function vouches
 * for is not evidence of a provider-resolved stage — it is the applier's own
 * write echoed back — so the applier passes the unknown sentinel as
 * `providerStage` instead, and a re-apply becomes witness-preserving rather
 * than witness-clearing. The ingestion projection never needs this predicate:
 * its `providerStage` input comes from genuine provider data, never from the
 * stored row.
 */
export function isSourceOwnedStageValue(
  storedStage: MatchStage,
  witness:
    | Pick<
        EnrichmentOwnershipWitness,
        'projectedStageId' | 'projectedStageName' | 'pendingStageId' | 'pendingStageName'
      >
    | null
    | undefined,
): boolean {
  if (!witness) {
    return false;
  }
  if (isUnknownStage(storedStage)) {
    return false;
  }
  const committedMatch =
    witness.projectedStageId === storedStage.id && witness.projectedStageName === storedStage.name;
  const pendingMatch =
    witness.pendingStageId === storedStage.id && witness.pendingStageName === storedStage.name;
  return committedMatch || pendingMatch;
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
    if (!isEmptyString(enrichmentVodUrl)) {
      const write: EnrichmentVodWitnessWrite = {
        url: enrichmentVodUrl!,
        observationId: enrichmentVodSource?.observationId,
        sourceRevisionId: enrichmentVodSource?.sourceRevisionId,
        parserVersion: enrichmentVodSource?.parserVersion,
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

  if (!isEmptyString(enrichmentVodUrl)) {
    const write: EnrichmentVodWitnessWrite = {
      url: enrichmentVodUrl!,
      observationId: enrichmentVodSource?.observationId,
      sourceRevisionId: enrichmentVodSource?.sourceRevisionId,
      parserVersion: enrichmentVodSource?.parserVersion,
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

  // No enrichment stage data at all. When a witness still carries a stage
  // claim, the source has STOPPED supplying the stage it once projected —
  // the stage mirror of the VOD half's source-removed case (30.3 Gate 5
  // commit 1). Clearing the witness here is what lets a removal converge:
  // the caller writes the unknown sentinel this branch returns, and a claim
  // for a value that is no longer supplied does not linger to vouch for
  // nothing. A witness with no stage claim resolves to a true no-op, exactly
  // as before.
  return {
    stage: providerStage,
    outcome: 'unknown',
    preWrite: { kind: 'none' },
    commit: hasAnyStageWitnessClaim(witness) ? { kind: 'clear' } : { kind: 'none' },
  };
}

// ---------------------------------------------------------------------------
// Seat orientation (30.3 Gate 5)
// ---------------------------------------------------------------------------

export type EnrichmentSeatOrientation =
  | { subjectSeat: 1 | 2 }
  | { subjectSeat: null; reason: 'no-seat-tags' | 'no-opponent-tag' | 'no-match' | 'ambiguous' };

/**
 * Proves which SOURCE seat the subject occupies, from the one fact both
 * sides state independently: the opponent's tag. The row's `opponent`
 * member is provider-authored (start.gg's entrant name, normalized at
 * projection time), and the observation's seat tags are the wiki's own —
 * when EXACTLY ONE seat tag equals the row's opponent tag, that seat is the
 * opponent and the other is the subject. Anything less than exactly-one is
 * an ABSTENTION, never a guess: both seats matching (a mirror-tag edge), no
 * seat matching (a renamed player, a sponsor-prefix mismatch the caller's
 * normalizer did not fold), or missing tags on either side.
 */
export function resolveSeatOrientation(
  rowOpponentTag: string | undefined,
  seatTags: [string | null, string | null] | undefined,
): EnrichmentSeatOrientation {
  if (rowOpponentTag == null || rowOpponentTag.length === 0 || rowOpponentTag === 'unknown') {
    return { subjectSeat: null, reason: 'no-opponent-tag' };
  }
  const seat1 = seatTags?.[0] ?? null;
  const seat2 = seatTags?.[1] ?? null;
  if (seat1 == null && seat2 == null) {
    return { subjectSeat: null, reason: 'no-seat-tags' };
  }
  const seat1IsOpponent = seat1 != null && seat1 === rowOpponentTag;
  const seat2IsOpponent = seat2 != null && seat2 === rowOpponentTag;
  if (seat1IsOpponent && seat2IsOpponent) {
    return { subjectSeat: null, reason: 'ambiguous' };
  }
  if (seat1IsOpponent) {
    return { subjectSeat: 2 };
  }
  if (seat2IsOpponent) {
    return { subjectSeat: 1 };
  }
  return { subjectSeat: null, reason: 'no-match' };
}

/** The one game-scope gate for character/stock evidence: the observation must EXPLICITLY state Ultimate. An absent scope abstains — the enrichment pipeline is SSBU-scoped and Melee data (the Hungrybox pages) must never cross into it, so unstated is treated as unproven, not as Ultimate. */
function isUltimateGameScope(game: string | undefined): boolean {
  return game != null && game.trim().toLowerCase() === 'ultimate';
}

// ---------------------------------------------------------------------------
// Character evidence resolution (30.3 Gate 5) — witness-only, no row member
// ---------------------------------------------------------------------------

interface CharsResolution {
  outcome: EnrichmentCharsOutcome;
  chars?: EnrichedCharsEvidence;
  commit: EnrichmentCharsWitnessCommitAction;
}

function hasAnyCharsWitnessClaim(witness: EnrichmentOwnershipWitness | null | undefined): boolean {
  if (!witness) {
    return false;
  }
  return (
    witness.projectedSubjectSeat != null ||
    witness.projectedSubjectCharRaw != null ||
    witness.projectedSubjectFighterId != null ||
    witness.projectedOpponentCharRaw != null ||
    witness.projectedOpponentFighterId != null
  );
}

/** Clear a lingering chars claim when the evidence no longer supports one; a claimless witness resolves to a plain inert outcome. */
function abstainChars(
  outcome: EnrichmentCharsOutcome,
  witness: EnrichmentOwnershipWitness | null | undefined,
): CharsResolution {
  return {
    outcome,
    commit: hasAnyCharsWitnessClaim(witness) ? { kind: 'clear' } : { kind: 'none' },
  };
}

function resolveChars(input: EnrichedMatchMembersInput): CharsResolution {
  const { enrichmentEvidenceConsulted, enrichmentGameEvidence, rowOpponentTag, witness } = input;

  if (enrichmentEvidenceConsulted !== true) {
    // Not consulted (the ingestion overlay path): completely inert — never
    // an implied removal.
    return { outcome: 'none', commit: { kind: 'none' } };
  }

  const rawChars = enrichmentGameEvidence?.rawChars;
  const hasAnyRawChar = rawChars != null && (rawChars[0] != null || rawChars[1] != null);
  if (!enrichmentGameEvidence || !hasAnyRawChar) {
    // The evidence universe was consulted and this row has no character
    // evidence (anymore): a lingering claim is a removal.
    return {
      ...abstainChars('none', witness),
      outcome: hasAnyCharsWitnessClaim(witness) ? 'source-removed' : 'none',
    };
  }

  if (!isUltimateGameScope(enrichmentGameEvidence.game)) {
    return abstainChars('abstained-game-scope', witness);
  }

  const orientation = resolveSeatOrientation(rowOpponentTag, enrichmentGameEvidence.seatTags);
  if (orientation.subjectSeat == null) {
    return abstainChars('abstained-orientation', witness);
  }

  const subjectSeat = orientation.subjectSeat;
  const opponentSeat = subjectSeat === 1 ? 2 : 1;
  const subjectCharRaw = rawChars[subjectSeat - 1] ?? undefined;
  const opponentCharRaw = rawChars[opponentSeat - 1] ?? undefined;
  const subjectFighterId = resolveLiquipediaFighterId(subjectCharRaw);
  const opponentFighterId = resolveLiquipediaFighterId(opponentCharRaw);

  const fullyMapped =
    subjectCharRaw != null &&
    opponentCharRaw != null &&
    subjectFighterId !== undefined &&
    opponentFighterId !== undefined;
  const outcome: EnrichmentCharsOutcome = fullyMapped ? 'enriched' : 'partial-unmapped';

  const chars: EnrichedCharsEvidence = {
    subjectSeat,
    ...(subjectCharRaw != null ? { subjectCharRaw } : {}),
    ...(subjectFighterId !== undefined ? { subjectFighterId } : {}),
    ...(opponentCharRaw != null ? { opponentCharRaw } : {}),
    ...(opponentFighterId !== undefined ? { opponentFighterId } : {}),
  };

  const alreadyCommittedIdentical =
    witness?.projectedSubjectSeat === subjectSeat &&
    (witness?.projectedSubjectCharRaw ?? undefined) === subjectCharRaw &&
    (witness?.projectedSubjectFighterId ?? undefined) === subjectFighterId &&
    (witness?.projectedOpponentCharRaw ?? undefined) === opponentCharRaw &&
    (witness?.projectedOpponentFighterId ?? undefined) === opponentFighterId &&
    witness?.charsObservationId === enrichmentGameEvidence.observationId;

  return {
    outcome,
    chars,
    commit: alreadyCommittedIdentical
      ? { kind: 'none' }
      : {
          kind: 'set',
          write: {
            ...chars,
            observationId: enrichmentGameEvidence.observationId,
            sourceRevisionId: enrichmentGameEvidence.sourceRevisionId,
            parserVersion: enrichmentGameEvidence.parserVersion,
          },
        },
  };
}

// ---------------------------------------------------------------------------
// Stocks resolution (30.3 Gate 5) — a real row member, full VOD discipline
// ---------------------------------------------------------------------------

/** Stocks ownership, decided against the SAME committed ∪ pending accepted set the VOD and stage halves use. */
export function isSourceOwnedStocksValue(
  storedValue: number | undefined,
  witness:
    | Pick<EnrichmentOwnershipWitness, 'projectedStocksLeft' | 'pendingStocksLeft'>
    | null
    | undefined,
): boolean {
  if (storedValue == null || !witness) {
    return false;
  }
  return storedValue === witness.projectedStocksLeft || storedValue === witness.pendingStocksLeft;
}

interface StocksResolution {
  /** The FINAL member value — absent means the member should be absent. */
  stocksLeft?: number;
  outcome: EnrichmentStocksOutcome;
  preWrite: EnrichmentStocksWitnessPreWriteAction;
  commit: EnrichmentStocksWitnessCommitAction;
}

function hasAnyStocksWitnessClaim(witness: EnrichmentOwnershipWitness | null | undefined): boolean {
  if (!witness) {
    return false;
  }
  return witness.projectedStocksLeft != null || witness.pendingStocksLeft != null;
}

/**
 * The abstention path shared by every failed stock gate: a witness-OWNED
 * stored value loses its justification and is REMOVED (the row member
 * reverts to absent, the witness half clears); a value the witness does not
 * vouch for — provider- or user-authored — is untouched, and only a stale,
 * non-matching claim is cleared.
 */
function abstainStocks(
  outcome: EnrichmentStocksOutcome,
  existingStocksLeft: number | undefined,
  witness: EnrichmentOwnershipWitness | null | undefined,
): StocksResolution {
  const owned = isSourceOwnedStocksValue(existingStocksLeft, witness);
  if (owned) {
    return {
      outcome,
      preWrite: { kind: 'none' },
      commit: { kind: 'clear' },
    };
  }
  return {
    ...(existingStocksLeft !== undefined ? { stocksLeft: existingStocksLeft } : {}),
    outcome,
    preWrite: { kind: 'none' },
    commit: hasAnyStocksWitnessClaim(witness) ? { kind: 'clear' } : { kind: 'none' },
  };
}

function resolveStocks(input: EnrichedMatchMembersInput): StocksResolution {
  const {
    enrichmentEvidenceConsulted,
    enrichmentGameEvidence,
    rowOpponentTag,
    rowWin,
    existingStocksLeft,
    witness,
  } = input;

  if (enrichmentEvidenceConsulted !== true) {
    // Not consulted: inert — echo the existing member and touch nothing.
    return {
      ...(existingStocksLeft !== undefined ? { stocksLeft: existingStocksLeft } : {}),
      outcome: 'none',
      preWrite: { kind: 'none' },
      commit: { kind: 'none' },
    };
  }

  const stocks = enrichmentGameEvidence?.stocks;
  const hasAnyStockValue = stocks != null && (stocks[0] != null || stocks[1] != null);
  if (!enrichmentGameEvidence || !hasAnyStockValue) {
    const removal = abstainStocks('none', existingStocksLeft, witness);
    return {
      ...removal,
      outcome:
        isSourceOwnedStocksValue(existingStocksLeft, witness) || hasAnyStocksWitnessClaim(witness)
          ? 'source-removed'
          : 'none',
    };
  }

  if (!isUltimateGameScope(enrichmentGameEvidence.game)) {
    return abstainStocks('abstained-game-scope', existingStocksLeft, witness);
  }

  const orientation = resolveSeatOrientation(rowOpponentTag, enrichmentGameEvidence.seatTags);
  if (orientation.subjectSeat == null) {
    return abstainStocks('abstained-orientation', existingStocksLeft, witness);
  }

  const winnerSeat = enrichmentGameEvidence.winnerSeat;
  if (winnerSeat == null || rowWin == null) {
    return abstainStocks('abstained-winner-disagreement', existingStocksLeft, witness);
  }
  const evidenceSaysSubjectWon = winnerSeat === orientation.subjectSeat;
  if (evidenceSaysSubjectWon !== rowWin) {
    // The source and the provider DISAGREE about who won this game — the
    // directive's hard stop: never attach a stock count whose winner-seat
    // evidence conflicts with the row's own result.
    return abstainStocks('abstained-winner-disagreement', existingStocksLeft, witness);
  }

  const winnerStocks = stocks[winnerSeat - 1];
  if (
    winnerStocks == null ||
    !Number.isInteger(winnerStocks) ||
    winnerStocks < 0 ||
    winnerStocks > 3
  ) {
    return abstainStocks('abstained-value', existingStocksLeft, witness);
  }

  const write: EnrichmentStocksWitnessWrite = {
    stocksLeft: winnerStocks,
    observationId: enrichmentGameEvidence.observationId,
    sourceRevisionId: enrichmentGameEvidence.sourceRevisionId,
    parserVersion: enrichmentGameEvidence.parserVersion,
  };

  if (existingStocksLeft === undefined) {
    return {
      stocksLeft: winnerStocks,
      outcome: 'filled-empty',
      preWrite: { kind: 'set', write },
      commit: { kind: 'set', write },
    };
  }

  const owned = isSourceOwnedStocksValue(existingStocksLeft, witness);
  if (!owned) {
    // Provider/user values outrank Liquipedia — the existing member wins.
    return {
      stocksLeft: existingStocksLeft,
      outcome: 'skipped-owned',
      preWrite: { kind: 'none' },
      commit: { kind: 'none' },
    };
  }

  if (winnerStocks === existingStocksLeft) {
    const needsPromotion = witness?.pendingStocksLeft === existingStocksLeft;
    return {
      stocksLeft: existingStocksLeft,
      outcome: 'unchanged',
      preWrite: { kind: 'none' },
      commit: needsPromotion ? { kind: 'set', write } : { kind: 'none' },
    };
  }

  return {
    stocksLeft: winnerStocks,
    outcome: 'source-corrected',
    preWrite: { kind: 'set', write },
    commit: { kind: 'set', write },
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
  const chars = resolveChars(input);
  const stocks = resolveStocks(input);

  return {
    vodUrl: vod.url,
    vodOutcome: vod.outcome,
    stage: stage.stage,
    stageOutcome: stage.outcome,
    ...(stocks.stocksLeft !== undefined ? { stocksLeft: stocks.stocksLeft } : {}),
    stocksOutcome: stocks.outcome,
    charsOutcome: chars.outcome,
    ...(chars.chars !== undefined ? { chars: chars.chars } : {}),
    witnessPatch: {
      vodPreWrite: vod.preWrite,
      vodCommit: vod.commit,
      stagePreWrite: stage.preWrite,
      stageCommit: stage.commit,
      charsCommit: chars.commit,
      stocksPreWrite: stocks.preWrite,
      stocksCommit: stocks.commit,
    },
  };
}
