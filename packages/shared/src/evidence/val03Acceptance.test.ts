import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_FAMILIES,
  ADVERSARIAL_FIXTURES,
  RUBRIC_RULE_IDS,
  type AdversarialFamily,
  type AdversarialFixture,
} from './adversarialFixtures.js';
import {
  buildClaimSet,
  type ClaimAtom,
  type ClaimId,
  type ClaimSubject,
  type ClaimValue,
  type ReportSurface,
} from './claims.js';
import type { EvidenceRow, EvidenceSnapshot } from './snapshot.js';
import { evidenceIdFor } from './snapshot.js';
import { ABSTENTION_FLOOR_GAMES, EVIDENCE_POLICY_VERSION, confidenceTierFor } from './policy.js';
import {
  UNKNOWN_BUCKET_NAMED_PATTERN,
  validateReportOutput,
  type ReportSelectionOutput,
  type ReportSelectionSection,
  type ValidationOutcome,
} from './validateReport.js';
import type { SampleMeta } from './types.js';
import { SpriteList } from '../fighterData.js';
import { StageList } from '../stageData.js';

/**
 * VAL-03 (phase 39 plan 13): THE STOP-SHIP SUITE. Across the whole committed
 * adversarial corpus (`ADVERSARIAL_FIXTURES`, plan 39-01), the number of
 * unsupported factual claims that survive validation is ZERO.
 *
 * WHAT THIS PROVES: a property of the CODE. Every fixture is driven end to
 * end — its snapshot rows through `buildClaimSet` (the one builder), its
 * hand-authored model output through `validateReportOutput` (the one
 * validator) — and every claim that SURVIVES, plus every section of prose
 * that is not stripped, is re-judged by `judgeUnsupported` /
 * `judgeDeliveredProse` below, which recompute from the fixture's RAW
 * `snapshot.rows` per the rubric (`records/RPT-08-rubric.md`) and never from
 * the validator's own decisions. Green means nothing bad-shaped in this corpus
 * can be DELIVERED.
 *
 * WHAT THIS DOES NOT PROVE: how often the real model would attempt such an
 * output. The suite never calls a model; that frequency only moves the
 * drop-rate / refund-rate the owner reads in the PREP-06 readout (D-14), never
 * whether a bad output could ship. Do not read a green run as "the model never
 * tries".
 *
 * The count is conservative. A survivor is judged whether or not its output
 * reached `MIN_VIABLE_CLAIMS` (a `failed` output delivers nothing, so this can
 * only over-count, never under-count), and every non-stripped section's prose
 * is treated as delivered.
 */

/** A rubric rule id, as `records/RPT-08-rubric.md` declares them. */
export type RubricRuleId = (typeof RUBRIC_RULE_IDS)[number];

const ROSTER_FIGHTER_IDS: ReadonlySet<number> = new Set(SpriteList.map((fighter) => fighter.id));
const ROSTER_STAGE_IDS: ReadonlySet<number> = new Set(StageList.map((stage) => stage.id));
const SUBJECT_AXES = ['myFighterId', 'opponentFighterId', 'stageId', 'opponentTag'] as const;

function isAxisFree(subject: ClaimSubject): boolean {
  return SUBJECT_AXES.every((axis) => subject[axis] === null);
}

/** The rubric's R6 "countable games" for one row: the eligible denominator, or the raw sample size for an axis-free row. */
function countableGames(row: EvidenceRow): number {
  return isAxisFree(row.subject) ? row.sample.rawSampleSize : row.sample.eligibleDenominator;
}

/** True when a fighter/stage id is a real roster/stage-list entity rather than the unknown bucket (id 0) or any other non-entity id. */
function isRealEntityId(axis: 'fighter' | 'stage', id: number): boolean {
  return axis === 'fighter' ? ROSTER_FIGHTER_IDS.has(id) : ROSTER_STAGE_IDS.has(id);
}

/** Integer-for-integer equality between an asserted value and the value a cited row stores. */
function sameFigures(asserted: ClaimValue, stored: ClaimValue): boolean {
  if (asserted.kind === 'record' && stored.kind === 'record') {
    return (
      asserted.wins === stored.wins &&
      asserted.losses === stored.losses &&
      asserted.games === stored.games
    );
  }
  if (asserted.kind === 'rate' && stored.kind === 'rate') {
    return asserted.numerator === stored.numerator && asserted.denominator === stored.denominator;
  }
  if (asserted.kind === 'count' && stored.kind === 'count') {
    return asserted.count === stored.count;
  }
  if (asserted.kind === 'entity' && stored.kind === 'entity') {
    return asserted.entityKind === stored.entityKind && asserted.entityId === stored.entityId;
  }
  return false;
}

/**
 * THE INDEPENDENT JUDGE (review C1-H9). Decides, from the snapshot's RAW
 * `rows` alone, whether `claim` is UNSUPPORTED under the rubric, returning the
 * id of the first rule that convicts it or `null`.
 *
 * It MUST NOT read the fixture's hand-written expectation record — not the
 * validator verdict, not the legacy verdict, not any field of it. That record
 * is written by the same executor who wrote the fixture, so grading against it
 * would make VAL-03's zero the corpus restating its own labelling (plan
 * 39-04's own verdict check, counted instead of asserted). This function takes
 * no fixture at all, only the snapshot and the claim, which enforces that by
 * construction; a grep gate in plan 39-13 enforces it textually.
 *
 * Rules, each mechanically re-checkable without the validator:
 * - R1: the claim cites at least one evidence id, and every one is a key of
 *   `snapshot.rows`.
 * - R3: every cited row has the claim's predicate, and every non-null subject
 *   axis of the claim appears in at least one cited row.
 * - R6: an evidenced (non-abstained) value rests on at least
 *   `ABSTENTION_FLOOR_GAMES` countable games in EVERY cited row (the raw
 *   sample size for an axis-free row, per the rubric).
 * - R2: an evidenced value equals the value EVERY cited row stores, integer
 *   for integer (a rate compared as its numerator/denominator pair, never a
 *   derived float). An abstained value carries no figure any surface renders,
 *   so there is nothing to rebuild.
 * - R7: a rate's denominator equals every cited row's eligible (known-field)
 *   denominator, and an evidenced claim never names the unknown bucket (or any
 *   non-roster id) as a real fighter or stage, in its subject or its value.
 *
 * The prose rules (R4, R5) are not re-derived here: this judge sees a claim,
 * not a section. The one prose fault that is a fact about the evidence (R7's
 * unknown-bucket naming) is re-judged by `judgeDeliveredProse` below.
 */
export function judgeUnsupported(
  snapshot: EvidenceSnapshot,
  claim: ClaimAtom,
): RubricRuleId | null {
  if (claim.evidenceIds.length === 0) {
    return 'R1';
  }
  const rows: EvidenceRow[] = [];
  for (const evidenceId of claim.evidenceIds) {
    if (!Object.prototype.hasOwnProperty.call(snapshot.rows, evidenceId)) {
      return 'R1';
    }
    rows.push(snapshot.rows[evidenceId]!);
  }

  if (rows.some((row) => row.predicate !== claim.predicate)) {
    return 'R3';
  }
  for (const axis of SUBJECT_AXES) {
    const value = claim.subject[axis];
    if (value !== null && !rows.some((row) => row.subject[axis] === value)) {
      return 'R3';
    }
  }

  if (claim.value.kind === 'abstained') {
    return null;
  }

  if (rows.some((row) => countableGames(row) < ABSTENTION_FLOOR_GAMES)) {
    return 'R6';
  }

  if (rows.some((row) => !sameFigures(claim.value, row.value))) {
    return 'R2';
  }

  const value = claim.value;
  if (value.kind === 'rate') {
    if (rows.some((row) => value.denominator !== row.sample.eligibleDenominator)) {
      return 'R7';
    }
  }
  if (value.kind === 'entity') {
    const axis =
      value.entityKind === 'fighter' || value.entityKind === 'stage' ? value.entityKind : null;
    if (axis !== null && !isRealEntityId(axis, Number(value.entityId))) {
      return 'R7';
    }
  }
  const fighterAxes = [claim.subject.myFighterId, claim.subject.opponentFighterId];
  if (fighterAxes.some((id) => id !== null && !isRealEntityId('fighter', id))) {
    return 'R7';
  }
  if (claim.subject.stageId !== null && !isRealEntityId('stage', claim.subject.stageId)) {
    return 'R7';
  }

  return null;
}

/** The unknown bucket named as a thing, e.g. "Unknown Stage" or "an unknown character". */
const UNKNOWN_BUCKET_NAMING = /\bunknown\s+(?:stage|character)s?\b/iu;

/**
 * Code review R5-WR-02 (iteration 5) and R6-WR-04 (iteration 6): the judge's
 * D-24 check is its OWN decision procedure, built from the rubric's TEXT
 * rather than from the validator's code, so a rule the validator implements
 * wrongly shows up here as a VAL-03 conviction instead of agreeing with
 * itself. It is independent in IMPLEMENTATION, not in its choice of rules:
 * both implement the rules `records/RPT-08-rubric.md` states.
 *
 * - its CHARSET and its WORD LISTS are parsed at load from the rubric ("The
 *   D-24 allowlist" and "The D-24 word lists"), never copied from
 *   `validateReport.ts`;
 * - it reads the delivered text as is (R6-WR-04): no fold, so a character
 *   the renderer keeps (a roman-numeral character, a bidi override, a tag
 *   character, a Markdown marker inside a word) is judged, not erased;
 * - it has its own tokenizer, its own number-word parser (units, teens, tens
 *   and scale words, with ordinals derived by suffix), its own roman-numeral
 *   parser (a token is a numeral when it round-trips through a canonical
 *   roman spelling), its own tier-suffix stripping and its own segmenter.
 */
const RUBRIC_TEXT = readFileSync(
  fileURLToPath(new URL('./records/RPT-08-rubric.md', import.meta.url)),
  'utf8',
);

