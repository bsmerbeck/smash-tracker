/**
 * RPT-07 / D-06 / D-07 (phase 39 plan 04): the pure validator. Every claim a
 * report selects is RECOMPUTED against the immutable `EvidenceSnapshot` — a
 * citation existing is never sufficient on its own (see
 * `records/RPT-08-rubric.md`). Connective prose is linted for factual
 * specifics its own section's claims do not license. The outcome is
 * drop-then-fail: invalid claims are dropped first (rules R1-R3, R6-R7), a
 * prose fault (R4/R5, and R7's lexical half — D-22) strips ONLY that
 * section's prose and never touches claim survival (the C1-H4/C2-H3
 * money-path fix — see the FAILURE SEMANTICS comment on `lintSectionProse`
 * below), and the output's `status` is decided by the surviving EVIDENCED
 * claim count (`countViableClaims`, D-23) against `MIN_VIABLE_CLAIMS[surface]`
 * alone.
 *
 * PURE: this module imports ONLY `./claims.js`, `./snapshot.js`,
 * `./policy.js`, `./types.js`, `./confidencePhrases.js`, `./predicate.js`,
 * `../fighterData.js` and `../stageData.js` — no `node:` import, no
 * `firebase`, no `fetch`, no `Database`, no module-level mutable state (see
 * `purity.test.ts`). Under NO circumstance does this module call a model,
 * retry, or mutate its input (D-07).
 */
import type { ActionId, ClaimAtom, ClaimId, ClaimValue, ReportSurface } from './claims.js';
import { MIN_VIABLE_CLAIMS, countViableClaims } from './claims.js';
import type { EvidenceRow, EvidenceSnapshot } from './snapshot.js';
import { effectiveFloor } from './policy.js';
import { FORBIDDEN_CONFIDENCE_WORDS, confidenceWordsFor } from './confidencePhrases.js';
import { SpriteList } from '../fighterData.js';
import { StageList } from '../stageData.js';

// ---------------------------------------------------------------------------
// The rubric rule ids (re-derived here, never imported from
// `adversarialFixtures.ts` — that module is test-only corpus, outside this
// module's closed import list. Kept byte-identical to plan 39-01's
// `RUBRIC_RULE_IDS` / `records/RPT-08-rubric.md`; `rpt08Oracle.test.ts`
// cross-checks the rubric record against that corpus-side list, and this
// plan's own tests cross-check this union type's members against the same
// eight ids so the two cannot silently drift apart.
// ---------------------------------------------------------------------------

/** The eight rubric rule ids (`records/RPT-08-rubric.md`) a claim or an action slot can be dropped under. */
export type RUBRIC_RULE_ID = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';

/** One dropped claim — `detail` is a short machine-readable reason, never user-facing prose and never the model's own text. */
export interface DroppedClaim {
  claimId: string;
  rule: RUBRIC_RULE_ID;
  detail: string;
}

/** One dropped action slot (rule R8), kept apart from `DroppedClaim` (review SH-WR-05): an action slot is not a claim, so it never counts toward `droppedClaimCount`. */
export interface DroppedAction {
  actionId: string;
  rule: RUBRIC_RULE_ID;
  detail: string;
}

/** One of the three fixed D-12 action slots, as the model's selection references it. `claimId` is independently nullable — a chosen action referencing no claim at all is itself an R8 offense (dropped), the same as one referencing a claim that did not survive. */
export interface ReportSelectionAction {
  actionId: ActionId;
  claimId: ClaimId | null;
}

/** One named section of the report: which issued claims it references, and the connective prose written around them. */
export interface ReportSelectionSection {
  claimIds: readonly ClaimId[];
  connective: string;
}

/**
 * The shape the model's report selection takes — sections keyed by name (an
 * OBJECT, never a positional array: an array of nullable members is the RTDB
 * null-stripping trap the moment this shape is persisted), plus the three
 * fixed, independently-nullable action slots.
 */
export interface ReportSelectionOutput {
  sections: Readonly<Record<string, ReportSelectionSection>>;
  action1: ReportSelectionAction | null;
  action2: ReportSelectionAction | null;
  action3: ReportSelectionAction | null;
}

export interface ValidateReportInput {
  snapshot: EvidenceSnapshot;
  issuedClaims: readonly ClaimAtom[];
  output: ReportSelectionOutput;
  surface: ReportSurface;
}

