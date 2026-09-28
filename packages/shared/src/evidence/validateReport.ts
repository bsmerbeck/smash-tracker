/**
 * RPT-07 / D-06 / D-07 (phase 39 plan 04): the pure validator. Every claim a
 * report selects is RECOMPUTED against the immutable `EvidenceSnapshot` — a
 * citation existing is never sufficient on its own (see
 * `records/RPT-08-rubric.md`). Connective prose is linted for factual
 * specifics its own section's claims do not license. The outcome is
 * drop-then-fail: invalid claims are dropped first (rules R1-R3, R6-R7), a
 * prose fault (R4/R5 — under owner decision D-24 any figure or confidence-tier
 * word, since commentary is qualitative only — and R7's lexical half, D-22)
 * strips ONLY that section's prose and never touches claim survival (the C1-H4/C2-H3
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
 * RETIRED by owner decision D-24 (2026-09-28, code review R4-CR-01): the
 * five non-factual numeric shapes (review C2-H3) the digit rule used to
 * exempt — a list position, an ordinal suffix, "Game 1", "top-5",
 * "best-of-5". Report commentary is now QUALITATIVE ONLY, so every digit
 * withholds its section's prose and no numeric shape is exempt; the lint no
 * longer consults this list. It stays exported only so the package's public
 * surface (`evidence/index.ts`) is unchanged.
 *
 * @deprecated Not consulted by the prose lint since D-24.
 */
export const NON_FACTUAL_NUMERIC_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:^|\n)[ \t]*(\d{1,2})[.)](?=[ \t]+\S)/g,
  /\b(\d+)(?:st|nd|rd|th)\b/gi,
  /\b(?:game|set|match)[\s-]?(\d+)\b/gi,
  /\btop[\s-]?(\d+)\b/gi,
  /\bbest[\s-]?of[\s-]?(\d+)\b|\bbo(\d+)\b/gi,
]);

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
// The D-04 prose lint (R4, R5 — under owner decision D-24 any figure or
// confidence-tier word in commentary) and R7's lexical half.
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

/**
 * Owner decision D-24 (2026-09-28, code review R4-CR-01 / R4-CR-02): report
 * commentary is QUALITATIVE ONLY. Every figure a user sees comes from a
 * checked claim, which the app renders beside the prose, so a section whose
 * prose carries a figure of any form, or a word grading a finding's
 * confidence, is WITHHELD (disclosed as "commentary withheld", never
 * refunded — D-22), true or false. The model prompt states the rule up
 * front, so most commentary is written to survive it.
 *
 * Code review iteration 6 (R6-CR-01..04): the check reads EXACTLY the text
 * that is delivered. Iteration 5 folded the prose (NFKC, format characters
 * and marks removed, Markdown markers read as spaces) and ran its allowlist
 * on that copy, while the card and the `.md` export deliver the original, so
 * a roman-numeral character, a bidi override or a Markdown marker inside a
 * word reached the user as a figure the check never saw. Now nothing is
 * folded: a licensed canonical name or a licensed opponent tag consumes its
 * exact span (so the digits, symbols and accented letters INSIDE it —
 * "Pokémon Stadium 2", "Mr. Game & Watch", "Sparg0" — are not figures), and
 * every other character must be on the allowlist. The word rules then run
 * on what is left, which is plain ASCII by construction. Commentary is
 * English-only.
 */

/**
 * The characters connective prose may carry outside a licensed name or tag
 * span: ASCII letters, the space, the line feed, and the punctuation
 * `records/RPT-08-rubric.md` lists (square brackets since R6-IN-05, because
 * the prompts permit them). Anything else withholds the section — a digit
 * of any script, a roman-numeral character, a format, bidi or tag
 * character, a combining mark, a fullwidth or mathematical letterform, a
 * letter of another script, a tab, a carriage return, an emoji or a symbol.
 * The VAL-03 judge parses the same list from the rubric's text.
 */