/** The punctuation the rubric allows, parsed from its own sentence: "these punctuation marks: `…`". */
const JUDGE_ALLOWED_PUNCTUATION: ReadonlySet<string> = (() => {
  const match = /these\s+punctuation\s+marks:\s+`([^`]+)`/.exec(RUBRIC_TEXT);
  if (!match?.[1]) {
    throw new Error('RPT-08-rubric.md no longer states the D-24 allowlist punctuation');
  }
  return new Set(match[1].split(/\s+/).filter((mark) => mark.length > 0));
})();

/**
 * Code review R6-WR-04 (iteration 6): the judge's word lists, parsed from the
 * rubric's "The D-24 word lists" section — lines of the form
 * "- `key`: `items`". Items are separated by whitespace, or by " ; " for the
 * phrase lists. The judge is independent of the validator in IMPLEMENTATION
 * (its own tokenizer, number-word parser, roman-numeral parser and segmenter),
 * not in its choice of rules: both implement the rubric's rules.
 */
function rubricList(key: string, separator: RegExp = /\s+/): readonly string[] {
  const match = new RegExp(`^- \`${key}\`: \`([^\`]*)\``, 'm').exec(RUBRIC_TEXT);
  return match?.[1]
    ? match[1]
        .split(separator)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

const JUDGE_RUBRIC_LISTS = {
  figureWords: rubricList('figure-words'),
  figurePhrases: rubricList('figure-phrases', /\s*;\s*/),
  tierStems: rubricList('tier-stems'),
  tierSuffixes: rubricList('tier-suffixes'),
  romanExempt: rubricList('roman-exempt'),
  romanPairWords: rubricList('roman-pair-words'),
  countWords: rubricList('count-words'),
  countPhrases: rubricList('count-phrases', /\s*;\s*/),
  countGapWords: rubricList('count-gap-words'),
  noSingularCounts: rubricList('no-singular-counts'),
  noSingularFollowers: rubricList('no-singular-followers'),
  passiveVerbs: rubricList('passive-verbs'),
  passivePersons: rubricList('passive-persons'),
  lostToExempt: rubricList('lost-to-exempt'),
  loneOnePreceders: rubricList('lone-one-preceders'),
  loneOneCounts: rubricList('lone-one-counts'),
  glueWords: rubricList('glue-words'),
  glueExempt: rubricList('glue-exempt'),
  spelledExempt: rubricList('spelled-exempt'),
  markdownMarkers: rubricList('markdown-markers').map((codePoint) =>
    String.fromCodePoint(Number.parseInt(codePoint.replace(/^U\+/, ''), 16)),
  ),
};

/**
 * Expands one rubric phrase into every word sequence it stands for: slots are
 * separated by spaces, a slot's alternatives by "/", and a slot ending in "?"
 * may be left out ("by a/an set/game" is "by a set", "by an set", ...).
 */
function expandRubricPhrase(phrase: string): string[] {
  let sequences: string[][] = [[]];
  for (const slot of phrase.split(/\s+/)) {
    const optional = slot.endsWith('?');
    const alternatives = (optional ? slot.slice(0, -1) : slot).split('/');
    const next: string[][] = [];
    for (const sequence of sequences) {
      if (optional) {
        next.push(sequence);
      }
      for (const alternative of alternatives) {
        next.push([...sequence, alternative]);
      }
    }
    sequences = next;
  }
  return sequences.map((sequence) => sequence.join(' '));
}

for (const [key, list] of Object.entries(JUDGE_RUBRIC_LISTS)) {
  if (list.length === 0) {
    throw new Error(`RPT-08-rubric.md no longer states the D-24 word list ${key}`);
  }
}

const JUDGE_MARKDOWN_MARKERS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.markdownMarkers);

/** True when `ch` is outside the rubric's allowlist: not an ASCII letter, not the space or the line feed, not a listed mark. */
function outsideJudgeCharset(ch: string): boolean {
  return !/^[A-Za-z]$/.test(ch) && ch !== ' ' && ch !== '\n' && !JUDGE_ALLOWED_PUNCTUATION.has(ch);
}

const JUDGE_UNITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];
const JUDGE_TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const JUDGE_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const JUDGE_SCALES = ['hundred', 'thousand', 'million', 'billion', 'dozen', 'score'];
const JUDGE_IRREGULAR_ORDINALS = [
  'first',
  'second',
  'third',
  'fifth',
  'eighth',
  'ninth',
  'twelfth',
];

/** A cardinal number word: a unit, a teen, a ten, or a scale word (plural allowed). */
function isCardinalWord(token: string): boolean {
  if ([...JUDGE_UNITS, ...JUDGE_TEENS, ...JUDGE_TENS, ...JUDGE_SCALES].includes(token)) {
    return true;
  }
  return token.endsWith('s') && JUDGE_SCALES.includes(token.slice(0, -1));
}

/** An ordinal (or a plural ordinal such as "thirds" or "seconds"): irregular, "-ieth" from a ten, or "-th" on a cardinal. */
function isOrdinalWord(token: string): boolean {
  const singular = token.endsWith('s') ? token.slice(0, -1) : token;
  for (const candidate of new Set([token, singular])) {
    if (JUDGE_IRREGULAR_ORDINALS.includes(candidate)) {
      return true;
    }
    if (candidate.endsWith('ieth') && isCardinalWord(`${candidate.slice(0, -4)}y`)) {
      return true;
    }
    if (candidate.endsWith('th') && isCardinalWord(candidate.slice(0, -2))) {
      return true;
    }
  }
  return false;
}

const JUDGE_FIGURE_WORDS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.figureWords);
const JUDGE_TIER_STEM_SET: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.tierStems);
const JUDGE_GLUE_WORDS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.glueWords);
const JUDGE_GLUE_EXEMPT: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.glueExempt);
const JUDGE_ROMAN_EXEMPT: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.romanExempt);
const JUDGE_ROMAN_PAIR_WORDS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.romanPairWords);
const JUDGE_SPELLED_EXEMPT: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.spelledExempt);
const JUDGE_FIGURE_PHRASES: readonly (readonly string[])[] = JUDGE_RUBRIC_LISTS.figurePhrases
  .flatMap(expandRubricPhrase)
  .map((phrase) => phrase.split(' '));
const JUDGE_COUNT_GAP_WORDS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.countGapWords);
const JUDGE_NO_SINGULAR_COUNTS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.noSingularCounts);
const JUDGE_NO_SINGULAR_FOLLOWERS: ReadonlySet<string> = new Set(
  JUDGE_RUBRIC_LISTS.noSingularFollowers,
);
const JUDGE_PASSIVE_VERBS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.passiveVerbs);
const JUDGE_PASSIVE_PERSONS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.passivePersons);
const JUDGE_LOST_TO_EXEMPT: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.lostToExempt);
const JUDGE_LONE_ONE_PRECEDERS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.loneOnePreceders);
const JUDGE_LONE_ONE_COUNTS: ReadonlySet<string> = new Set(JUDGE_RUBRIC_LISTS.loneOneCounts);
const JUDGE_COUNT_SEQUENCES: readonly (readonly string[])[] = [
  ...JUDGE_RUBRIC_LISTS.countWords.map((word) => [word]),
  ...JUDGE_RUBRIC_LISTS.countPhrases.map((phrase) => phrase.split(/\s+/)),
];

/** A figure word: the rubric's list, or a number word this judge parses itself. */
function isFigureWord(token: string): boolean {
  return JUDGE_FIGURE_WORDS.has(token) || isCardinalWord(token) || isOrdinalWord(token);
}

/** A tier word: a rubric stem, or a stem carrying one of the rubric's suffixes (with the e-final, y-final and "-ble" spellings), found by stripping the suffix back off. */
function isTierWord(token: string): boolean {
  if (JUDGE_TIER_STEM_SET.has(token)) {
    return true;
  }
  for (const suffix of JUDGE_RUBRIC_LISTS.tierSuffixes) {
    if (token.endsWith(suffix) && JUDGE_TIER_STEM_SET.has(token.slice(0, -suffix.length))) {
      return true;
    }
  }
  for (const [ending, restore] of [
    ['r', 'e'],
    ['st', 'e'],
    ['ier', 'y'],
    ['iest', 'y'],
    ['ily', 'y'],
    ['y', 'e'],
  ] as const) {
    if (token.endsWith(ending)) {
      const stem = token.slice(0, -ending.length) + restore;
      if (JUDGE_TIER_STEM_SET.has(stem) && (ending !== 'y' || stem.endsWith('le'))) {
        return true;
      }
    }
  }
  return false;
}

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