export interface ValidationOutcome {
  status: 'passed' | 'failed';
  survivingClaimIds: readonly string[];
  droppedClaims: readonly DroppedClaim[];
  /** Claims only — the stored "N claims couldn't be verified" count and the `report_claims_dropped` signal (review SH-WR-05 / API-IN-03). */
  droppedClaimCount: number;
  /** R8 action-slot drops, reported apart from claims. */
  droppedActions: readonly DroppedAction[];
  strippedSectionIds: readonly string[];
  policyVersion: number;
  claimSchemaVersion: number;
}

// ---------------------------------------------------------------------------
// resolveSubjectDisplayName (review C2-M6) — the ONE resolver. Plan 39-06's
// model-facing `displayName` and `projectScoutSelection`'s stage names must
// route through this same function, so the names the model is given, the
// names this lint licenses, and the names a record stores can never disagree.
// ---------------------------------------------------------------------------

const FIGHTER_NAME_BY_ID: ReadonlyMap<number, string> = new Map(
  SpriteList.map((fighter) => [fighter.id, fighter.name]),
);
const STAGE_NAME_BY_ID: ReadonlyMap<number, string> = new Map(
  StageList.map((stage) => [stage.id, stage.name]),
);

/** True when `id` is a real roster fighter / StageList stage — never the unknown bucket (id 0, which both `UNKNOWN_STAGE` and `NO_SELECTION_STAGE` use and no roster table contains) nor any other off-table id. */
function isRosterId(axis: 'fighter' | 'stage', id: number): boolean {
  return (axis === 'fighter' ? FIGHTER_NAME_BY_ID : STAGE_NAME_BY_ID).has(id);
}

/** Resolves a fighter or stage id to its canonical display name — the SAME lookup the prose lint's licensed-entity set and plan 39-06's model payload both use. Falls back to a synthetic, never-canonical string for an id absent from the table (never thrown — a defensive fallback, not expected in correctly-built input). */
export function resolveSubjectDisplayName(axis: 'fighter' | 'stage', id: number): string {
  const table = axis === 'fighter' ? FIGHTER_NAME_BY_ID : STAGE_NAME_BY_ID;
  return table.get(id) ?? `${axis}-${id}`;
}

// ---------------------------------------------------------------------------
// AMBIGUOUS_ENTITY_NAMES (review C2-M7) — MECHANICAL, computed at module
// load from `SpriteList` ∪ `StageList`, never hand-curated. The "and is also
// an ordinary English word" clause is deliberately absent (C2-M7): it made
// the list a hand-curated set the instruction merely claimed was derived.
// Every SINGLE-token canonical name requires an adjacency signal; a
// multi-token name is unambiguous and convicts on a bare match.
// `UNKNOWN_STAGE`/`NO_SELECTION_STAGE` are excluded automatically — they are
// standalone sentinel exports, never members of `StageList` (see
// `packages/shared/src/stageData.ts`'s own module doc comment).
// ---------------------------------------------------------------------------

function isSingleToken(name: string): boolean {
  return !name.includes(' ');
}

const ALL_CANONICAL_NAMES: readonly string[] = Object.freeze([
  ...SpriteList.map((fighter) => fighter.name),
  ...StageList.map((stage) => stage.name),
]);

/** Every single-token canonical fighter/stage name — the set that requires an in-sentence adjacency signal before it convicts (C2-M7). */
export const AMBIGUOUS_ENTITY_NAMES: readonly string[] = Object.freeze(
  Array.from(new Set(ALL_CANONICAL_NAMES.filter(isSingleToken))).sort(),
);

/** Every canonical fighter/stage name, single- and multi-token alike — the full recognized-entity table R4's lint scans prose against. */
const CANONICAL_ENTITY_NAMES: readonly string[] = Object.freeze(
  Array.from(new Set(ALL_CANONICAL_NAMES)).sort((a, b) => b.length - a.length),
);

const AMBIGUOUS_ENTITY_SET: ReadonlySet<string> = new Set(AMBIGUOUS_ENTITY_NAMES);

/** Matchup markers (review C1-H4) — a small, closed, exported set. A member convicts an AMBIGUOUS entity mention only when it sits immediately adjacent to that mention (see `hasAdjacentMarker`); it never fires on ordinary same-sentence co-occurrence (e.g. "gamble on a random spell" must not license "Hero"). */
export const MATCHUP_MARKERS: readonly string[] = Object.freeze([
  'vs',
  'vs.',
  'v.',
  'against',
  'on',
]);

