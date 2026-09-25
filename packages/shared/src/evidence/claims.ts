/**
 * RPT-08 / D-01 / D-09 (phase 39 plan 01, wave 1): the closed claim-atom
 * contract every later plan in this phase compiles against. Contracts ONLY
 * in this module — the builder that actually EMITS `ClaimAtom` values from
 * a `Match[]` lands in plan 39-03. This module is reachable from the
 * browser bundle through `packages/shared/src/index.ts` (the package's
 * `exports` map has only `.` and `./testUtils` — see `package.json` — so
 * anything this directory exports is reachable from the root barrel, the
 * same rule `researchEnrichment.ts`'s doc comment states for the same
 * reason). It carries NO `node:` import; `sharedImportPurity.test.ts`
 * enforces that across the whole directory.
 */
import type { ClaimKind, ConfidenceTier, SampleMeta } from './types.js';

/** The version of the `ClaimAtom` shape itself — bumped on a breaking field change, never on a value change. */
export const CLAIM_SCHEMA_VERSION = 1;

/**
 * AI-SPEC §4 item 1: the claim-ID vocabulary is a FIXED, static list
 * identical for every job — never derived per job — so the model's output
 * schema (`claimId` enum) is byte-identical across jobs and the Anthropic
 * schema-compilation cache is hit. 32 is a deliberate, modest choice: the
 * Anthropic reference this phase used states no enum-size limit, so
 * enlarging this number is a decision to re-check against live docs, not a
 * free parameter to bump casually.
 */
export const CLAIM_ID_VOCABULARY_SIZE = 32;

/** Zero-pads a positional index (1-based) onto a fixed-width vocabulary prefix — the one place both `CLAIM_ID_VOCABULARY` and `ACTION_ID_VOCABULARY` share their construction rule. */
function buildIdVocabulary(prefix: string, size: number): readonly string[] {
  return Object.freeze(
    Array.from({ length: size }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`),
  );
}

/** `c01`..`c32`, ascending, zero-padded to two digits. */
export const CLAIM_ID_VOCABULARY = buildIdVocabulary(
  'c',
  CLAIM_ID_VOCABULARY_SIZE,
) as readonly ClaimId[];
export type ClaimId = `c${string}`;

/**
 * AI-SPEC §4 item 2: the recommended-action vocabulary is a fixed list of
 * action IDs sized for exactly three slots per surface (D-12), so "more
 * than three actions" is unrepresentable rather than merely rejected. Nine
 * is three candidates per kind across the three closed action kinds
 * (`matchup_practice` / `vod_review` / `drill`).
 */
export const ACTION_ID_VOCABULARY_SIZE = 9;

/** `a01`..`a09`. */
export const ACTION_ID_VOCABULARY = buildIdVocabulary(
  'a',
  ACTION_ID_VOCABULARY_SIZE,
) as readonly ActionId[];
export type ActionId = `a${string}`;

/**
 * The closed predicate enum — exactly these ten members and no others. Each
 * comment names the existing `ReportPayload`/`SynthesisPayload` field it is
 * computed from (RESEARCH Pattern 4's table), so plan 39-03's builder has no
 * ambiguity about its raw material.
 */
export const CLAIM_PREDICATES = [
  /** `ReportPayload.userContext.vsTopCharacters[].topStages` — stage win/loss record within a matchup. */
  'stage_record',
  /** `ReportPayload.userContext.vsTopCharacters[].topStages` — the same rows, expressed as a play-rate share rather than a raw record. */
  'stage_pick_rate',
  /** `ReportPayload.userContext.myCharacterRecords[].vsOpponentCharacter` — my character vs. their character. */
  'character_matchup_record',
  /** `ReportPayload.userContext.myCharacterRecords[]` — my character's overall record. */
  'my_character_record',
  /** `ReportPayload.headToHead` — the caller's own past matches against this exact player. */
  'head_to_head_record',
  /** `ReportPayload.userContext.recentForm` — W/L over the user's most recent matches, any opponent. */
  'recent_form',
  /** `ReportPayload.scout` (live public evidence) — the opponent's own most-used characters. */
  'opponent_character_usage',
  /** `ReportPayload.userContext.matchupAdvisor[]` — the deterministic character-pick recommendation. */
  'matchup_advisor_pick',
  /** `SynthesisPayload.evidence[]` — the `(matchId, seconds)` VOD-moment pairs (D-02's new synthesis predicate family). */
  'vod_annotation',
  /** `ReportPayload.cohort` — the session-type/provenance composition every other claim is disclosed against. */
  'cohort_disclosure',
] as const;
export type ClaimPredicate = (typeof CLAIM_PREDICATES)[number];

/**
 * A discriminated union on `kind` — no free-form value member. Every
 * predicate's raw material (RESEARCH Pattern 4) reduces to one of these
 * five shapes.
 */
export type ClaimValue =
  | { kind: 'record'; wins: number; losses: number; games: number }
  | { kind: 'rate'; numerator: number; denominator: number }
  | { kind: 'count'; count: number }
  | { kind: 'entity'; entityKind: string; entityId: string }
  | { kind: 'abstained'; gamesNeeded: number };

/**
 * The licensed-entity set the D-04 prose lint checks prose against, and the
 * axis set an evidence id is built from (see `snapshot.ts`'s `evidenceIdFor`).
 * Every field is independently nullable — a claim may rest on any subset of
 * these four axes (`recent_form`/`cohort_disclosure` rest on none of them).
 */
export interface ClaimSubject {
  myFighterId: number | null;
  opponentFighterId: number | null;
  stageId: number | null;
  opponentTag: string | null;
}

/**
 * The one flat, closed claim atom every later plan in this phase compiles
 * against. `policyVersion` is always `EVIDENCE_POLICY_VERSION` — never a
 * bare literal `1` typed here, the same SS5 threshold-drift discipline
 * `policy.ts`'s own doc comment states.
 */
export interface ClaimAtom {
  id: ClaimId;
  predicate: ClaimPredicate;
  subject: ClaimSubject;
  value: ClaimValue;
  claimKind: ClaimKind;
  evidenceIds: readonly string[];
  tier: ConfidenceTier | null;
  policyVersion: number;
  sample: SampleMeta;
}

/** The four report surfaces this phase's one pipeline serves (D-02). */
export type ReportSurface = 'scout' | 'prep_report' | 'prep_bundle_child' | 'post_event_synthesis';

/**
 * D-07: the minimum surviving-claim count below which an output fails
 * validation (routed to the existing `failJob`, `failureReason: 'validation'`).
 * Below three surviving claims a scouting output is not a report; the
 * synthesis surface rests on annotation claims that are legitimately fewer.
 * Cited by name (not by value) from `records/RPT-08-rubric.md` — a
 * committed test in `rpt08Oracle.test.ts` asserts the two stay in lockstep.
 */
export const MIN_VIABLE_CLAIMS: Readonly<Record<ReportSurface, number>> = {
  scout: 3,
  prep_report: 3,
  prep_bundle_child: 3,
  post_event_synthesis: 2,
};

/**
 * Every id this phase can emit — claim id, evidence id, or a piece of one —
 * must satisfy this pattern: it is what stands between free text and an
 * RTDB key (`. # $ [ ] /` and control characters are illegal in an RTDB
 * key). Never a hand-rolled character blacklist.
 */
export const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `value` is a safe RTDB key segment under `EVIDENCE_ID_PATTERN`. */
export function isRtdbSafeKeySegment(value: string): boolean {
  return EVIDENCE_ID_PATTERN.test(value);
}