/** The canonical roman spelling of `value` (1..3999), built digit by digit. */
function toRoman(value: number): string {
  const table: ReadonlyArray<readonly [number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let rest = value;
  let out = '';
  for (const [unit, letters] of table) {
    while (rest >= unit) {
      out += letters;
      rest -= unit;
    }
  }
  return out;
}

/** The value of `token` read as a roman numeral, or null when it is not a well-formed one (it must round-trip to the same canonical spelling). */
function romanValue(token: string): number | null {
  const lower = token.toLowerCase();
  if (lower.length === 0 || [...lower].some((ch) => !(ch in ROMAN_VALUES))) {
    return null;
  }
  let total = 0;
  for (let at = 0; at < lower.length; at += 1) {
    const here = ROMAN_VALUES[lower[at]!]!;
    const next = at + 1 < lower.length ? ROMAN_VALUES[lower[at + 1]!]! : 0;
    total += here < next ? -here : here;
  }
  return total > 0 && total < 4000 && toRoman(total) === lower ? total : null;
}

/** A roman numeral of value two or more that is not an exempt word. */
function isRomanFigure(token: string): boolean {
  const value = romanValue(token);
  return value !== null && value >= 2 && !JUDGE_ROMAN_EXEMPT.has(token.toLowerCase());
}

/** Whether `token` splits into two or more listed or glue words with a figure or tier word first or last (memoised recursion over suffixes). */
function isGlued(token: string): boolean {
  if (
    token.length < 4 ||
    JUDGE_GLUE_EXEMPT.has(token) ||
    isFigureWord(token) ||
    isTierWord(token)
  ) {
    return false;
  }
  const listed = (piece: string): boolean => isFigureWord(piece) || isTierWord(piece);
  const memo = new Map<number, Array<{ lastListed: boolean; pieces: number }>>();
  const tails = (from: number): Array<{ lastListed: boolean; pieces: number }> => {
    if (from === token.length) {
      return [{ lastListed: false, pieces: 0 }];
    }
    const cached = memo.get(from);
    if (cached) {
      return cached;
    }
    const out: Array<{ lastListed: boolean; pieces: number }> = [];
    for (let to = from + 1; to <= token.length; to += 1) {
      const piece = token.slice(from, to);
      const pieceListed = listed(piece);
      if (!pieceListed && !JUDGE_GLUE_WORDS.has(piece)) {
        continue;
      }
      for (const tail of tails(to)) {
        out.push({
          lastListed: tail.pieces === 0 ? pieceListed : tail.lastListed,
          pieces: tail.pieces + 1,
        });
      }
    }
    memo.set(from, out.slice(0, 16));
    return memo.get(from)!;
  };
  for (let to = 1; to < token.length; to += 1) {
    const first = token.slice(0, to);
    const firstListed = listed(first);
    if (!firstListed && !JUDGE_GLUE_WORDS.has(first)) {
      continue;
    }
    if (tails(to).some((tail) => tail.pieces >= 1 && (firstListed || tail.lastListed))) {
      return true;
    }
  }
  return false;
}

interface JudgeToken {
  text: string;
  start: number;
  end: number;
}

/** The judge's own tokenizer: maximal ASCII letter runs, marking the tail of a contraction ("m" in "I'm") so it is not read as a word. */
function judgeTokens(text: string): Array<JudgeToken & { contractionTail: boolean }> {
  const tokens: Array<JudgeToken & { contractionTail: boolean }> = [];
  let at = 0;
  while (at < text.length) {
    if (!/[A-Za-z]/.test(text[at]!)) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < text.length && /[A-Za-z]/.test(text[at]!)) {
      at += 1;
    }
    const before = text.slice(Math.max(0, start - 2), start);
    tokens.push({
      text: text.slice(start, at),
      start,
      end: at,
      contractionTail: /^[A-Za-z]['’]$/.test(before),
    });
  }
  return tokens;
}

const JUDGE_LETTER_SEPARATORS = /^[\s.,;:!?()[\]"“”‘\-–—/]+$/;

/** R6-CR-04, the judge's reading: two or more single letters joined only by separators, or chained by apostrophes. */
function judgeFindsSpelledLetters(text: string): boolean {
  const tokens = judgeTokens(text);
  const isSingle = (index: number): boolean => {
    const token = tokens[index]!;
    if (token.text.length !== 1 || token.contractionTail) {
      return false;
    }
    const after = text.slice(token.end, token.end + 2);
    return !/^['’][A-Za-z]$/.test(after);
  };
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!isSingle(index)) {
      continue;
    }
    let last = index;
    while (
      last + 1 < tokens.length &&
      isSingle(last + 1) &&
      JUDGE_LETTER_SEPARATORS.test(text.slice(tokens[last]!.end, tokens[last + 1]!.start))
    ) {
      last += 1;
    }
    if (last > index) {
      const run = text.slice(tokens[index]!.start, tokens[last]!.end).toLowerCase();
      if (!JUDGE_SPELLED_EXEMPT.has(run)) {
        return true;
      }
      index = last;
    }
  }
  // Apostrophe chains of single letters ("t'w'o"), other than "I'm" and "I'd".
  for (const match of text.matchAll(/(?:^|[^A-Za-z'’])((?:[A-Za-z]['’])+[A-Za-z])(?![A-Za-z])/g)) {
    const chain = match[1]!.toLowerCase().replace(/’/g, "'");
    if (chain !== "i'm" && chain !== "i'd") {
      return true;
    }
  }
  return false;
}