const PROSE_DISALLOWED_CHARACTER = /[^A-Za-z \n.,;:'"!?()[\]\-–—’‘“”/]/u;

/**
 * R6-CR-03: a Markdown emphasis or code marker ANYWHERE in the section, a
 * licensed tag's own span included, withholds it. The `.md` export writes
 * the connective verbatim, where `t**w**o` renders as "two".
 */
const MARKDOWN_MARKER = /[*_~`]/;

/**
 * A spelled-out figure as a whole word, any casing: English cardinals,
 * ordinals (first to tenth, and the number-word ordinals past tenth),
 * fractions and collective or multiplicative counts ("once", "a pair", "a
 * single", "both", "none", "a trio", "double", "triple", "a brace"), record
 * words that state a zero or a whole side of a W-L record ("undefeated",
 * "winless", "swept", "perfect", "spotless", "a shutout", "never", "always",
 * "every", "all", "nothing"), even-record words ("even", "tied", "split",
 * "each"), single-result words ("lone", "only", "sole", "solo"), percentage
 * words, vague quantifiers (R5-IN-02), and the number words of the app's
 * other locales (es, fr, de, pt — R5-CR-03). An ordinal may take a plural
 * "-s" ("thirds", "seconds"), and a cardinal with "-th" is an ordinal, as the
 * VAL-03 judge's number parser reads them. R6-WR-01 added the
 * all-or-nothing, even-record, multiple, single-result and zero-side words.
 * R7-WR-01 added the even-record and zero-side words a model writes
 * naturally: "parity", "deadlock(ed)", "stalemate", "whitewash(ed)", "deuce"
 * and the jargon "JV".
 * "twenty-one" matches on "twenty"; "someone" and "often" do not, because a
 * letter on either side ends the match.
 */
const FIGURE_WORD_SOURCE =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|(?:hundred|thousand|million|billion|dozen|score)s?|half|halves|quarters?|twice|thrice|once|single|pairs?|couple|duo|trio|both|none|nil|nought|naught|(?:first|second|third|fifth|eighth|ninth|twelfth|(?:twen|thir|for|fif|six|seven|eigh|nine)tieth|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|hundred|thousand|million|billion|dozen|score)th)s?|undefeated|unbeaten|winless|sweeps?|swept|flawless|percentage|pct|percentile|most|several|few|fewer|fewest|many|majority|minority|every|all|each|never|always|nothing|zilch|zip|nada|tied|even|evenly|split|lone|only|sole|solo|double|triple|treble|brace|perfect|shutout|blank|blanked|spotless|unblemished|parity|deadlock|deadlocked|deadlocks|stalemate|stalemated|stalemates|whitewash|whitewashed|whitewashes|deuce|jv|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|une|deux|trois|quatre|cinq|huit|neuf|dix|eins|zwei|drei|vier|funf|sechs|sieben|acht|neun|zehn|dois|duas|quatro|sete|oito|nove|dez|mitad|moitie|metade';

/** `FIGURE_WORD_SOURCE` as whole words anywhere in a text. */
const FIGURE_WORD_PATTERN = new RegExp(`(?<![A-Za-z])(?:${FIGURE_WORD_SOURCE})(?![A-Za-z])`, 'i');

/** `FIGURE_WORD_SOURCE` as one whole token. */
const FIGURE_TOKEN = new RegExp(`^(?:${FIGURE_WORD_SOURCE})$`, 'i');

/**
 * R6-WR-01: the multi-word figures — a margin ("up a set", "down a game",
 * "lead them by a set"), an even or single result ("a win and a loss", "a
 * coin flip"), a multiple ("a hat trick"), a zero side ("shut you out",
 * "a clean record", "yet to beat"), and "your last set". Whitespace between
 * the words may be any run of spaces or line breaks.
 *
 * R7-WR-01 (iteration 7): the natural zero-side and even-record phrasings —
 * "no wins" / "no sets" / "no stocks", "not beaten" / "haven't beaten" /
 * "not yet won" / "not lost to" (the "t" of a contraction counts as "not"),
 * "without dropping a game" / "without losing any sets" (a count noun must
 * follow, so "without dropping a combo" ships), "a goose egg", "level with",
 * "square with", "all square" and "dead level". "No need to" and "a level
 * head" ship.
 */
const FIGURE_PHRASE_PATTERN =
  /(?<![A-Za-z])(?:(?:by|up|down)\s+an?\s+(?:set|game|stock|match)|an?\s+(?:win|loss|set|game)\s+and\s+an?\s+(?:win|loss|set|game)|hat\s+trick|coin\s+flip|shut\s+(?:\w+\s+)?out|clean\s+records?|perfect\s+records?|yet\s+to\s+(?:beat|lose|win)|last\s+(?:set|game|match)|no\s+(?:wins?|losses|sets?|games?|stocks?)|(?:not|t)\s+(?:yet\s+)?(?:beaten|won|lost\s+to)|without\s+(?:dropping|losing|winning)\s+(?:an?|any)\s+(?:single\s+)?(?:sets?|games?|stocks?|match(?:es)?|rounds?)|goose\s+eggs?|(?:level|square)\s+with|(?:all|dead)\s+(?:level|square))(?![A-Za-z])/i;

/**
 * A confidence-tier word: a STEM below, alone or with a comparative,
 * superlative, adverb or "-ish" suffix (R6-WR-01) — "lower", "highest",
 * "strongly", "lowish", "surely", "shakier", "reliably" — plus "minimal"
 * and "maximal". The stems are the shipped tier vocabulary
 * (`low`/`medium`/`high`, the keys of `LICENSED_CONFIDENCE_WORDS`), the
 * owner's grading words (`moderate`, `strong`, `weak`), the exact tier
 * synonyms of R5-CR-02, the strength adjectives of R5-IN-02 and the tier
 * words of the app's other locales. Withheld ANYWHERE in a section, Smash
 * sense included ("keep your shield high").
 */
const TIER_STEMS: readonly string[] = [
  'low',
  'medium',
  'high',
  'moderate',
  'strong',
  'weak',
  'mid',
  'middling',
  'hi',
  'lo',
  'top',
  'max',
  'min',
  'poor',
  'limited',
  'elevated',
  'solid',
  'reliable',
  'shaky',
  'certain',
  'sure',
  'iffy',
  'minimal',
  'maximal',
  'alta',
  'alto',
  'baja',
  'bajo',
  'haute',
  'basse',
  'elevee',
  'faible',
  'moyenne',
  'hoch',
  'hohe',
  'niedrig',
  'mittel',
  'schwach',
  'baixa',
  'baixo',
];

/** Every suffixed form of every tier stem: "-er", "-est", "-ly", "-ish", with the e-final ("surer"), y-final ("shakier", "shakily") and "-ble" ("reliably") spellings. */
const TIER_FORMS: ReadonlySet<string> = new Set(
  TIER_STEMS.flatMap((stem) => {
    const forms = [stem, `${stem}er`, `${stem}est`, `${stem}ly`, `${stem}ish`];
    if (stem.endsWith('e')) {
      forms.push(`${stem}r`, `${stem}st`);
    }
    if (stem.endsWith('y')) {
      const root = stem.slice(0, -1);
      forms.push(`${root}ier`, `${root}iest`, `${root}ily`);
    }
    if (stem.endsWith('le')) {
      forms.push(`${stem.slice(0, -1)}y`);
    }
    return forms;
  }),
);

/** True when `token` (any casing) is a tier word in any of its forms. */
function isTierToken(token: string): boolean {
  return TIER_FORMS.has(token.toLowerCase());
}

/** A whole token that is a well-formed roman numeral (case-insensitive), "I" included. */
const ROMAN_TOKEN = /^(?=[mdclxvi])m{0,3}(?:c[md]|d?c{0,3})(?:x[cl]|l?x{0,3})(?:i[xv]|v?i{0,3})$/i;

/**
 * R6-CR-01: English words that happen to spell a roman numeral of value two
 * or more, and the Smash term "DI". Every other standalone numeral token
 * ("ii", "iv", "XL", "V", "X") withholds the section; "I" alone is the
 * pronoun and is never read as a numeral on its own.
 */
const ROMAN_NUMERAL_EXEMPT: ReadonlySet<string> = new Set([
  'mix',
  'mid',
  'dim',
  'civil',
  'vivid',
  'did',
  'mild',
  'lid',
  'mill',
  'ill',
  'di',
]);

/** True when `token` reads as a roman numeral of value two or more (never "I", never an exempt word). */
function isRomanNumeralToken(token: string): boolean {
  const lower = token.toLowerCase();
  return lower !== 'i' && ROMAN_TOKEN.test(token) && !ROMAN_NUMERAL_EXEMPT.has(lower);
}

/**
 * R6-CR-01: a lone "I" or "V" beside "to", "and" or a hyphen or en dash
 * reads as one side of a W-L pair ("V to I", "I and I", "I-I"). "I-frame" is
 * the Smash term, not a pair. The price: "you and I" is withheld too.
 */
const LONE_NUMERAL_LETTER_IN_PAIR =
  /(?<![A-Za-z])(?:to|and)\s+[IiVv](?![A-Za-z'’])|[-–]\s*[IiVv](?![A-Za-z'’])|(?<![A-Za-z]|[A-Za-z]['’])[IiVv]\s+(?:to|and)(?![A-Za-z])|(?<![A-Za-z]|[A-Za-z]['’])[IiVv]\s*[-–](?!\s*frames?(?![A-Za-z]))/;

/**
 * R7-WR-03 (iteration 7): a lone "I" read as the numeral one — after a verb
 * or preposition that takes a count ("took", "won", "lost", "dropped", "in",
 * "for", "of", "by") and before a singular count noun ("You took I set").
 * The pronoun is never followed by a singular count noun used as an object;
 * "I set up the trap" starts a clause and ships.
 */
const LONE_ONE_BEFORE_COUNT =
  /(?<![A-Za-z])(?:took|won|lost|dropped|in|for|of|by)\s+I\s+(?:set|game|stock|match|round|win|loss)(?![A-Za-z])/i;

/**
 * R6-CR-04: two or more single letters joined by spaces or punctuation
 * ("t-w-o", "H.I.G.H", "t w o", "T, W, O") spell a word out; the run
 * withholds the section, whatever it spells. A letter is SINGLE when no
 * letter touches it and it is not part of a contraction ("I'm", "it's",
 * "o'clock"). "a" and "I" standing alone are ordinary words, and "e.g." and
 * "i.e." are exempt.
 */
const SPELLED_LETTER_RUN =
  /(?<![A-Za-z])(?<![A-Za-z]['’])[A-Za-z](?![A-Za-z]|['’][A-Za-z])(?:[\s.,;:!?()[\]"“”‘\-–—/]+(?<![A-Za-z]['’])[A-Za-z](?![A-Za-z]|['’][A-Za-z]))+/g;
const SPELLED_LETTER_EXEMPT: ReadonlySet<string> = new Set(['e.g', 'i.e']);

/** R6-CR-04: single letters chained by apostrophes ("t'w'o"), other than "I'm" and "I'd". */
const APOSTROPHE_LETTER_CHAIN = /(?<![A-Za-z'’])[A-Za-z](?:['’][A-Za-z])+(?![A-Za-z])/g;
const APOSTROPHE_CHAIN_EXEMPT: ReadonlySet<string> = new Set(["i'm", "i'd", 'i’m', 'i’d']);

/**
 * R6-WR-02: the words a glued token may be made of besides the figure and
 * tier words — the count, confidence and joining words a figure is glued to
 * ("twotimes", "highconfidence", "threeandtwo", "twofold", "toptier").
 */
const GLUE_WORDS: ReadonlySet<string> = new Set([
  'and',
  'to',
  'time',
  'times',
  'set',
  'sets',
  'game',
  'games',
  'win',
  'wins',
  'loss',
  'losses',
  'stock',
  'stocks',
  'match',
  'matches',
  'round',
  'rounds',
  'confidence',
  'confident',
  'record',
  'records',
  'straight',
  'fold',
  'tier',
  'tiers',
  'percent',
]);

/** Everyday compounds the glue rule would otherwise read as a glued figure. */
const GLUE_EXEMPT: ReadonlySet<string> = new Set(['everyone', 'midgame']);

/** True when `token` is a figure or tier word as a whole. */
function isListedWord(token: string): boolean {
  return FIGURE_TOKEN.test(token) || isTierToken(token);
}

/**
 * R6-WR-02: true when `token` segments into two or more listed or glue
 * words and its first or last segment is a figure or tier word — a glued
 * figure ("twotimes", "highconfidence", "threeandtwo"). A plain word that
 * merely CONTAINS a listed word ("often", "alone", "weight", "tone",
 * "highlight", "shout") does not segment and is not read.
 */
function isGluedFigure(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower.length < 4 || GLUE_EXEMPT.has(lower) || isListedWord(lower)) {
    return false;
  }
  // segments[i]: the ways lower.slice(0, i) splits into known words, as
  // [first segment is listed, last segment is listed, segment count].
  const reachable: Array<Array<{ firstListed: boolean; lastListed: boolean; count: number }>> =
    Array.from({ length: lower.length + 1 }, () => []);
  reachable[0]!.push({ firstListed: false, lastListed: false, count: 0 });
  for (let end = 1; end <= lower.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      if (reachable[start]!.length === 0) {
        continue;
      }
      const piece = lower.slice(start, end);
      const listed = isListedWord(piece);
      if (!listed && !GLUE_WORDS.has(piece)) {
        continue;
      }
      for (const path of reachable[start]!) {
        reachable[end]!.push({
          firstListed: path.count === 0 ? listed : path.firstListed,
          lastListed: listed,
          count: path.count + 1,
        });
      }
    }
    // Keep the table small: one path per distinct (first, last, count >= 2) shape.
    const seen = new Set<string>();
    reachable[end] = reachable[end]!.filter((path) => {
      const key = `${path.firstListed}:${path.lastListed}:${Math.min(path.count, 2)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  return reachable[lower.length]!.some(
    (path) => path.count >= 2 && (path.firstListed || path.lastListed),
  );
}

/** R6-WR-02: `token` with every run of three or more of one letter collapsed to one letter, and to two ("hiiigh" -> "high", "hiigh"). Empty when the token has no such run. */
function stretchedReadings(token: string): string[] {
  if (!/([A-Za-z])\1\1/i.test(token)) {
    return [];
  }
  return [token.replace(/([A-Za-z])\1{2,}/gi, '$1'), token.replace(/([A-Za-z])\1{2,}/gi, '$1$1')];
}

/**
 * True when `text` — plain ASCII by the time this runs (the allowlist has
 * already passed) — carries a D-24 figure or grade spelled in letters: a
 * figure word or phrase, a tier word, a roman numeral, a lone "I" or "V" in
 * a pair, letters spelled out one by one, or a glued or stretched listed word.
 */
function hasFigureOrTierWord(text: string): boolean {
  if (
    /[0-9]/.test(text) ||
    FIGURE_WORD_PATTERN.test(text) ||
    FIGURE_PHRASE_PATTERN.test(text) ||
    LONE_NUMERAL_LETTER_IN_PAIR.test(text) ||
    LONE_ONE_BEFORE_COUNT.test(text)
  ) {
    return true;
  }
  for (const match of text.matchAll(SPELLED_LETTER_RUN)) {
    if (!SPELLED_LETTER_EXEMPT.has(match[0].toLowerCase())) {
      return true;
    }
  }
  for (const match of text.matchAll(APOSTROPHE_LETTER_CHAIN)) {
    if (!APOSTROPHE_CHAIN_EXEMPT.has(match[0].toLowerCase())) {
      return true;
    }
  }
  // Word by word: a token that follows a letter and an apostrophe is the
  // tail of a contraction ("I'm", "MkLeo's") and is not a word of its own.
  for (const match of text.matchAll(/(?<![A-Za-z]['’])(?<![A-Za-z])[A-Za-z]+/g)) {
    const token = match[0];
    for (const reading of [token, ...stretchedReadings(token)]) {
      if (
        isTierToken(reading) ||
        FIGURE_TOKEN.test(reading) ||
        isRomanNumeralToken(reading) ||
        isGluedFigure(reading)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Code review R5-IN-03 / R6-WR-03: a digit- or numeral-bearing name or tag
 * ("Pokémon Stadium 2", "PictoChat 2", "75m", "Flat Zone X", "Leo 2",
 * "Sparg0") read as a count — followed by a count word.
 *
 * R7-WR-02 (iteration 7): the count word may come directly, or after one or
 * two attributive words ("Leo 2 close sets", "Pokémon Stadium 2
 * hard-fought, close games"), each optionally ending in a comma, separated by
 * whitespace. The count nouns now include "series", "bouts", "encounters",
 * "meetings", "exchanges", "matchups", "runbacks", "brackets", "tournaments"
 * and "events".
 *
 * R8-WR-01 (iteration 8): those gap words are a CLOSED list of attributive
 * words (`COUNT_GAP_WORD`, the rubric's `count-gap-words`). Iteration 7 let
 * any word bridge the gap except a determiner or a possessive, so a pronoun or
 * a verb read ordinary commentary as a count ("On Pokémon Stadium 2 you win
 * neutral", "Sparg0 closes out games", "Leo 2 likes long sets").
 */
const COUNT_NOUN_SOURCE =
  'wins?|loss(?:es)?|times?|sets?|games?|stocks?|match(?:es)?|rounds?|victor(?:y|ies)|defeats?|straight|series|bouts?|encounters?|meetings?|exchanges?|matchups?|runbacks?|brackets?|tournaments?|events?|in\\s+a\\s+row';
const COUNT_GAP_WORD =
  'close|tight|narrow|hard-fought|long|short|lopsided|decisive|straight|consecutive|back-to-back|recent|previous|past|last|total|ranked|unranked|official|online|offline|bracket|tournament|competitive|casual|friendly|money';
const NAME_COUNT_FOLLOWER = new RegExp(
  `^\\s*(?:(?:${COUNT_GAP_WORD}),?\\s+){0,2}(?:${COUNT_NOUN_SOURCE})(?![A-Za-z])`,
  'i',
);

/** True when a name or tag carries a digit or a standalone upper-case roman numeral, so a count word after it reads as a count. */
function isNumericName(name: string): boolean {
  return /[0-9]|(?<![A-Za-z])[IVXLCDM]+(?![A-Za-z])/.test(name);
}

/** The exact spellings a name or tag may be delivered in: as written, composed (NFC) and decomposed (NFD). */
function spellingsOf(name: string): string[] {
  return Array.from(new Set([name, name.normalize('NFC'), name.normalize('NFD')]));
}

/** What a consumed name or tag span becomes in the residual: a plain, unlisted word, so it neither joins nor splits the words around it. */
const CONSUMED_SPAN_PLACEHOLDER = ' Name';

/** The noun every shipped confidence sentence pairs a tier word with (`LICENSED_CONFIDENCE_WORDS`). */
const CONFIDENCE_NOUN = 'confidence';

interface ProseLintResult {
  /** True when R4, R5 or R7's lexical half fired anywhere in this section's prose — the section's PROSE is stripped, its claims are untouched. */
  offense: boolean;
}

/**
 * Lints ONE section's connective prose against the claims THAT section
 * licenses (and, for opponent tags, the full `allIssuedClaims` so a tag
 * legitimately known elsewhere in the job can still be recognized-but-
 * unlicensed rather than simply invisible). Never mutates `connective`, and
 * never reads a transformed copy of it: every rule below sees the text the
 * user is shown (R6-CR-01..04).
 */
function lintSectionProse(
  connective: string,
  licensedClaims: readonly ClaimAtom[],
  allIssuedClaims: readonly ClaimAtom[],
): ProseLintResult {
  if (connective.trim().length === 0) {
    return { offense: false };
  }

  if (
    UNKNOWN_BUCKET_NAMED_PATTERN.test(connective) ||
    UNKNOWN_BUCKET_NAMED_PATTERN.test(connective.normalize('NFC'))
  ) {
    return { offense: true };
  }

  // R6-CR-03: a Markdown marker anywhere, a tag's own span included.
  if (MARKDOWN_MARKER.test(connective)) {
    return { offense: true };
  }

  const sentences = splitSentences(connective);

  let offense = false;

  // --- R4: entity matching (fighter/stage names) ---
  //
  // Review SH-WR-01: names are scanned LONGEST FIRST and every match claims
  // its span, so a shorter canonical name contained in a longer one
  // ("Battlefield" in "Small Battlefield", "Link" in "Toon Link", "Pokémon
  // Stadium" in "Pokémon Stadium 2") is never matched a second time on its
  // own. Only a LICENSED name's span is CONSUMED for the D-24 rule below
  // (R6-CR-01..04): its digits, symbols and accented letters ("Pokémon
  // Stadium 2", "Figure-8 Circuit", "Mr. Game & Watch") are part of the
  // name, not figures. A name is matched as written, composed or decomposed,
  // never folded, so a look-alike or a numeral glyph in its place is not the
  // name and is judged character by character.
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

  const escapeName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const percentPattern = /%/g;
  const anotherEntityPatternSource = CANONICAL_ENTITY_NAMES.flatMap(spellingsOf)
    .map(escapeName)
    .join('|');

  const matchedNameSpans: Array<[number, number]> = [];
  const consumedSpans: Array<[number, number]> = [];
  const overlapsMatched = (start: number, end: number): boolean =>
    matchedNameSpans.some(([s, e]) => start < e && end > s);
  const countReadAfter = (name: string, end: number): boolean =>
    isNumericName(name) && NAME_COUNT_FOLLOWER.test(connective.slice(end));

  for (const name of CANONICAL_ENTITY_NAMES) {
    const isLicensed = licensedEntityNames.has(name.normalize('NFC'));
    for (const spelling of spellingsOf(name)) {
      const nameRe = new RegExp(`(?<![A-Za-z0-9_])${escapeName(spelling)}(?![A-Za-z0-9_])`, 'g');
      for (const match of connective.matchAll(nameRe)) {
        const start = match.index!;
        const end = start + match[0].length;
        if (overlapsMatched(start, end)) {
          continue;
        }
        matchedNameSpans.push([start, end]);
        // R5-IN-03 / R6-WR-03: a digit- or numeral-bearing name read as a count.
        if (countReadAfter(name, end)) {
          offense = true;
        }
        if (isLicensed) {
          consumedSpans.push([start, end]);
          continue;
        }
        if (AMBIGUOUS_ENTITY_SET.has(name)) {
          const sentence = sentenceContaining(sentences, start);
          const hasDigitSignal = /\d/.test(sentence.text);
          const hasPercentSignal = percentPattern.test(sentence.text);
          percentPattern.lastIndex = 0;
          const hasMarkerSignal = hasTightAdjacentMatch(connective, start, end, markerPattern());
          const hasAnotherEntitySignal =
            anotherEntityPatternSource.length > 0 &&
            hasTightAdjacentMatch(
              connective,
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
  }

  // --- R4: opponent tags ---
  //
  // A LICENSED opponent tag is a name, like a licensed canonical name: every
  // token-bounded occurrence of its exact spelling (longest tag first)
  // consumes its span, so the digits and symbols inside it ("Sparg0",
  // "Zer0Frame 2", "José") are never read as figures. Review R3-IN-02: only
  // a tag that contains a LETTER is consumed — a digit-only tag ("7") is
  // indistinguishable from a figure. Review R5-IN-03, decided fail-closed: a
  // tag that itself reads as a figure or a grade ("High", "Twice", "Leo
  // 3-2", "Leo 3 to 2", "Leo 70%", "Leo V", a tag holding a numeral glyph
  // or an invisible character)
  // is NOT consumed, so every mention of it withholds the
  // section — that costs commentary, never a claim, and never a refund
  // (D-22). R6-WR-03: a digit- or numeral-bearing tag followed by a count
  // word ("Leo 2 times", "Sparg0 wins") is a count, exactly like a name.
  const tagOf = (claim: ClaimAtom): string | null => claim.subject.opponentTag?.trim() ?? null;
  const licensedTags = new Set<string>();
  for (const claim of licensedClaims) {
    const tag = tagOf(claim);
    if (tag !== null && tag.length > 0) {
      licensedTags.add(tag.normalize('NFC'));
    }
  }
  const allKnownTags = new Set<string>();
  for (const claim of allIssuedClaims) {
    const tag = tagOf(claim);
    if (tag !== null && tag.length > 0) {
      allKnownTags.add(tag.normalize('NFC'));
    }
  }
  const tagPattern = (spelling: string, flags: string): RegExp =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${escapeName(spelling)}(?![\\p{L}\\p{N}_])`, flags);

  for (const tag of [...licensedTags].sort((a, b) => b.length - a.length)) {
    if (
      !/\p{L}/u.test(tag) ||
      /[^\P{N}0-9]|[\p{Cf}\p{Cc}]/u.test(tag) ||
      /%|(?<![A-Za-z0-9])[0-9]+\s*(?:[-–—:/]|to|and)\s*[0-9]+(?![A-Za-z0-9])/i.test(tag) ||
      hasFigureOrTierWord(tag.replace(/[^A-Za-z'’\s-]/g, ' '))
    ) {
      continue;
    }
    for (const spelling of spellingsOf(tag)) {
      for (const match of connective.matchAll(tagPattern(spelling, 'gu'))) {
        const start = match.index!;
        const end = start + match[0].length;
        if (countReadAfter(tag, end)) {
          offense = true;
        }
        if (!consumedSpans.some(([s, e]) => start < e && end > s)) {
          consumedSpans.push([start, end]);
        }
      }
    }
  }

  // Review SH-WR-01: a tag known elsewhere in the job convicts only as a
  // whole token — "Tea" never convicts "Team".
  for (const tag of allKnownTags) {
    if (licensedTags.has(tag)) {
      continue;
    }
    if (spellingsOf(tag).some((spelling) => tagPattern(spelling, 'u').test(connective))) {
      offense = true;
    }
  }

  // --- D-24: commentary is qualitative only (R4 figures, R5 tier words) ---
  //
  // Judged on the DELIVERED text with every consumed span replaced by a
  // plain placeholder word. What remains must pass the ALLOWLIST (ASCII
  // letters, the space, the line feed and the listed punctuation): any other
  // character withholds the section. The word rules then withhold a figure,
  // a record or a grade spelled in letters (R4, R5), whether or not a claim
  // in the section carries that value or tier. A W-L pair, whatever its
  // separator ("3—2", "3 to 2", "three and two", "III-II", "V to I"), is made
  // of these, so it needs no rule of its own.
  let residual = '';
  let cursor = 0;
  for (const [start, end] of [...consumedSpans].sort((a, b) => a[0] - b[0])) {
    if (start < cursor) {
      continue;
    }
    residual += connective.slice(cursor, start) + CONSUMED_SPAN_PLACEHOLDER;
    cursor = end;
  }
  residual += connective.slice(cursor);
  if (PROSE_DISALLOWED_CHARACTER.test(residual) || hasFigureOrTierWord(residual)) {
    offense = true;
  }

  // --- R5: the forbidden strength words and the noun "confidence" ---
  //
  // The strength vocabulary (`FORBIDDEN_CONFIDENCE_WORDS`) is rejected
  // outright. The noun "confidence" is licensed only by a section claim that
  // carries a tier (an all-abstention section cannot speak of confidence);
  // with no tier word and no figure beside it, it is qualitative
  // commentary ("Play this stage with confidence.").
  const licensedConfidenceWords = new Set<string>();
  for (const claim of licensedClaims) {
    for (const word of confidenceWordsFor(claim.tier)) {
      licensedConfidenceWords.add(word);
    }
  }
  const tokens = connective.toLowerCase().match(/[a-z']+/g) ?? [];
  for (const token of tokens) {
    if ((FORBIDDEN_CONFIDENCE_WORDS as readonly string[]).includes(token)) {
      offense = true;
      continue;
    }
    if (token === CONFIDENCE_NOUN && !licensedConfidenceWords.has(token)) {
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