/**
 * The five NON-FACTUAL NUMERIC shapes (review C2-H3) — the admission
 * criterion for any future addition is the same one plan 39-03 uses for
 * `FORBIDDEN_CONFIDENCE_WORDS`: the `ordinary_prose` corpus stays green AND
 * the `prose_entity`/digit-battery positive fixtures stay convicted. A
 * pattern that also lets a real figure through is not admissible.
 *
 * Every shape captures the exempt digit run in its FIRST capture group that
 * participated (`findNonFactualDigitSpans` reads the group's own indices).
 *
 * Shape 1 (list position) is deliberately narrow (review SH-CR-01): only a
 * one- or two-digit run at the START of the text or of a line, followed by
 * `.` or `)` and then whitespace and more text. The previous "any digit run
 * before `.` or `)`" form exempted every sentence-final figure ("…is 83.")
 * and the whole-number half of every decimal ("71.4%"), so unlicensed
 * figures shipped. Shape 2 keeps the ordinal SUFFIX spelling (`3rd`, `1st`)
 * as its own standalone token — the `ordinary_prose` corpus's "strike-order
 * pick 3rd" sentence needs it. Known limit, recorded rather than hidden: a
 * placement ordinal ("placed 2nd") is exempt under the same shape.
 */
export const NON_FACTUAL_NUMERIC_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:^|\n)[ \t]*(\d{1,2})[.)](?=[ \t]+\S)/g,
  /\b(\d+)(?:st|nd|rd|th)\b/gi,
  /\b(?:game|set|match)[\s-]?(\d+)\b/gi,
  /\btop[\s-]?(\d+)\b/gi,
  /\bbest[\s-]?of[\s-]?(\d+)\b|\bbo(\d+)\b/gi,
]);

/** Folds every Unicode decimal digit character to its ASCII form via a per-character NFKC normalize — leaves every non-digit character untouched, so entity-name matching is never affected. */
function foldDigitsToAscii(text: string): string {
  let result = '';
  for (const ch of text) {
    result += /\p{Nd}/u.test(ch) ? ch.normalize('NFKC') : ch;
  }
  return result;
}

/** The absolute [start, end) span of the DIGITS ONLY inside every `NON_FACTUAL_NUMERIC_PATTERNS` match in `text` — the span of the first capture group that participated, read from the match's own indices (`d` flag), so a shape whose digits are not at the END of the match (a list position followed by `.`) is located exactly. Used to exempt a digit run from R4's digit rule. */
function findNonFactualDigitSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const pattern of NON_FACTUAL_NUMERIC_PATTERNS) {
    const flags = new Set([...pattern.flags, 'g', 'd']);
    const re = new RegExp(pattern.source, [...flags].join(''));
    for (const match of text.matchAll(re)) {
      const groups = match.indices ?? [];
      for (let group = 1; group < groups.length; group += 1) {
        const span = groups[group];
        if (span !== undefined) {
          spans.push([span[0], span[1]]);
          break;
        }
      }
    }
  }
  return spans;
}

/** True when `run` — an ASCII decimal digit run, its own [start, end) span in the same folded text — matches one of `findNonFactualDigitSpans(text)` exactly. */
function isNonFactualDigitRun(
  spans: ReadonlyArray<[number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([s, e]) => s === start && e === end);
}

/** Splits `text` into sentences on the same boundary rpt08Oracle.test.ts uses (a `.`/`!`/`?` followed by whitespace), returning each sentence's own [start, end) offsets so a match can be located to its containing sentence. */
function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  const boundary = /(?<=[.!?])\s+/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index;
    sentences.push({ text: text.slice(cursor, end), start: cursor, end });
    cursor = match.index + match[0].length;
  }
  sentences.push({ text: text.slice(cursor), start: cursor, end: text.length });
  return sentences;
}

/** The sentence (from `splitSentences`) containing offset `at`. Falls back to the last sentence — `at` is always inside the source text by construction. */
function sentenceContaining(
  sentences: ReadonlyArray<{ text: string; start: number; end: number }>,
  at: number,
): { text: string; start: number; end: number } {
  return sentences.find((s) => at >= s.start && at <= s.end) ?? sentences[sentences.length - 1]!;
}

const TIGHT_ADJACENCY_WINDOW = 15;