/** R6-CR-01, the judge's reading: a lone "I" or "V" beside a rubric pair word, or beside a hyphen or en dash ("I-frame" excepted); R7-WR-03: a lone "I" between a rubric preceder and a singular count noun. */
function judgeFindsLoneNumeralLetter(text: string): boolean {
  const tokens = judgeTokens(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (
      !/^[IiVv]$/.test(token.text) ||
      token.contractionTail ||
      /^['’]/.test(text.slice(token.end))
    ) {
      continue;
    }
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const gapBefore = previous ? text.slice(previous.end, token.start) : '';
    const gapAfter = next ? text.slice(token.end, next.start) : '';
    // R7-WR-03: "I" as the numeral one, between a rubric preceder and a singular count noun.
    if (
      /^[Ii]$/.test(token.text) &&
      previous &&
      next &&
      /^\s+$/.test(gapBefore) &&
      /^\s+$/.test(gapAfter) &&
      JUDGE_LONE_ONE_PRECEDERS.has(previous.text.toLowerCase()) &&
      JUDGE_LONE_ONE_COUNTS.has(next.text.toLowerCase())
    ) {
      return true;
    }
    if (
      previous &&
      /^\s+$/.test(gapBefore) &&
      JUDGE_ROMAN_PAIR_WORDS.has(previous.text.toLowerCase())
    ) {
      return true;
    }
    if (next && /^\s+$/.test(gapAfter) && JUDGE_ROMAN_PAIR_WORDS.has(next.text.toLowerCase())) {
      return true;
    }
    if (/[-–]\s*$/.test(text.slice(0, token.start))) {
      return true;
    }
    if (
      /^\s*[-–]/.test(text.slice(token.end)) &&
      !/^\s*[-–]\s*frames?(?![A-Za-z])/i.test(text.slice(token.end))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * R8-WR-02: the rubric's exemptions for a phrase that ends at `words[next - 1]`:
 * a `passive-verbs` word followed by "by" is the passive unless "by" is
 * followed by a name or tag (the judge's "entity" placeholder) or a
 * `passive-persons` word; "lost to" followed by a `lost-to-exempt` word names
 * a habit, not an opponent.
 */
function judgePhraseExempt(
  phrase: readonly string[],
  words: readonly string[],
  next: number,
): boolean {
  const last = phrase[phrase.length - 1]!;
  if (JUDGE_PASSIVE_VERBS.has(last) && words[next] === 'by') {
    const agent = words[next + 1];
    return !(agent !== undefined && (agent === 'entity' || JUDGE_PASSIVE_PERSONS.has(agent)));
  }
  if (phrase.length >= 2 && phrase[phrase.length - 2] === 'lost' && last === 'to') {
    const object = words[next];
    return object !== undefined && JUDGE_LOST_TO_EXEMPT.has(object);
  }
  return false;
}

/** The rubric's phrases, matched as consecutive words separated only by whitespace. */
function judgeFindsFigurePhrase(text: string): boolean {
  for (const chunk of text.split(/[^A-Za-z\s]+/)) {
    const words = chunk
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    for (let at = 0; at < words.length; at += 1) {
      if (
        JUDGE_FIGURE_PHRASES.some(
          (phrase) =>
            phrase.every((word, offset) => words[at + offset] === word) &&
            !judgePhraseExempt(phrase, words, at + phrase.length),
        )
      ) {
        return true;
      }
    }
  }
  return judgeFindsNoSingular(text);
}

/**
 * R8-WR-02: "no" and a `no-singular-counts` noun, separated by whitespace, is
 * a figure only when the noun is not attributive: a `no-singular-followers`
 * word follows it after whitespace, or a punctuation mark or the end of the
 * text does. A hyphen or an apostrophe attached to the noun ("no set-ups")
 * makes it part of another word.
 */
function judgeFindsNoSingular(text: string): boolean {
  const tokens = judgeTokens(text);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const no = tokens[index]!;
    const count = tokens[index + 1]!;
    if (
      no.text.toLowerCase() !== 'no' ||
      !/^\s+$/.test(text.slice(no.end, count.start)) ||
      !JUDGE_NO_SINGULAR_COUNTS.has(count.text.toLowerCase())
    ) {
      continue;
    }
    const after = text.slice(count.end);
    if (/^[-'’]/.test(after)) {
      continue;
    }
    if (/^\s*(?:[^\sA-Za-z]|$)/.test(after)) {
      return true;
    }
    const next = tokens[index + 2];
    if (
      next &&
      /^\s+$/.test(text.slice(count.end, next.start)) &&
      JUDGE_NO_SINGULAR_FOLLOWERS.has(next.text.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

/** R6-WR-02: a token with every run of three or more of one letter collapsed to one letter, and to two. */
function judgeStretchedReadings(token: string): string[] {
  const runs: string[] = [];
  for (const ch of token) {
    if (runs.length > 0 && runs[runs.length - 1]![0] === ch) {
      runs[runs.length - 1] += ch;
    } else {
      runs.push(ch);
    }
  }
  if (!runs.some((run) => run.length >= 3)) {
    return [];
  }
  const collapse = (keep: number): string =>
    runs.map((run) => (run.length >= 3 ? run.slice(0, keep) : run)).join('');
  return [collapse(1), collapse(2)];
}

/** The judge's figure test on text whose charset has already passed: R4 when it finds a figure. */
function judgeFindsFigure(text: string): boolean {
  if (/[0-9]/.test(text) || judgeFindsFigurePhrase(text)) {
    return true;
  }
  if (judgeFindsSpelledLetters(text) || judgeFindsLoneNumeralLetter(text)) {
    return true;
  }
  for (const token of judgeTokens(text)) {
    if (token.contractionTail) {
      continue;
    }
    for (const reading of [token.text, ...judgeStretchedReadings(token.text)]) {
      const lower = reading.toLowerCase();
      if (isFigureWord(lower) || isRomanFigure(reading) || isGlued(lower)) {
        return true;
      }
    }
  }
  return false;
}

/** The judge's grade test: R5 when a token (or a stretched reading of it) is a tier word. */
function judgeFindsTier(text: string): boolean {
  return judgeTokens(text).some(
    (token) =>
      !token.contractionTail &&
      [token.text, ...judgeStretchedReadings(token.text)].some((reading) =>
        isTierWord(reading.toLowerCase()),
      ),
  );
}

/** True when a name or tag carries a digit or a standalone upper-case roman numeral. */
function judgeNumericName(name: string): boolean {
  return /[0-9]/.test(name) || judgeTokens(name).some((token) => /^[IVXLCDM]+$/.test(token.text));
}

/**
 * True when `after` opens with one of the rubric's count words or count
 * phrases — directly, or after one or two gap words (R7-WR-02): whitespace-
 * separated words, each optionally ending in a comma, each a `count-gap-words`
 * word (R8-WR-01: a closed list, so a pronoun or a verb never bridges).
 */
function opensWithCount(after: string): boolean {
  const opensWith = (text: string): boolean => {
    const words = text.split(/[^A-Za-z]+/).map((word) => word.toLowerCase());
    return JUDGE_COUNT_SEQUENCES.some((sequence) =>
      sequence.every((word, offset) => words[offset] === word),
    );
  };
  let rest = after.trimStart();
  for (let gap = 0; ; gap += 1) {
    if (opensWith(rest)) {
      return true;
    }
    if (gap === 2) {
      return false;
    }
    const word = /^([A-Za-z]+(?:-[A-Za-z]+)*),?(\s+)/.exec(rest);
    if (!word || !JUDGE_COUNT_GAP_WORDS.has(word[1]!.toLowerCase())) {
      return false;
    }
    rest = rest.slice(word[0].length);
  }
}

/** Removes every token-bounded occurrence of `name` (as written, composed or decomposed), reporting whether a numeric name was read as a count. */
function removeName(text: string, name: string): { text: string; countRead: boolean } {
  const numeric = judgeNumericName(name);
  let out = text;
  let countRead = false;
  for (const spelling of new Set([name, name.normalize('NFC'), name.normalize('NFD')])) {
    let rebuilt = '';
    let from = 0;
    for (let at = out.indexOf(spelling); at !== -1; at = out.indexOf(spelling, at + 1)) {
      const before = at > 0 ? out[at - 1]! : '';
      const after = out[at + spelling.length] ?? '';
      if (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after) || at < from) {
        continue;
      }
      rebuilt += `${out.slice(from, at)} entity`;
      from = at + spelling.length;
      if (numeric && opensWithCount(out.slice(from))) {
        countRead = true;
      }
    }
    out = rebuilt + out.slice(from);
  }
  return { text: out, countRead };
}

/** The rubric's R5-IN-03 rule: a tag reads as a figure or a grade when it holds a digit pair or a numeral glyph, or when its letters do. */
function tagReadsAsFigure(tag: string): boolean {
  const letters = tag.replace(/[^A-Za-z'’\s-]/g, ' ');
  return (
    /[0-9]+\s*(?:[-–—:/]|to|and)\s*[0-9]+/i.test(tag) ||
    tag.includes('%') ||
    /[^\P{N}0-9]|[\p{Cf}\p{Cc}]/u.test(tag) ||
    judgeFindsFigure(letters) ||
    judgeFindsTier(letters)
  );
}

/**
 * Re-judges DELIVERED prose (a section the validator did not strip) from the
 * text alone, exactly as the user is shown it (code review R6-WR-04: no fold):
 * - R7: it must not name the unknown stage/character bucket as if it were a
 *   real, pickable entity.
 * - D-24 (owner decision, 2026-09-28): commentary is qualitative only. A
 *   Markdown marker anywhere convicts under R4. After the names and tags are
 *   removed, a character outside the rubric's charset or a figure (a parsed
 *   number word, a listed figure word or phrase, a roman numeral, a lone "I"
 *   or "V" in a pair, letters spelled out, a glued or stretched listed word,
 *   or a count word after a numeric name) convicts under R4, and a tier word
 *   convicts under R5.
 *
 * `names` are the canonical fighter/stage names the prose may legitimately
 * contain, and `tags` the job's opponent tags. Only a name with at least one
 * letter is removed, so "Sparg0" or "Pokémon Stadium 2" is a name while a
 * digit-only tag stays a figure; and a TAG that itself reads as a figure or a
 * grade ("High", "Leo 3-2") is not removed (the rubric's R5-IN-03 rule).
 */
export function judgeDeliveredProse(
  prose: string,
  names: readonly string[] = [],
  tags: readonly string[] = [],
): RubricRuleId | null {
  if (UNKNOWN_BUCKET_NAMING.test(prose) || UNKNOWN_BUCKET_NAMING.test(prose.normalize('NFC'))) {
    return 'R7';
  }
  if ([...prose].some((ch) => JUDGE_MARKDOWN_MARKERS.has(ch))) {
    return 'R4';
  }
  let residual = prose;
  let countRead = false;
  const removable = [
    ...names,
    ...tags.map((tag) => tag.trim()).filter((tag) => !tagReadsAsFigure(tag)),
  ].filter((name) => /\p{L}/u.test(name));
  for (const name of [...removable].sort((a, b) => b.length - a.length)) {
    const removed = removeName(residual, name);
    residual = removed.text;
    countRead ||= removed.countRead;
  }
  if (countRead || [...residual].some(outsideJudgeCharset) || judgeFindsFigure(residual)) {
    return 'R4';
  }
  if (judgeFindsTier(residual)) {
    return 'R5';
  }
  return null;
}

/** The canonical fighter and stage names, read from the roster tables. */
const CANONICAL_NAMES: readonly string[] = [
  ...SpriteList.map((fighter) => fighter.name),
  ...StageList.map((stage) => stage.name),
];

/** The opponent tags a run's delivered prose may carry: those in the snapshot's own rows and the issued claims. */
function tagsFor(snapshot: EvidenceSnapshot, issuedClaims: readonly ClaimAtom[]): string[] {
  return [
    ...Object.values(snapshot.rows).map((row) => row.subject.opponentTag),
    ...issuedClaims.map((claim) => claim.subject.opponentTag),
  ].filter((tag): tag is string => tag !== null);
}

// ---------------------------------------------------------------------------
// The end-to-end pipeline. Nothing below reads a fixture's expectation record.
// ---------------------------------------------------------------------------

/** Survivors are surface-independent (the surface only sets the output's `MIN_VIABLE_CLAIMS` status); one surface is enough for the count. */
const SURFACE: ReportSurface = 'scout';

const ZERO_SAMPLE: SampleMeta = {
  rawSampleSize: 0,
  eligibleDenominator: 0,
  knownFieldCoverage: 0,
  dateRange: null,
  refreshedAt: 0,
  evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
  recencyTreatment: 'unweighted',
  confidenceTier: null,
};

/** The metadata of a claim whose citation points at no row at all (the `citation_missing` family): nothing to inherit from the builder. */
function phantomAtom(id: ClaimId): ClaimAtom {
  return {
    id,
    predicate: 'stage_record',
    subject: { myFighterId: null, opponentFighterId: null, stageId: null, opponentTag: null },
    value: { kind: 'abstained', gamesNeeded: ABSTENTION_FLOOR_GAMES },
    claimKind: 'fact',
    evidenceIds: [],
    tier: null,
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: ZERO_SAMPLE,
  };
}

/**
 * The claims a fixture's adversarial output tries to deliver. Each one starts
 * from the atom `buildClaimSet` issued for the row it cites (predicate,
 * subject, sample, tier, kind all come from the builder), then carries the
 * output's own claim id, citation and ASSERTED value — the untrusted part. An
 * output claim id outside the fixture's issued set is not issued at all, so it
 * reaches the validator as a selection with no atom behind it.
 */
function adversarialIssuedClaims(fixture: AdversarialFixture): ClaimAtom[] {
  const issuedByEngine = buildClaimSet({ rows: fixture.snapshot.rows, surface: SURFACE }).claims;
  return fixture.output.claims
    .filter((claim) => fixture.issuedClaimIds.includes(claim.claimId as ClaimId))
    .map((claim) => {
      const id = claim.claimId as ClaimId;
      const base =
        issuedByEngine.find((atom) =>
          claim.evidenceIds.some((evidenceId) => atom.evidenceIds.includes(evidenceId)),
        ) ?? phantomAtom(id);
      return { ...base, id, evidenceIds: [...claim.evidenceIds], value: claim.assertedValue };
    });
}

/** The fixture's selection: one section per prose section (plus a prose-free carrier for any claim no section references), or one prose-free section selecting every output claim. */
function adversarialSelection(fixture: AdversarialFixture): ReportSelectionOutput {
  const sections: Record<string, ReportSelectionSection> = {};
  const outputClaimIds = fixture.output.claims.map((claim) => claim.claimId as ClaimId);
  if (fixture.sections && fixture.sections.length > 0) {
    fixture.sections.forEach((section, index) => {
      sections[`section-${index}`] = {
        claimIds: section.licensedClaimIds,
        connective: section.prose,
      };
    });
    const referenced = new Set(Object.values(sections).flatMap((section) => section.claimIds));
    const carried = outputClaimIds.filter((id) => !referenced.has(id));
    if (carried.length > 0) {
      sections['claims-carrier'] = { claimIds: carried, connective: '' };
    }
  } else {
    sections.main = { claimIds: outputClaimIds, connective: '' };
  }
  const [action1, action2, action3] = fixture.actions ?? [null, null, null];
  return { sections, action1, action2, action3 };
}

type PipelinePath = 'adversarial' | 'engine';

interface PipelineRun {
  fixtureId: string;
  family: AdversarialFamily;
  path: PipelinePath;
  snapshot: EvidenceSnapshot;
  issuedClaims: readonly ClaimAtom[];
  selection: ReportSelectionOutput;
  outcome: ValidationOutcome;
}

/** Drives one fixture's adversarial output through the builder and the validator. */
function runAdversarial(fixture: AdversarialFixture): PipelineRun {
  const issuedClaims = adversarialIssuedClaims(fixture);
  const selection = adversarialSelection(fixture);
  const outcome = validateReportOutput({
    snapshot: fixture.snapshot,
    issuedClaims,
    output: selection,
    surface: SURFACE,
  });
  return {
    fixtureId: fixture.id,
    family: fixture.family,
    path: 'adversarial',
    snapshot: fixture.snapshot,
    issuedClaims,
    selection,
    outcome,
  };
}

/** Drives the same snapshot's ENGINE issue (every claim `buildClaimSet` emits, all selected, no prose) through the validator — the builder's own output is judged too. */
function runEngine(
  fixture: AdversarialFixture,
  transform?: (claim: ClaimAtom) => ClaimAtom,
): PipelineRun {
  const built = buildClaimSet({ rows: fixture.snapshot.rows, surface: SURFACE }).claims;
  const issuedClaims = transform ? built.map(transform) : built;
  const selection: ReportSelectionOutput = {
    sections: { engine: { claimIds: issuedClaims.map((claim) => claim.id), connective: '' } },
    action1: null,
    action2: null,
    action3: null,
  };
  const outcome = validateReportOutput({
    snapshot: fixture.snapshot,
    issuedClaims,
    output: selection,
    surface: SURFACE,
  });
  return {
    fixtureId: fixture.id,
    family: fixture.family,
    path: 'engine',
    snapshot: fixture.snapshot,
    issuedClaims,
    selection,
    outcome,
  };
}

interface Conviction {
  fixtureId: string;
  path: PipelinePath;
  claimId: string | null;
  sectionId: string | null;
  rule: RubricRuleId;
}

/** Every surviving claim the judge convicts, plus every delivered section whose prose the judge convicts. */
function convictionsOf(run: PipelineRun): Conviction[] {
  const convictions: Conviction[] = [];
  const issuedById = new Map(run.issuedClaims.map((claim) => [claim.id as string, claim]));
  for (const claimId of run.outcome.survivingClaimIds) {
    const claim = issuedById.get(claimId);
    // A survivor with no issued atom behind it cannot be recomputed at all: R1.
    const rule = claim ? judgeUnsupported(run.snapshot, claim) : 'R1';
    if (rule !== null) {
      convictions.push({
        fixtureId: run.fixtureId,
        path: run.path,
        claimId,
        sectionId: null,
        rule,
      });
    }
  }
  const stripped = new Set(run.outcome.strippedSectionIds);
  const tags = tagsFor(run.snapshot, run.issuedClaims);
  for (const [sectionId, section] of Object.entries(run.selection.sections)) {
    if (stripped.has(sectionId)) {
      continue;
    }
    const rule = judgeDeliveredProse(section.connective, CANONICAL_NAMES, tags);
    if (rule !== null) {
      convictions.push({
        fixtureId: run.fixtureId,
        path: run.path,
        claimId: null,
        sectionId,
        rule,
      });
    }
  }
  return convictions;
}

function describeConvictions(convictions: readonly Conviction[]): string {
  return convictions
    .map(
      (c) =>
        `fixture "${c.fixtureId}" (${c.path} path): ${
          c.claimId !== null ? `claim ${c.claimId}` : `delivered section "${c.sectionId}"`
        } survived validation but the independent judge convicts it under ${c.rule}`,
    )
    .join('\n');
}

/** +1 on the first figure a value asserts; `null` for a value with no figure (an entity or an abstention). */
function perturbFigure(value: ClaimValue): ClaimValue | null {
  switch (value.kind) {
    case 'record':
      return { ...value, wins: value.wins + 1 };
    case 'rate':
      return { ...value, numerator: value.numerator + 1 };
    case 'count':
      return { ...value, count: value.count + 1 };
    case 'entity':
    case 'abstained':
      return null;
  }
}

/** The metamorphic transform (C1-H9): every asserted figure in the fixture's output, +1. A pure function of the fixture's output and nothing else. */
function perturbAssertedFigures(fixture: AdversarialFixture): AdversarialFixture {
  return {
    ...fixture,
    output: {
      claims: fixture.output.claims.map((claim) => ({
        ...claim,
        assertedValue: perturbFigure(claim.assertedValue) ?? claim.assertedValue,
      })),
    },
  };
}

/**
 * Families whose fixtures carry a fault the pipeline must REJECT, taken from
 * the family column of `records/RPT-08-rubric.md`'s rule table. Rejection is
 * observed on the validator's outcome (a dropped claim or action, a stripped
 * section, or — for a cold start — a failed output with nothing surviving);
 * this is the non-vacuity check that the suite has cases which must fail, not
 * the VAL-03 count.
 */
const MUST_REJECT_FAMILIES: readonly AdversarialFamily[] = [
  'wrong_value',
  'citation_missing',
  'unissued_claim_id',
  'prose_entity',
  'confidence_word',
  'unknown_bucket',
  'sub_floor',
  'tier_boundary',
  'cold_start',
  'action_unlinked',
];

function wasRejected(run: PipelineRun): boolean {
  const { outcome } = run;
  return (
    outcome.droppedClaimCount > 0 ||
    outcome.droppedActions.length > 0 ||
    outcome.strippedSectionIds.length > 0 ||
    (outcome.status === 'failed' && outcome.survivingClaimIds.length === 0)
  );
}

const ADVERSARIAL_RUNS: readonly PipelineRun[] = ADVERSARIAL_FIXTURES.map(runAdversarial);
const ENGINE_RUNS: readonly PipelineRun[] = ADVERSARIAL_FIXTURES.map((fixture) =>
  runEngine(fixture),
);
const ALL_RUNS: readonly PipelineRun[] = [...ADVERSARIAL_RUNS, ...ENGINE_RUNS];

describe('VAL-03 stop-ship: zero unsupported factual claims survive the full adversarial corpus', () => {
  it('the corpus is non-empty and at least as large as the declared family list', () => {
    expect(ADVERSARIAL_FIXTURES.length).toBeGreaterThan(0);
    expect(ADVERSARIAL_RUNS.length).toBe(ADVERSARIAL_FIXTURES.length);
    expect(ADVERSARIAL_RUNS.length).toBeGreaterThanOrEqual(ADVERSARIAL_FAMILIES.length);
  });

  it('every declared family contributed at least one fixture to the run', () => {
    const contributed = new Set(ADVERSARIAL_RUNS.map((run) => run.family));
    const missing = ADVERSARIAL_FAMILIES.filter((family) => !contributed.has(family));
    expect(missing, `declared families with no fixture in the run: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('the judge actually judged something: the run has surviving claims and at least one output that clears MIN_VIABLE_CLAIMS', () => {
    const judged = ALL_RUNS.reduce((sum, run) => sum + run.outcome.survivingClaimIds.length, 0);
    expect(judged).toBeGreaterThan(0);
    expect(ALL_RUNS.some((run) => run.outcome.status === 'passed')).toBe(true);
  });

  it('VAL-03: across every fixture, on both the adversarial and the engine path, the independent judge convicts ZERO survivors', () => {
    const convictions = ALL_RUNS.flatMap(convictionsOf);
    expect(convictions, describeConvictions(convictions)).toEqual([]);
    expect(convictions.length).toBe(0);
  });

  it('the control survives: the well_formed fixture keeps its claim, so the validator is not rejecting everything', () => {
    const controls = ADVERSARIAL_RUNS.filter((run) => run.family === 'well_formed');
    expect(controls.length).toBeGreaterThan(0);
    for (const run of controls) {
      expect(run.outcome.survivingClaimIds.length, run.fixtureId).toBeGreaterThan(0);
      expect(run.outcome.droppedClaims, run.fixtureId).toEqual([]);
      expect(run.outcome.strippedSectionIds, run.fixtureId).toEqual([]);
    }
  });

  it.each(MUST_REJECT_FAMILIES)(
    'the %s family has at least one fixture the pipeline rejects',
    (family) => {
      const runs = ADVERSARIAL_RUNS.filter((run) => run.family === family);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.some(wasRejected)).toBe(true);
    },
  );

  it('C1-H9 metamorphic proof: +1 on every well_formed asserted figure drops the survivor count to zero, and the judge convicts every perturbed claim under R2', () => {
    // This is what makes the stop-ship number a measurement of the CODE
    // rather than of the corpus's own labelling: no expectation field is
    // read, the transform is pure, and a validator or judge that agreed with
    // whatever it was given would leave the perturbed claims standing.
    const controls = ADVERSARIAL_FIXTURES.filter((fixture) => fixture.family === 'well_formed');
    expect(controls.length).toBeGreaterThan(0);
    for (const fixture of controls) {
      const baseline = runAdversarial(fixture);
      expect(baseline.outcome.survivingClaimIds.length, fixture.id).toBeGreaterThan(0);

      const mutated = runAdversarial(perturbAssertedFigures(fixture));
      expect(mutated.issuedClaims.length, fixture.id).toBeGreaterThan(0);
      expect(mutated.outcome.survivingClaimIds, fixture.id).toEqual([]);
      for (const claim of mutated.issuedClaims) {
        expect(judgeUnsupported(fixture.snapshot, claim), `${fixture.id} ${claim.id}`).toBe('R2');
      }
    }
  });

  it('C1-H9 metamorphic proof on the engine path: +1 on every figure the builder issues, across the corpus, leaves no perturbed claim standing', () => {
    let perturbed = 0;
    for (const fixture of ADVERSARIAL_FIXTURES) {
      const perturbedIds = new Set<string>();
      const run = runEngine(fixture, (claim) => {
        const value = perturbFigure(claim.value);
        if (value === null) {
          return claim;
        }
        perturbedIds.add(claim.id);
        return { ...claim, value };
      });
      perturbed += perturbedIds.size;
      const standing = run.outcome.survivingClaimIds.filter((id) => perturbedIds.has(id));
      expect(standing, fixture.id).toEqual([]);
      for (const claim of run.issuedClaims.filter((atom) => perturbedIds.has(atom.id))) {
        expect(judgeUnsupported(fixture.snapshot, claim), `${fixture.id} ${claim.id}`).toBe('R2');
      }
    }
    expect(perturbed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The judge's own unit tests: one supported claim, one violation per rule.
// ---------------------------------------------------------------------------

const MARTH = 23;
const BATTLEFIELD = 1;
const UNKNOWN_BUCKET_ID = 0;
const JUDGE_GAMES = 10;

function judgeSample(games: number, overrides: Partial<SampleMeta> = {}): SampleMeta {
  return {
    rawSampleSize: games,
    eligibleDenominator: games,
    knownFieldCoverage: 1,
    dateRange: null,
    refreshedAt: 0,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: 'unweighted',
    confidenceTier: confidenceTierFor(games),
    ...overrides,
  };
}

const STAGE_SUBJECT: ClaimSubject = {
  myFighterId: MARTH,
  opponentFighterId: null,
  stageId: BATTLEFIELD,
  opponentTag: null,
};
const STAGE_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: STAGE_SUBJECT,
  opponentOrder: [],
});
const RATE_SUBJECT: ClaimSubject = { ...STAGE_SUBJECT, myFighterId: null };
const RATE_ROW_ID = evidenceIdFor({
  predicate: 'stage_pick_rate',
  subject: RATE_SUBJECT,
  opponentOrder: [],
});

function judgeSnapshot(rows: Record<string, EvidenceRow>): EvidenceSnapshot {
  return {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: 1,
    refreshedAt: 0,
    cohort: {
      online: 0,
      offline: 0,
      unspecified: 0,
      manual: 0,
      startgg: 0,
      parrygg: 0,
      mixedContext: false,
      minorityShare: 0,
      minorityLabel: null,
      majorityLabel: null,
    },
    rows,
    matchIdDigest: { count: 0, hash: 'judge-unit-test' },
  };
}

const JUDGE_SNAPSHOT = judgeSnapshot({
  [STAGE_ROW_ID]: {
    predicate: 'stage_record',
    subject: STAGE_SUBJECT,
    value: { kind: 'record', wins: 6, losses: 4, games: JUDGE_GAMES },
    sample: judgeSample(JUDGE_GAMES),
  },
  [RATE_ROW_ID]: {
    predicate: 'stage_pick_rate',
    subject: RATE_SUBJECT,
    value: { kind: 'rate', numerator: 4, denominator: JUDGE_GAMES },
    sample: judgeSample(JUDGE_GAMES),
  },
});

function supportedClaim(overrides: Partial<ClaimAtom> = {}): ClaimAtom {
  return {
    id: 'c01',
    predicate: 'stage_record',
    subject: STAGE_SUBJECT,
    value: { kind: 'record', wins: 6, losses: 4, games: JUDGE_GAMES },
    claimKind: 'fact',
    evidenceIds: [STAGE_ROW_ID],
    tier: confidenceTierFor(JUDGE_GAMES),
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: judgeSample(JUDGE_GAMES),
    ...overrides,
  };
}

describe('judgeUnsupported: the independent rubric recompute (C1-H9)', () => {
  it('a claim the snapshot supports returns null', () => {
    expect(judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim())).toBeNull();
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({
          predicate: 'stage_pick_rate',
          subject: RATE_SUBJECT,
          value: { kind: 'rate', numerator: 4, denominator: JUDGE_GAMES },
          evidenceIds: [RATE_ROW_ID],
        }),
      ),
    ).toBeNull();
  });

  it('an abstained claim asserts no figure and returns null even on a thin row', () => {
    const thin = judgeSnapshot({
      [STAGE_ROW_ID]: {
        predicate: 'stage_record',
        subject: STAGE_SUBJECT,
        value: { kind: 'record', wins: 1, losses: 0, games: 1 },
        sample: judgeSample(1),
      },
    });
    expect(
      judgeUnsupported(thin, supportedClaim({ value: { kind: 'abstained', gamesNeeded: 2 } })),
    ).toBeNull();
  });

  it('R1: an evidence id absent from the snapshot, or no evidence id at all', () => {
    expect(
      judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ evidenceIds: ['sr-f999-s999'] })),
    ).toBe('R1');
    expect(judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ evidenceIds: [] }))).toBe('R1');
    // An inherited Object property name is not a row.
    expect(judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ evidenceIds: ['constructor'] }))).toBe(
      'R1',
    );
  });

  it('R2: a real citation paired with a wrong number', () => {
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({ value: { kind: 'record', wins: 7, losses: 4, games: JUDGE_GAMES } }),
      ),
    ).toBe('R2');
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({
          predicate: 'stage_pick_rate',
          subject: RATE_SUBJECT,
          value: { kind: 'rate', numerator: 5, denominator: JUDGE_GAMES },
          evidenceIds: [RATE_ROW_ID],
        }),
      ),
    ).toBe('R2');
    // A different value kind over the same row is a mismatch, not a pass.
    expect(
      judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ value: { kind: 'count', count: 6 } })),
    ).toBe('R2');
  });

  it('R3: a subject axis no cited row carries, or a predicate the cited row does not have', () => {
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({ subject: { ...STAGE_SUBJECT, opponentFighterId: 59 } }),
      ),
    ).toBe('R3');
    expect(
      judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ predicate: 'my_character_record' })),
    ).toBe('R3');
  });

  it('R6: an evidenced figure on fewer than ABSTENTION_FLOOR_GAMES countable games', () => {
    const games = ABSTENTION_FLOOR_GAMES - 1;
    const thin = judgeSnapshot({
      [STAGE_ROW_ID]: {
        predicate: 'stage_record',
        subject: STAGE_SUBJECT,
        value: { kind: 'record', wins: games, losses: 0, games },
        sample: judgeSample(games),
      },
    });
    expect(
      judgeUnsupported(
        thin,
        supportedClaim({ value: { kind: 'record', wins: games, losses: 0, games } }),
      ),
    ).toBe('R6');
  });

  it('R7: a rate whose denominator folds in the unknown bucket, and the unknown bucket named as a real entity', () => {
    const withUnknown = JUDGE_GAMES + 2;
    const folded = judgeSnapshot({
      [RATE_ROW_ID]: {
        predicate: 'stage_pick_rate',
        subject: RATE_SUBJECT,
        value: { kind: 'rate', numerator: 4, denominator: withUnknown },
        sample: judgeSample(withUnknown, { eligibleDenominator: JUDGE_GAMES }),
      },
    });
    expect(
      judgeUnsupported(
        folded,
        supportedClaim({
          predicate: 'stage_pick_rate',
          subject: RATE_SUBJECT,
          value: { kind: 'rate', numerator: 4, denominator: withUnknown },
          evidenceIds: [RATE_ROW_ID],
        }),
      ),
    ).toBe('R7');

    const unknownStageSubject: ClaimSubject = { ...STAGE_SUBJECT, stageId: UNKNOWN_BUCKET_ID };
    const unknownStageRowId = evidenceIdFor({
      predicate: 'stage_record',
      subject: unknownStageSubject,
      opponentOrder: [],
    });
    const named = judgeSnapshot({
      [unknownStageRowId]: {
        predicate: 'stage_record',
        subject: unknownStageSubject,
        value: { kind: 'record', wins: 6, losses: 4, games: JUDGE_GAMES },
        sample: judgeSample(JUDGE_GAMES),
      },
    });
    expect(
      judgeUnsupported(
        named,
        supportedClaim({ subject: unknownStageSubject, evidenceIds: [unknownStageRowId] }),
      ),
    ).toBe('R7');

    const entityRowId = evidenceIdFor({
      predicate: 'matchup_advisor_pick',
      subject: { ...STAGE_SUBJECT, stageId: null },
      opponentOrder: [],
    });
    const entity = judgeSnapshot({
      [entityRowId]: {
        predicate: 'matchup_advisor_pick',
        subject: { ...STAGE_SUBJECT, stageId: null },
        value: { kind: 'entity', entityKind: 'fighter', entityId: String(UNKNOWN_BUCKET_ID) },
        sample: judgeSample(JUDGE_GAMES),
      },
    });
    expect(
      judgeUnsupported(
        entity,
        supportedClaim({
          predicate: 'matchup_advisor_pick',
          subject: { ...STAGE_SUBJECT, stageId: null },
          value: { kind: 'entity', entityKind: 'fighter', entityId: String(UNKNOWN_BUCKET_ID) },
          evidenceIds: [entityRowId],
        }),
      ),
    ).toBe('R7');
  });
});

describe('judgeDeliveredProse: R7 lexical on delivered prose', () => {
  it('convicts prose naming the unknown bucket as a thing', () => {
    expect(judgeDeliveredProse('They are 4-2 on Unknown Stage, a strong pick.')).toBe('R7');
    expect(judgeDeliveredProse('They picked an unknown stage in 3 of 12 games.')).toBe('R7');
    expect(judgeDeliveredProse('Their Unknown Character games are all wins.')).toBe('R7');
  });

  it('convicts the plural naming too', () => {
    expect(judgeDeliveredProse('Their Unknown Stages record is 6-4.')).toBe('R7');
  });

  it("SH-WR-08: the validator's R7 lexical pattern is a DELIBERATE duplicate of this judge's — same source, same flags", () => {
    // The judge keeps its own copy (it must never read the validator's
    // decisions); this assertion is what stops the two from drifting apart.
    expect(UNKNOWN_BUCKET_NAMED_PATTERN.source).toBe(UNKNOWN_BUCKET_NAMING.source);
    expect(UNKNOWN_BUCKET_NAMED_PATTERN.flags).toBe(UNKNOWN_BUCKET_NAMING.flags);
  });

  it('D-24: convicts delivered prose carrying any figure (digits of any script, a percent sign, a number word) under R4 and any tier word under R5', () => {
    for (const prose of [
      'You are 3-2 against them.',
      'They are 3—2 against you.',
      'You are ３-２ here.',
      'They won ٣ sets.',
      'A big % of their games end early.',
      'They are three and two against you.',
      'They took the first set.',
      'Half of their wins came late.',
    ]) {
      expect(judgeDeliveredProse(prose), prose).toBe('R4');
    }
    for (const prose of [
      'Confidence here is high.',
      'Keep your shield high.',
      'This is a strong read.',
      'Treat this as a medium read.',
    ]) {
      expect(judgeDeliveredProse(prose), prose).toBe('R5');
    }
  });

  it('D-24: names are removed before the figure test, but only names with a letter', () => {
    expect(judgeDeliveredProse('Stay patient against Sparg0.', ['Sparg0'])).toBeNull();
    expect(
      judgeDeliveredProse('Pokémon Stadium 2 suits you.', ['Pokémon Stadium 2', 'Battlefield']),
    ).toBeNull();
    expect(judgeDeliveredProse('Stay patient against Sparg0.')).toBe('R4');
    expect(judgeDeliveredProse('Watch 7 closely.', ['7'])).toBe('R4');
  });

  it('does not convict ordinary uses of "unknown", or empty prose', () => {
    expect(judgeDeliveredProse('Unknown matchups are rare for this opponent.')).toBeNull();
    expect(judgeDeliveredProse('unknown is not the same as unsafe')).toBeNull();
    expect(judgeDeliveredProse('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Code review R5-WR-02 (iteration 5): the judge is independent in COVERAGE,
// not only in code. Every R5 phrasing the iteration-4 validator shipped is
// convicted by the judge AND withheld by the validator, and a meaning-
// preserving Unicode or Markdown transform never changes either verdict.
// ---------------------------------------------------------------------------

function fixtureById(id: string): AdversarialFixture {
  const fixture = ADVERSARIAL_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) {
    throw new Error(`fixture ${id} is not in the corpus`);
  }
  return fixture;
}

/** One prose section over `fixture`'s claims: the validator's verdict and the judge's, side by side. */
function bothVerdicts(
  fixture: AdversarialFixture,
  prose: string,
): { withheld: boolean; judge: RubricRuleId | null } {
  const run = runAdversarial({ ...fixture, sections: [{ prose, licensedClaimIds: ['c01'] }] });
  return {
    withheld: run.outcome.strippedSectionIds.includes('section-0'),
    judge: judgeDeliveredProse(prose, CANONICAL_NAMES, tagsFor(run.snapshot, run.issuedClaims)),
  };
}

const R5_RECORD_BASE = fixtureById('d24-qualitative-control-tag');
const R5_TIER_BASE = fixtureById('d24-r5-tier-mid');
const R5_TAG = tagsFor(R5_RECORD_BASE.snapshot, [])[0]!;

const eachWord = (prose: string, map: (word: string) => string): string =>
  prose.replace(/[A-Za-z0-9]+/g, map);
const fromCodePoints = (prose: string, offset: (ch: string) => number | null): string =>
  [...prose]
    .map((ch) => {
      const cp = offset(ch);
      return cp === null ? ch : String.fromCodePoint(cp);
    })
    .join('');

/**
 * Code review R6-WR-04 (iteration 6): transforms that change the DELIVERED
 * text. The iteration-5 check folded most of these away before it looked, so
 * it judged a text the user never saw; the check now reads the delivered
 * text, so each one moves every sentence, qualitative or not, to withheld on
 * the validator side AND convicted on the judge side. The last six are the
 * forms the old fold erased while the renderer kept them (review R6-CR-01..04).
 */
const RENDERED_TRANSFORMS: ReadonlyArray<readonly [string, (prose: string) => string]> = [
  ['underscore emphasis', (prose) => eachWord(prose, (word) => `_${word}_`)],
  ['double underscore emphasis', (prose) => eachWord(prose, (word) => `__${word}__`)],
  ['asterisk emphasis', (prose) => eachWord(prose, (word) => `*${word}*`)],
  ['code markers', (prose) => eachWord(prose, (word) => `\`${word}\``)],
  ['soft hyphen', (prose) => eachWord(prose, (word) => `${word[0]}\u00ad${word.slice(1)}`)],
  ['zero-width space', (prose) => eachWord(prose, (word) => `${word[0]}\u200b${word.slice(1)}`)],
  ['word joiner', (prose) => eachWord(prose, (word) => `${word[0]}\u2060${word.slice(1)}`)],
  ['combining mark', (prose) => eachWord(prose, (word) => `${word[0]}\u0332${word.slice(1)}`)],
  [
    'fullwidth',
    (prose) =>
      fromCodePoints(prose, (ch) => (ch >= '!' && ch <= '~' ? ch.codePointAt(0)! + 0xfee0 : null)),
  ],
  [
    'mathematical bold',
    (prose) =>
      fromCodePoints(prose, (ch) =>
        /[a-z]/.test(ch)
          ? 0x1d41a + ch.charCodeAt(0) - 97
          : /[A-Z]/.test(ch)
            ? 0x1d400 + ch.charCodeAt(0) - 65
            : /[0-9]/.test(ch)
              ? 0x1d7ce + ch.charCodeAt(0) - 48
              : null,
      ),
  ],
  ['ligatures', (prose) => prose.replace(/fi/g, '\ufb01').replace(/fl/g, '\ufb02')],
  [
    'right-to-left override',
    (prose) => eachWord(prose, (word) => `\u202e${[...word].reverse().join('')}\u202c`),
  ],
  [
    'right-to-left isolate',
    (prose) => eachWord(prose, (word) => `\u2067${[...word].reverse().join('')}\u2069`),
  ],
  ['tag characters', (prose) => eachWord(prose, (word) => `${word}\udb40\udc20`)],
  [
    'roman-numeral characters',
    (prose) =>
      fromCodePoints(prose, (ch) => {
        const at = 'ivxlcdm'.indexOf(ch);
        return at === -1 ? null : [0x2170, 0x2174, 0x2179, 0x217c, 0x217d, 0x217e, 0x217f][at]!;
      }),
  ],
  [
    'intraword bold',
    (prose) =>
      eachWord(prose, (word) =>
        word.length >= 3 ? `${word[0]}**${word.slice(1, -1)}**${word.slice(-1)}` : `**${word}**`,
      ),
  ],
  [
    'letter separation',
    (prose) => eachWord(prose, (word) => (word.length >= 2 ? [...word].join('-') : word)),
  ],
];

/** A look-alike transform: the verdict can only move toward withheld (the letters leave the allowlist). */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: 'а',
  e: 'е',
  o: 'о',
  i: 'і',
  c: 'с',
  p: 'р',
};
const homoglyph = (prose: string): string =>
  prose.replace(/[aeoicp]/g, (ch) => HOMOGLYPHS[ch] ?? ch);

const R5_FIGURE_SENTENCES = [
  `You are three and two against ${R5_TAG}.`,
  `You took the first set off ${R5_TAG}.`,
  `You have beaten ${R5_TAG} once.`,
  `You swept ${R5_TAG}.`,
  `You win most of your sets against ${R5_TAG}.`,
  `You are III-II against ${R5_TAG}.`,
];
const R5_TIER_SENTENCES = [
  'Our confidence here is high.',
  'Confidence: mid.',
  'This read is shaky.',
  'We are sure of this read.',
];
const R5_QUALITATIVE_RECORD = [
  `${R5_TAG} likes to camp the ledge; take the centre and make them come to you.`,
  'Stay patient and punish the landing.',
];
const R5_QUALITATIVE_TIER = ['Play this stage with confidence.', 'Stay patient on this stage.'];

describe('R5-WR-02: the judge convicts every R5 phrasing the validator withholds, by its own procedure', () => {
  it('the judge parses its charset from the rubric text, and it is exactly the stated list', () => {
    expect([...JUDGE_ALLOWED_PUNCTUATION].sort()).toEqual(
      [
        '.',
        ',',
        ';',
        ':',
        "'",
        '"',
        '!',
        '?',
        '(',
        ')',
        '[',
        ']',
        '-',
        '–',
        '—',
        '’',
        '‘',
        '“',
        '”',
        '/',
      ].sort(),
    );
  });

  it('the twelve phrasings the iteration-4 judge returned null on are all convicted now', () => {
    for (const prose of [
      'You are _three and two_ against MkLeo.',
      'Fox on Battlefield. _Confidence here is high_.',
      'You have beaten MkLeo once and never lost to him.',
      'You took a pair of sets from MkLeo and dropped a single set.',
      'You win a quarter of your sets against MkLeo.',
      'You are III-II against MkLeo.',
      'You are undefeated against MkLeo.',
      'Fox on Battlefield. Confidence: mid.',
      'MkLeoに三勝二敗。',
      'Estás tres a dos contra MkLeo.',
      'You are thr­ee and tw­o against MkLeo.',
      'You are ｔｈｒｅｅ and ｔｗｏ against MkLeo.',
    ]) {
      expect(judgeDeliveredProse(prose, ['Fox', 'Battlefield'], ['MkLeo']), prose).not.toBeNull();
    }
  });

  it('every d24-r5 fixture in the corpus is withheld by the validator AND convicted by the judge', () => {
    const r5 = ADVERSARIAL_FIXTURES.filter((fixture) => fixture.id.startsWith('d24-r5-'));
    expect(r5.length).toBeGreaterThan(50);
    for (const fixture of r5) {
      const prose = fixture.sections![0]!.prose;
      const verdicts = bothVerdicts(fixture, prose);
      expect(verdicts.withheld, `${fixture.id}: validator`).toBe(true);
      expect(verdicts.judge, `${fixture.id}: judge`).not.toBeNull();
    }
  });

  it('R6-WR-04 (iteration 6): every d24-r6 fixture is withheld by the validator AND convicted by the judge, and every d24-r6 control ships AND passes the judge', () => {
    const r6 = ADVERSARIAL_FIXTURES.filter((fixture) => fixture.id.startsWith('d24-r6-'));
    const controls = r6.filter((fixture) => fixture.id.startsWith('d24-r6-control-'));
    expect(r6.length - controls.length).toBeGreaterThan(70);
    expect(controls.length).toBeGreaterThan(4);
    for (const fixture of r6) {
      const run = runAdversarial(fixture);
      const prose = fixture.sections![0]!.prose;
      const withheld = run.outcome.strippedSectionIds.includes('section-0');
      const judge = judgeDeliveredProse(
        prose,
        CANONICAL_NAMES,
        tagsFor(run.snapshot, run.issuedClaims),
      );
      const convicted = !controls.includes(fixture);
      expect(withheld, `${fixture.id}: validator`).toBe(convicted);
      expect(judge !== null, `${fixture.id}: judge`).toBe(convicted);
    }
  });

  it('R7-WR-01..03 (iteration 7): every d24-r7 natural phrasing is withheld by the validator AND convicted by the judge, and every d24-r7 control ships AND passes the judge', () => {
    const r7 = ADVERSARIAL_FIXTURES.filter((fixture) => fixture.id.startsWith('d24-r7-'));
    const controls = r7.filter((fixture) => fixture.id.startsWith('d24-r7-control-'));
    expect(r7.length - controls.length).toBeGreaterThan(25);
    expect(controls.length).toBeGreaterThan(8);
    for (const fixture of r7) {
      const run = runAdversarial(fixture);
      const prose = fixture.sections![0]!.prose;
      const withheld = run.outcome.strippedSectionIds.includes('section-0');
      const judge = judgeDeliveredProse(
        prose,
        CANONICAL_NAMES,
        tagsFor(run.snapshot, run.issuedClaims),
      );
      const convicted = !controls.includes(fixture);
      expect(withheld, `${fixture.id}: validator`).toBe(convicted);
      expect(judge !== null, `${fixture.id}: judge`).toBe(convicted);
    }
  });

  it('R8-WR-01/02 (iteration 8): every d24-r8 zero-side or count probe is withheld AND convicted, and every d24-r8 over-strip control ships AND passes the judge', () => {
    const r8 = ADVERSARIAL_FIXTURES.filter((fixture) => fixture.id.startsWith('d24-r8-'));
    const controls = r8.filter((fixture) => fixture.id.startsWith('d24-r8-control-'));
    expect(r8.length - controls.length).toBeGreaterThan(7);
    expect(controls.length).toBeGreaterThan(14);
    for (const fixture of r8) {
      const run = runAdversarial(fixture);
      const prose = fixture.sections![0]!.prose;
      const withheld = run.outcome.strippedSectionIds.includes('section-0');
      const judge = judgeDeliveredProse(
        prose,
        CANONICAL_NAMES,
        tagsFor(run.snapshot, run.issuedClaims),
      );
      const convicted = !controls.includes(fixture);
      expect(withheld, `${fixture.id}: validator`).toBe(convicted);
      expect(judge !== null, `${fixture.id}: judge`).toBe(convicted);
    }
  });

  it('R6-WR-04: the judge reads its word lists from the rubric text, and every listed word or phrase is withheld by the validator AND convicted by the judge', () => {
    expect(JUDGE_RUBRIC_LISTS.figureWords.length).toBeGreaterThan(100);
    expect(JUDGE_RUBRIC_LISTS.tierStems.length).toBeGreaterThan(30);
    const carriers: string[] = [
      ...JUDGE_RUBRIC_LISTS.figureWords.map((word) => `Against ${R5_TAG}, remember this: ${word}.`),
      ...JUDGE_RUBRIC_LISTS.figurePhrases
        .flatMap(expandRubricPhrase)
        .map((phrase) => `Against ${R5_TAG}, remember this: ${phrase}.`),
      ...JUDGE_RUBRIC_LISTS.tierStems.flatMap((stem) =>
        ['', ...JUDGE_RUBRIC_LISTS.tierSuffixes].map(
          (suffix) => `Against ${R5_TAG}, remember this: ${stem}${suffix}.`,
        ),
      ),
    ];
    for (const prose of carriers) {
      const verdicts = bothVerdicts(R5_RECORD_BASE, prose);
      expect(verdicts.withheld, `validator on ${JSON.stringify(prose)}`).toBe(true);
      expect(verdicts.judge, `judge on ${JSON.stringify(prose)}`).not.toBeNull();
    }
  });

  it('R8-WR-01: every count-gap-words word bridges a digit-bearing tag and a count noun on both sides, and a pronoun or verb does not', () => {
    expect(JUDGE_RUBRIC_LISTS.countGapWords.length).toBeGreaterThan(20);
    for (const word of JUDGE_RUBRIC_LISTS.countGapWords) {
      for (const prose of [
        `You took ${R5_TAG} ${word} sets.`,
        `You took ${R5_TAG} ${word}, close games.`,
      ]) {
        const verdicts = bothVerdicts(R5_RECORD_BASE, prose);
        expect(verdicts.withheld, `validator on ${JSON.stringify(prose)}`).toBe(true);
        expect(verdicts.judge, `judge on ${JSON.stringify(prose)}`).not.toBeNull();
      }
    }
    for (const bridge of ['likes', 'plays', 'drags', 'favours', 'you', 'he', 'likes patient']) {
      const prose = `${R5_TAG} ${bridge} long sets.`;
      const verdicts = bothVerdicts(R5_RECORD_BASE, prose);
      expect(verdicts.withheld, `validator on ${JSON.stringify(prose)}`).toBe(false);
      expect(verdicts.judge, `judge on ${JSON.stringify(prose)}`).toBeNull();
    }
  });

  it('R8-WR-02: every no-singular, passive and lost-to list entry is judged the same way by the validator and the judge, both ways', () => {
    const cases: Array<readonly [string, boolean]> = [];
    for (const count of JUDGE_RUBRIC_LISTS.noSingularCounts) {
      cases.push([`Against ${R5_TAG}, remember this: no ${count}.`, true]);
      cases.push([`Against ${R5_TAG}, remember this: no ${count}`, true]);
      for (const follower of JUDGE_RUBRIC_LISTS.noSingularFollowers) {
        cases.push([`Against ${R5_TAG}, remember this: no ${count} ${follower} him.`, true]);
      }
      cases.push([`${R5_TAG} has no ${count} pattern on ledge.`, false]);
      cases.push([`${R5_TAG} has no ${count}-ups from ledge.`, false]);
    }
    for (const verb of JUDGE_RUBRIC_LISTS.passiveVerbs) {
      cases.push([`Neutral against ${R5_TAG} is not ${verb} by rushing in.`, false]);
      cases.push([`Neutral against ${R5_TAG} is not ${verb} by.`, false]);
      cases.push([`You are not ${verb} by ${R5_TAG}.`, true]);
      cases.push([`You are not ${verb}, by the way, ${R5_TAG}.`, true]);
      for (const person of JUDGE_RUBRIC_LISTS.passivePersons) {
        cases.push([`Against ${R5_TAG} it is not ${verb} by ${person}.`, true]);
      }
    }
    for (const word of JUDGE_RUBRIC_LISTS.lostToExempt) {
      cases.push([`Against ${R5_TAG} you have not lost to ${word} ledge trap.`, false]);
    }
    cases.push([`You have not lost to ${R5_TAG}.`, true]);
    cases.push([`You have not lost to him, ${R5_TAG}.`, true]);
    for (const [prose, convicted] of cases) {
      const verdicts = bothVerdicts(R5_RECORD_BASE, prose);
      expect(verdicts.withheld, `validator on ${JSON.stringify(prose)}`).toBe(convicted);
      expect(verdicts.judge !== null, `judge on ${JSON.stringify(prose)}`).toBe(convicted);
    }
  });

  it('R5-IN-03: a tag that reads as a figure or a grade is not a name to the judge either', () => {
    expect(judgeDeliveredProse('You beat High, and confidence is High.', [], ['High'])).toBe('R5');
    expect(judgeDeliveredProse('You are Leo 3-2 against, keep it up.', [], ['Leo 3-2'])).toBe('R4');
    expect(judgeDeliveredProse('Sparg0 punishes a rushed approach.', [], ['Sparg0'])).toBeNull();
    expect(judgeDeliveredProse('Fox on Pokémon Stadium 2 wins for you.', CANONICAL_NAMES, [])).toBe(
      'R4',
    );
    expect(
      judgeDeliveredProse('Pokémon Stadium 2 rewards your patience.', CANONICAL_NAMES, []),
    ).toBeNull();
  });

  it('metamorphic (identity): every figure and tier sentence is withheld AND convicted, and every qualitative sentence ships AND passes the judge', () => {
    for (const [fixture, sentences, convicted] of [
      [R5_RECORD_BASE, R5_FIGURE_SENTENCES, true],
      [R5_TIER_BASE, R5_TIER_SENTENCES, true],
      [R5_RECORD_BASE, R5_QUALITATIVE_RECORD, false],
      [R5_TIER_BASE, R5_QUALITATIVE_TIER, false],
    ] as const) {
      for (const prose of sentences) {
        const verdicts = bothVerdicts(fixture, prose);
        expect(verdicts.withheld, `validator on ${JSON.stringify(prose)}`).toBe(convicted);
        expect(verdicts.judge !== null, `judge on ${JSON.stringify(prose)}`).toBe(convicted);
      }
    }
  });

  it.each(RENDERED_TRANSFORMS)(
    'R6-WR-04 metamorphic (%s): the transform changes the delivered text, so every sentence, qualitative included, is withheld AND convicted',
    (_name, transform) => {
      let changed = 0;
      for (const [fixture, sentences] of [
        [R5_RECORD_BASE, R5_FIGURE_SENTENCES],
        [R5_TIER_BASE, R5_TIER_SENTENCES],
        [R5_RECORD_BASE, R5_QUALITATIVE_RECORD],
        [R5_TIER_BASE, R5_QUALITATIVE_TIER],
      ] as const) {
        for (const sentence of sentences) {
          const prose = transform(sentence);
          if (prose === sentence) {
            // A ligature transform leaves a sentence with no "fi" or "fl" as it was.
            continue;
          }
          changed += 1;
          const verdicts = bothVerdicts(fixture, prose);
          expect(verdicts.withheld, `validator on ${JSON.stringify(prose)}`).toBe(true);
          expect(verdicts.judge, `judge on ${JSON.stringify(prose)}`).not.toBeNull();
        }
      }
      expect(changed).toBeGreaterThan(0);
    },
  );

  it('metamorphic (Cyrillic look-alikes): the transform only moves a verdict toward withheld, on both sides', () => {
    for (const [fixture, sentence] of [
      ...R5_FIGURE_SENTENCES.map((s) => [R5_RECORD_BASE, s] as const),
      ...R5_TIER_SENTENCES.map((s) => [R5_TIER_BASE, s] as const),
      ...R5_QUALITATIVE_RECORD.map((s) => [R5_RECORD_BASE, s] as const),
      ...R5_QUALITATIVE_TIER.map((s) => [R5_TIER_BASE, s] as const),
    ]) {
      const prose = homoglyph(sentence);
      expect(prose).not.toBe(sentence);
      const verdicts = bothVerdicts(fixture, prose);
      expect(verdicts.withheld, prose).toBe(true);
      expect(verdicts.judge, prose).not.toBeNull();
    }
  });
});
