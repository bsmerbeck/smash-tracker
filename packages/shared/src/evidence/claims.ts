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
import type { EvidenceRow } from './snapshot.js';
import { confidenceTierFor, effectiveFloor, EVIDENCE_POLICY_VERSION } from './policy.js';

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

/**
 * D-01/RPT-05 (phase 39 plan 03): the closed predicate -> `claimKind` table,
 * decided by PREDICATE and never by the model or by a caller (the law's
 * rule 2) — a TABLE, not a judgement call repeated at each call site. Eight
 * predicates state a raw recorded count (`'fact'`): `stage_record`,
 * `stage_pick_rate`, `character_matchup_record`, `my_character_record`,
 * `head_to_head_record`, `recent_form`, `opponent_character_usage`,
 * `cohort_disclosure`. `vod_annotation` restates a recorded `(matchId,
 * seconds)` annotation — also `'fact'`. `matchup_advisor_pick` is the one
 * `'recommendation'` predicate: the deterministic character-pick directive.
 *
 * NO predicate maps to `'inference'` today: every value this phase's ten
 * predicates carry is either a raw recorded count/rate/entity or the
 * advisor's recommendation, never a DERIVED COMPARISON (a ranking, a
 * best/worst pick, a delta) — the class of predicate the law's "any
 * predicate whose value is a derived comparison... is inference" sentence
 * reserves for a predicate that does not exist yet. If a future predicate
 * computes one, it earns an `'inference'` entry here and this paragraph's
 * "no predicate is inference" claim must be updated alongside it — never
 * left to silently go stale.
 */
const CLAIM_KIND_BY_PREDICATE: Readonly<Record<ClaimPredicate, ClaimKind>> = {
  stage_record: 'fact',
  stage_pick_rate: 'fact',
  character_matchup_record: 'fact',
  my_character_record: 'fact',
  head_to_head_record: 'fact',
  recent_form: 'fact',
  opponent_character_usage: 'fact',
  cohort_disclosure: 'fact',
  matchup_advisor_pick: 'recommendation',
  vod_annotation: 'fact',
};

/**
 * Input to `buildClaimSet`: ROWS, never an API payload type and never a
 * `Database` — the builder stays importable by the pure validator (plan
 * 39-04) and by the web bundle. `surface` rides along on this input but
 * `buildClaimSet` never reads it (see the function's own doc comment) — it
 * exists so a caller doesn't need a second argument, not so the builder can
 * branch on it.
 */
export interface ClaimSetInput {
  rows: Readonly<Record<string, EvidenceRow>>;
  surface: ReportSurface;
}

/** `buildClaimSet`'s output: the issued claims, their ids in issuance order, and how many ranked candidates were cut by the vocabulary-size truncation. */
export interface ClaimSet {
  claims: readonly ClaimAtom[];
  issuedClaimIds: readonly ClaimId[];
  truncatedCandidateCount: number;
}

/** One row's-worth of decided state, before collapse/ranking/id-assignment. Never exported — an internal step of `buildClaimSet`'s pipeline. */
interface ClaimCandidate {
  predicate: ClaimPredicate;
  subject: ClaimSubject;
  value: ClaimValue;
  claimKind: ClaimKind;
  evidenceIds: string[];
  tier: ConfidenceTier | null;
  sample: SampleMeta;
  /** The row's own countable games (`sample.eligibleDenominator`) — the ranking law's "countable games" and the abstention gate's input. */
  games: number;
  /** The evidence id of the ROW that first produced this candidate — the rank law's TOTAL tiebreak key (never updated by a later collapse-merge). */
  firstEvidenceId: string;
}

/** A deterministic composite key over a `ClaimSubject`'s four axes — `null` and a real value can never collide (`null` is spelled out, never coerced to a falsy number). */
function subjectKey(subject: ClaimSubject): string {
  return [subject.myFighterId, subject.opponentFighterId, subject.stageId, subject.opponentTag]
    .map((axis) => (axis === null ? 'null' : String(axis)))
    .join('|');
}

/** A deterministic composite key over a `ClaimValue` — one arm per discriminant, so two structurally-equal values always produce the same key regardless of property insertion order (a `JSON.stringify` comparison would not have this guarantee). */
function valueKey(value: ClaimValue): string {
  switch (value.kind) {
    case 'record':
      return `record:${value.wins}:${value.losses}:${value.games}`;
    case 'rate':
      return `rate:${value.numerator}:${value.denominator}`;
    case 'count':
      return `count:${value.count}`;
    case 'entity':
      return `entity:${value.entityKind}:${value.entityId}`;
    case 'abstained':
      return `abstained:${value.gamesNeeded}`;
  }
}

/** The law's collapse key (rule 3): identical `(predicate, subject, value)` triples are ONE claim; a different predicate over an equal-looking value never collapses, because `predicate` is the first segment. */
function candidateKey(predicate: ClaimPredicate, subject: ClaimSubject, value: ClaimValue): string {
  return `${predicate}::${subjectKey(subject)}::${valueKey(value)}`;
}

/**
 * The law's rank comparator (rule 4): evidenced before abstained, then
 * higher countable games first, then ascending `firstEvidenceId` as the
 * TOTAL tiebreak.
 *
 * The tiebreak is total because `rows` is keyed by `(predicate, subject)`
 * and `evidenceIdFor` (`snapshot.ts`) is proven INJECTIVE over exactly that
 * pair — see `claimContracts.test.ts`'s "evidenceIdFor injectivity across
 * (predicate, subject)" battery, which builds every predicate against a
 * full axis battery and asserts every id produced is distinct. Two distinct
 * candidates can therefore never share a `firstEvidenceId`, which is what
 * makes this comparator a TOTAL order rather than one with an unresolved
 * tie. Do not restate this as "evidence ids are unique row keys" without
 * naming that proof (review C2-B2) — that phrasing is what let a
 * subject-only keying pass review once already.
 */