/** True when a match of `pattern` exists in `text` within `TIGHT_ADJACENCY_WINDOW` characters immediately before or after `[start, end)` — the narrow proximity window `MATCHUP_MARKERS` and the "another matched entity" signal use, so unrelated same-sentence co-occurrence (e.g. "Hero mains ... gamble on a random spell") cannot convict. */
function hasTightAdjacentMatch(text: string, start: number, end: number, pattern: RegExp): boolean {
  const windowStart = Math.max(0, start - TIGHT_ADJACENCY_WINDOW);
  const windowEnd = Math.min(text.length, end + TIGHT_ADJACENCY_WINDOW);
  const before = text.slice(windowStart, start);
  const after = text.slice(end, windowEnd);
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  return (
    re.test(before) ||
    (() => {
      re.lastIndex = 0;
      return re.test(after);
    })()
  );
}

function markerPattern(): RegExp {
  const escaped = MATCHUP_MARKERS.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

// ---------------------------------------------------------------------------
// R2 recompute — rebuilds a claim's value from the row(s) it actually cites
// (review C2-B2: never derive the row key independently from the subject —
// use the row the claim's own `evidenceIds` fetch). Comparison law: `record`
// and `count` compare by exact integer equality; `rate` compares numerator
// and denominator as integers, never a derived float, so rounding can never
// create or hide a mismatch; `entity` compares by id, never display name.
// ---------------------------------------------------------------------------

function valuesEqual(a: ClaimValue, b: ClaimValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'record':
      return (
        b.kind === 'record' && a.wins === b.wins && a.losses === b.losses && a.games === b.games
      );
    case 'rate':
      return b.kind === 'rate' && a.numerator === b.numerator && a.denominator === b.denominator;
    case 'count':
      return b.kind === 'count' && a.count === b.count;
    case 'entity':
      return b.kind === 'entity' && a.entityKind === b.entityKind && a.entityId === b.entityId;
    case 'abstained':
      return b.kind === 'abstained';
  }
}

const SUBJECT_AXES = ['myFighterId', 'opponentFighterId', 'stageId', 'opponentTag'] as const;

/** Rubric R6's countable games for one ROW: its eligible denominator, or its raw sample size for an axis-free row (`recent_form`/`cohort_disclosure`). */
function countableGames(row: EvidenceRow): number {
  const axisFree = SUBJECT_AXES.every((axis) => row.subject[axis] === null);
  return axisFree ? row.sample.rawSampleSize : row.sample.eligibleDenominator;
}

interface ClaimVerdict {
  rule: RUBRIC_RULE_ID;
  detail: string;
}

/**
 * Rules R1, R2, R3, R6 and the recompute half of R7 for ONE claim. Returns
 * `null` when the claim survives every one of these rules; the prose-scoped
 * rules (R4, R5, and R7's lexical half) are evaluated separately, per
 * section, by `lintSectionProse` below.
 */