function compareCandidates(a: ClaimCandidate, b: ClaimCandidate): number {
  const aEvidenced = a.value.kind !== 'abstained';
  const bEvidenced = b.value.kind !== 'abstained';
  if (aEvidenced !== bEvidenced) {
    return aEvidenced ? -1 : 1;
  }
  if (a.games !== b.games) {
    return b.games - a.games;
  }
  if (a.firstEvidenceId !== b.firstEvidenceId) {
    return a.firstEvidenceId < b.firstEvidenceId ? -1 : 1;
  }
  return 0;
}

/**
 * The ONE deterministic claim builder every report surface runs through
 * (D-01/RPT-05) — the same evidence rows produce byte-identical claim
 * atoms, same ids, same order, same tiers, regardless of which surface
 * asked. `buildClaimSet` takes NO surface-conditional path anywhere in its
 * body (grep-gated by this plan's `<verify>`); if a future surface
 * legitimately needs a different row SET, that difference belongs in what
 * the caller puts in `input.rows`, not in a branch added here.
 *
 * The law, in the order this function executes it:
 *
 * 1. Map each row to at most one CANDIDATE. A row whose countable games
 *    (`row.sample.eligibleDenominator`) are below `effectiveFloor()`
 *    becomes an abstained candidate (`ClaimValue` kind `'abstained'`,
 *    `gamesNeeded` = the floor minus the row's games, `tier: null`);
 *    otherwise an evidenced candidate carrying the row's own `value`
 *    unchanged, with `tier` = `confidenceTierFor(games)`.
 * 2. `claimKind` is decided by PREDICATE via `CLAIM_KIND_BY_PREDICATE`
 *    above — never by the model, never by the caller.
 * 3. Collapse duplicates: two candidates with the same `(predicate,
 *    subject, value)` are ONE claim — their evidence ids are unioned, the
 *    first-encountered candidate keeps its position. A different predicate
 *    never collapses with another, even over an equal-looking value —
 *    `evidenceIdFor` puts the predicate in the id itself (review C2-B2), so
 *    `stage_record` and `stage_pick_rate` over the same stage are two rows
 *    and stay two candidates. This collapse rule is UNREACHABLE today (one
 *    row exists per `(predicate, subject)` pair by construction — the same
 *    injectivity the tiebreak above rests on) but is kept, cheaply, to
 *    guard a future row mapping that folds several rows into one claim; do
 *    not delete it as dead code.
 * 4. Rank the surviving candidates via `compareCandidates` above.
 * 5. Assign ids from `CLAIM_ID_VOCABULARY` in rank order starting at `c01`.
 *    `cohort_disclosure` candidates are EXEMPT from the truncation budget
 *    (D-09/D-10: context, never a rankable finding) — a large row set can
 *    reduce the vocabulary reserved for ranked claims, but can never
 *    truncate away the disclosure. Every other candidate beyond
 *    `CLAIM_ID_VOCABULARY_SIZE` (minus any reserved cohort slot) is
 *    reported, not silently sliced, via `truncatedCandidateCount`.
 * 6. `policyVersion` is always `EVIDENCE_POLICY_VERSION`; `sample` is
 *    carried through from the row unchanged.
 */
export function buildClaimSet(input: ClaimSetInput): ClaimSet {
  const floor = effectiveFloor();
  const candidates: ClaimCandidate[] = [];
  const indexByKey = new Map<string, number>();

  for (const [evidenceId, row] of Object.entries(input.rows)) {
    const games = row.sample.eligibleDenominator;
    const evidenced = games >= floor;
    const value: ClaimValue = evidenced
      ? row.value
      : { kind: 'abstained', gamesNeeded: floor - games };
    const tier = evidenced ? confidenceTierFor(games) : null;
    const key = candidateKey(row.predicate, row.subject, value);

    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = candidates[existingIndex]!;
      if (!existing.evidenceIds.includes(evidenceId)) {
        existing.evidenceIds.push(evidenceId);
      }
      continue;
    }

    indexByKey.set(key, candidates.length);
    candidates.push({
      predicate: row.predicate,
      subject: row.subject,
      value,
      claimKind: CLAIM_KIND_BY_PREDICATE[row.predicate],
      evidenceIds: [evidenceId],
      tier,
      sample: row.sample,
      games,
      firstEvidenceId: evidenceId,
    });
  }

  const cohortCandidates = candidates.filter(
    (candidate) => candidate.predicate === 'cohort_disclosure',
  );
  const rankable = candidates.filter((candidate) => candidate.predicate !== 'cohort_disclosure');
  rankable.sort(compareCandidates);

  const rankableBudget = Math.max(0, CLAIM_ID_VOCABULARY_SIZE - cohortCandidates.length);
  const keptRankable = rankable.slice(0, rankableBudget);
  const truncatedCandidateCount = rankable.length - keptRankable.length;

  const ordered = [...keptRankable, ...cohortCandidates];

  const claims: ClaimAtom[] = ordered.map((candidate, index) => ({
    id: CLAIM_ID_VOCABULARY[index]!,
    predicate: candidate.predicate,
    subject: candidate.subject,
    value: candidate.value,
    claimKind: candidate.claimKind,
    evidenceIds: [...candidate.evidenceIds],
    tier: candidate.tier,
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: candidate.sample,
  }));

  return {
    claims: Object.freeze(claims),
    issuedClaimIds: Object.freeze(claims.map((claim) => claim.id)),
    truncatedCandidateCount,
  };
}