function validateClaim(
  claimId: string,
  issuedById: ReadonlyMap<string, ClaimAtom>,
  snapshot: EvidenceSnapshot,
): ClaimVerdict | null {
  const claim = issuedById.get(claimId);
  if (!claim) {
    return { rule: 'R1', detail: 'claim id not issued for this job' };
  }
  if (claim.evidenceIds.length === 0) {
    return { rule: 'R1', detail: 'claim carries no evidence ids' };
  }

  const rows: EvidenceRow[] = [];
  for (const evidenceId of claim.evidenceIds) {
    // Own keys only (review SH-WR-03): an id like `constructor` must never
    // resolve through the prototype chain to something that is not a row.
    if (!Object.prototype.hasOwnProperty.call(snapshot.rows, evidenceId)) {
      return { rule: 'R1', detail: `evidence id "${evidenceId}" is not a key of the snapshot` };
    }
    rows.push(snapshot.rows[evidenceId]!);
  }

  // R3 (predicate half, review SH-WR-03): every cited row carries the
  // claim's own predicate — a claim cannot borrow a row of another family.
  if (rows.some((row) => row.predicate !== claim.predicate)) {
    return { rule: 'R3', detail: 'a cited row carries a different predicate than the claim' };
  }

  // R3: every non-null axis of the claim's subject must appear in at least
  // one of the rows it cites — never derived from the subject alone.
  for (const axis of SUBJECT_AXES) {
    const axisValue = claim.subject[axis];
    if (axisValue === null) {
      continue;
    }
    const found = rows.some((row) => row.subject[axis] === axisValue);
    if (!found) {
      return {
        rule: 'R3',
        detail: `subject axis "${axis}" is not present in any row this claim cites`,
      };
    }
  }

  // R7 (structural, D-22 / review SH-WR-02): the claim's OWN ids decide the
  // unknown bucket. A fighter/stage axis — or an entity value naming a
  // fighter/stage — that is id 0 (the unknown bucket) or otherwise off the
  // roster is rejected, abstained or not: the unknown bucket is never a
  // real, pickable entity, so no claim ABOUT it is deliverable. This is
  // where R7's claim-level conviction lives now; prose naming the bucket
  // only withholds that section's prose (see `lintSectionProse`).
  const offRosterAxis =
    (claim.subject.myFighterId !== null && !isRosterId('fighter', claim.subject.myFighterId)) ||
    (claim.subject.opponentFighterId !== null &&
      !isRosterId('fighter', claim.subject.opponentFighterId)) ||
    (claim.subject.stageId !== null && !isRosterId('stage', claim.subject.stageId));
  if (offRosterAxis) {
    return {
      rule: 'R7',
      detail: 'subject names the unknown bucket or an off-roster fighter/stage id',
    };
  }
  if (
    claim.value.kind === 'entity' &&
    (claim.value.entityKind === 'fighter' || claim.value.entityKind === 'stage') &&
    !isRosterId(claim.value.entityKind, Number(claim.value.entityId))
  ) {
    return {
      rule: 'R7',
      detail: 'entity value names the unknown bucket or an off-roster fighter/stage id',
    };
  }

  // R6: an evidenced (non-abstained) claim needs at least the floor's worth
  // of countable games in EVERY cited row — read from the SNAPSHOT rows
  // (review SH-WR-03), never from the claim's own `sample`, which is exactly
  // what produced `issuedClaims`. Countable games are the row's eligible
  // denominator, or its raw sample size for an axis-free row (rubric R6).
  if (claim.value.kind !== 'abstained') {
    const floor = effectiveFloor();
    const thin = rows.find((row) => countableGames(row) < floor);
    if (thin) {
      return {
        rule: 'R6',
        detail: `only ${countableGames(thin)} countable games, below the abstention floor`,
      };
    }
  }

  // R2: recompute against EVERY cited row (review C2-B2 — the rows the
  // claim actually fetched, never a row derived independently from the
  // subject; review SH-WR-03 — all of them, not only the first). An
  // abstained value has nothing to recompute against.
  if (claim.value.kind !== 'abstained') {
    const value = claim.value;
    if (rows.some((row) => !valuesEqual(value, row.value))) {
      return {
        rule: 'R2',
        detail: 'asserted value does not match the value recomputed from the cited row(s)',
      };
    }
  }

  // R7 (recompute half): a rate's denominator must equal every cited ROW's
  // own eligible (known-field) denominator (review SH-WR-03 — the row, not
  // the claim's sample), never a raw count that could silently fold the
  // unknown bucket in.
  if (claim.value.kind === 'rate') {
    const denominator = claim.value.denominator;
    if (rows.some((row) => denominator !== row.sample.eligibleDenominator)) {
      return {
        rule: 'R7',
        detail: 'rate denominator does not equal the eligible (known-field) denominator',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The D-04 prose lint (R4, R5) and R7's lexical half.
//
// FAILURE SEMANTICS — the C1-H4 + C2-H3 money-path fix. A section failing R4
// or R5 does NOT drop that section's claims and does NOT fail the output —
// it strips that section's PROSE only: the section id joins
// `strippedSectionIds`, every claim it referenced stays in
// `survivingClaimIds` (still counting toward `MIN_VIABLE_CLAIMS`), and the
// prose itself is never edited, patched, truncated or regenerated here —
// this module reports; the API decides what to persist (plans 39-06/39-08).
// There is NO prose-driven `failed` condition at any length, not even total
// prose loss across every section — cycle 1 added one, cycle 2 (C2-H3)
// showed it reachable by a single systematic model habit the app's own
// shipped `SYSTEM_PROMPT` teaches ("Game 1: X", "top-5 characters"), which
// would refund a paying user on the live purchasable scout path for one
// stylistic word choice. `status` is decided by the surviving EVIDENCED claim count
// and by nothing else (D-07): `strippedSectionIds` never participates in
// that decision, at any length.
//
// R7's UNKNOWN-BUCKET NAMING (owner decision D-22, 2026-09-26) is a prose
// fault like R4/R5: it withholds the section's PROSE only — disclosed as
// "commentary withheld" — and never drops a claim. The claims are
// engine-authored and judged on their OWN ids (`validateClaim`'s structural
// R7 check), so a claim-drop here protected nothing and only exposed a paid
// job to a validation refund for one ordinary sentence. It also removes the
// section-order hole where a later section's drop left an earlier section's
// already-linted prose resting on a claim that was no longer stored.
// ---------------------------------------------------------------------------

/**
 * R7's lexical half — case-INSENSITIVE on purpose, plurals included: any
 * wording that names the unknown stage/character bucket ("Unknown Stage",
 * "an unknown character", "unknown stages") withholds the section's PROSE
 * (never its claims — D-22). Over-stripping prose is cheap; shipping the
 * bucket as a real entity is not. Kept a DELIBERATE, byte-identical
 * duplicate of the VAL-03 judge's own pattern (`val03Acceptance.test.ts`
 * asserts source and flags are equal) — the judge keeps its own copy so it
 * never reads the validator's decisions.
 */
export const UNKNOWN_BUCKET_NAMED_PATTERN = /\bunknown\s+(?:stage|character)s?\b/iu;

/** The noun every shipped confidence sentence pairs a tier word with (`LICENSED_CONFIDENCE_WORDS`). */
const CONFIDENCE_NOUN = 'confidence';

/** A tier word used AS a confidence word: immediately beside "confidence" (review SH-WR-01). */
const TIER_WORD_BESIDE_CONFIDENCE_PATTERN = /\b(low|medium|high)[\s-]+confidence\b/g;

interface ProseLintResult {
  /** True when R4, R5 or R7's lexical half fired anywhere in this section's prose — the section's PROSE is stripped, its claims are untouched. */
  offense: boolean;
}

/**
 * Lints ONE section's connective prose against the claims THAT section
 * licenses (and, for opponent tags, the full `allIssuedClaims` so a tag
 * legitimately known elsewhere in the job can still be recognized-but-
 * unlicensed rather than simply invisible). Never mutates `connective`.
 */
function lintSectionProse(
  connective: string,
  licensedClaims: readonly ClaimAtom[],
  allIssuedClaims: readonly ClaimAtom[],
): ProseLintResult {
  if (connective.trim().length === 0) {
    return { offense: false };
  }

  if (UNKNOWN_BUCKET_NAMED_PATTERN.test(connective.normalize('NFC'))) {
    return { offense: true };
  }

  const nfc = connective.normalize('NFC');
  const folded = foldDigitsToAscii(nfc);
  const sentences = splitSentences(folded);

  let offense = false;

  // --- R4: entity matching (fighter/stage names) ---
  //
  // Review SH-WR-01: names are scanned LONGEST FIRST and every match
  // CONSUMES its span, so a shorter canonical name contained in a longer one
  // ("Battlefield" in "Small Battlefield", "Link" in "Toon Link", "Pokémon
  // Stadium" in "Pokémon Stadium 2") is never matched a second time on its
  // own. The consumed spans also exempt the digits INSIDE a matched name
  // ("Pokémon Stadium 2", "Figure-8 Circuit") from the digit rule below — a
  // digit that is part of a canonical name is not a figure.
  const licensedEntityNames = new Set<string>();
  for (const claim of licensedClaims) {
    if (claim.subject.myFighterId !== null) {
      licensedEntityNames.add(
        resolveSubjectDisplayName('fighter', claim.subject.myFighterId).normalize('NFC'),
      );
    }
    if (claim.subject.opponentFighterId !== null) {
      licensedEntityNames.add(
        resolveSubjectDisplayName('fighter', claim.subject.opponentFighterId).normalize('NFC'),
      );
    }
    if (claim.subject.stageId !== null) {
      licensedEntityNames.add(
        resolveSubjectDisplayName('stage', claim.subject.stageId).normalize('NFC'),
      );
    }
  }

  const percentPattern = /%/g;
  const anotherEntityPatternSource = CANONICAL_ENTITY_NAMES.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');

  const consumedNameSpans: Array<[number, number]> = [];
  const overlapsConsumed = (start: number, end: number): boolean =>
    consumedNameSpans.some(([s, e]) => start < e && end > s);

  for (const name of CANONICAL_ENTITY_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g');
    for (const match of folded.matchAll(nameRe)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (overlapsConsumed(start, end)) {
        continue;
      }
      consumedNameSpans.push([start, end]);
      const isLicensed = licensedEntityNames.has(name);
      if (isLicensed) {
        continue;
      }
      if (AMBIGUOUS_ENTITY_SET.has(name)) {
        const sentence = sentenceContaining(sentences, start);
        const hasDigitSignal = /\d/.test(sentence.text);
        const hasPercentSignal = percentPattern.test(sentence.text);
        percentPattern.lastIndex = 0;
        const hasMarkerSignal = hasTightAdjacentMatch(folded, start, end, markerPattern());
        const hasAnotherEntitySignal =
          anotherEntityPatternSource.length > 0 &&
          hasTightAdjacentMatch(
            folded,
            start,
            end,
            new RegExp(`(?:${anotherEntityPatternSource})`, 'g'),
          );
        if (!hasDigitSignal && !hasPercentSignal && !hasMarkerSignal && !hasAnotherEntitySignal) {
          continue;
        }
      }
      offense = true;
    }
  }

  // --- R4: the digit rule ---
  const licensedIntegers = new Set<number>();
  for (const claim of licensedClaims) {
    const v = claim.value;
    if (v.kind === 'record') {
      licensedIntegers.add(v.wins);
      licensedIntegers.add(v.losses);
      licensedIntegers.add(v.games);
    } else if (v.kind === 'rate') {
      licensedIntegers.add(v.numerator);
      licensedIntegers.add(v.denominator);
      if (v.denominator > 0) {
        licensedIntegers.add(Math.round((v.numerator / v.denominator) * 100));
      }
    } else if (v.kind === 'count') {
      licensedIntegers.add(v.count);
    }
  }
  const nonFactualSpans = findNonFactualDigitSpans(folded);
  for (const match of folded.matchAll(/\d+/g)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (overlapsConsumed(start, end)) {
      continue;
    }
    const value = Number(match[0]);
    if (licensedIntegers.has(value)) {
      continue;
    }
    if (isNonFactualDigitRun(nonFactualSpans, start, end)) {
      continue;
    }
    offense = true;
  }

  // --- R4: opponent tags (verbatim, case-sensitive, on token boundaries) ---
  //
  // Review SH-WR-01: a tag known elsewhere in the job convicts only as a
  // whole token — "Tea" never convicts "Team".
  const licensedTags = new Set<string>();
  for (const claim of licensedClaims) {
    if (claim.subject.opponentTag !== null) {
      licensedTags.add(foldDigitsToAscii(claim.subject.opponentTag.normalize('NFC')));
    }
  }
  const allKnownTags = new Set<string>();
  for (const claim of allIssuedClaims) {
    if (claim.subject.opponentTag !== null) {
      allKnownTags.add(foldDigitsToAscii(claim.subject.opponentTag.normalize('NFC')));
    }
  }
  for (const tag of allKnownTags) {
    if (licensedTags.has(tag) || tag.length === 0) {
      continue;
    }
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(folded)) {
      offense = true;
    }
  }

  // --- R5: confidence words ---
  //
  // Review SH-WR-01: the tier words (`low`/`medium`/`high`) are ordinary
  // Smash vocabulary ("high recovery", "low percent"), so a tier word is a
  // CONFIDENCE word only when it sits next to "confidence"
  // ("high confidence", "low-confidence"). The noun "confidence" itself and
  // the forbidden strength words are still judged wherever they appear.
  const licensedConfidenceWords = new Set<string>();
  for (const claim of licensedClaims) {
    for (const word of confidenceWordsFor(claim.tier)) {
      licensedConfidenceWords.add(word);
    }
  }
  const lower = folded.toLowerCase();
  const tokens = lower.match(/[a-z']+/g) ?? [];
  for (const token of tokens) {
    if ((FORBIDDEN_CONFIDENCE_WORDS as readonly string[]).includes(token)) {
      offense = true;
      continue;
    }
    if (token === CONFIDENCE_NOUN && !licensedConfidenceWords.has(token)) {
      offense = true;
    }
  }
  for (const match of lower.matchAll(TIER_WORD_BESIDE_CONFIDENCE_PATTERN)) {
    if (!licensedConfidenceWords.has(match[1]!)) {
      offense = true;
    }
  }

  return { offense };
}

// ---------------------------------------------------------------------------
// validateReportOutput — the orchestration.
// ---------------------------------------------------------------------------

/**
 * D-06/RPT-07/D-07: the ONE pure validator every report surface's output
 * runs through. Deterministic — the traversal order is the output's own
 * (each section in its own key-insertion order, each section's `claimIds`
 * in their own array order); validating the same input twice returns a
 * deeply-equal outcome. Never calls a model, never retries, never mutates
 * `input`.
 */
export function validateReportOutput(input: ValidateReportInput): ValidationOutcome {
  const { snapshot, issuedClaims, output, surface } = input;
  const issuedById = new Map<string, ClaimAtom>(issuedClaims.map((claim) => [claim.id, claim]));

  const droppedClaims: DroppedClaim[] = [];
  const droppedIds = new Set<string>();
  const survivingIds: string[] = [];
  const seen = new Set<string>();

  function dropClaim(claimId: string, rule: RUBRIC_RULE_ID, detail: string): void {
    if (droppedIds.has(claimId)) {
      return;
    }
    droppedIds.add(claimId);
    droppedClaims.push({ claimId, rule, detail });
  }

  // Pass 1: per-claim rules (R1, R2, R3, R6, R7-recompute), output's own
  // selection order — each section in its own key order, each section's
  // claimIds in their own array order.
  for (const section of Object.values(output.sections)) {
    for (const claimId of section.claimIds) {
      if (seen.has(claimId)) {
        continue;
      }
      seen.add(claimId);
      const verdict = validateClaim(claimId, issuedById, snapshot);
      if (verdict === null) {
        survivingIds.push(claimId);
      } else {
        dropClaim(claimId, verdict.rule, verdict.detail);
      }
    }
  }

  // Pass 2: section-scoped prose lint (R4, R5, R7-lexical), same order. It
  // strips PROSE only and never drops a claim (D-22), so every section is
  // linted against the final surviving claim set — no later section can
  // change what an earlier section was licensed by (review API-WR-04).
  const strippedSectionIds: string[] = [];
  for (const [sectionId, section] of Object.entries(output.sections)) {
    const licensedClaims = section.claimIds
      .map((claimId) => issuedById.get(claimId))
      .filter((claim): claim is ClaimAtom => claim !== undefined && !droppedIds.has(claim.id));
    const result = lintSectionProse(section.connective, licensedClaims, issuedClaims);
    if (result.offense) {
      strippedSectionIds.push(sectionId);
    }
  }

  const finalSurvivingIds = survivingIds.filter((claimId) => !droppedIds.has(claimId));

  // Pass 3: R8 — a non-null action slot must reference a SURVIVING claim.
  // Its drops are ACTION drops, kept out of `droppedClaims` (SH-WR-05).
  const droppedActions: DroppedAction[] = [];
  const actions: Array<[string, ReportSelectionAction | null]> = [
    ['action1', output.action1],
    ['action2', output.action2],
    ['action3', output.action3],
  ];
  for (const [slotName, action] of actions) {
    if (action === null) {
      continue;
    }
    if (action.claimId === null) {
      droppedActions.push({
        actionId: action.actionId,
        rule: 'R8',
        detail: `${slotName} references no claim at all`,
      });
      continue;
    }
    if (!finalSurvivingIds.includes(action.claimId)) {
      droppedActions.push({
        actionId: action.actionId,
        rule: 'R8',
        detail: `${slotName} references a claim id that did not survive validation`,
      });
    }
  }

  // D-23 (review SH-CR-03): only EVIDENCED survivors count toward the
  // minimum — the same `countViableClaims` the API's pre-call fail-fast uses.
  const survivingClaims = finalSurvivingIds
    .map((claimId) => issuedById.get(claimId))
    .filter((claim): claim is ClaimAtom => claim !== undefined);
  const status: 'passed' | 'failed' =
    countViableClaims(survivingClaims) >= MIN_VIABLE_CLAIMS[surface] ? 'passed' : 'failed';

  return {
    status,
    survivingClaimIds: Object.freeze(finalSurvivingIds),
    droppedClaims: Object.freeze(droppedClaims),
    droppedClaimCount: droppedClaims.length,
    droppedActions: Object.freeze(droppedActions),
    strippedSectionIds: Object.freeze(strippedSectionIds),
    policyVersion: snapshot.policyVersion,
    claimSchemaVersion: snapshot.claimSchemaVersion,
  };
}
