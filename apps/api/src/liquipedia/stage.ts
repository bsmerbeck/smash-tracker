import { StageList, type RESEARCH_LIQUIPEDIA_STAGE_FORMS } from '@smash-tracker/shared';

/**
 * Phase 30.2 Plan 04 (ENR-02/ENR-07): the Liquipedia stage-form vocabulary
 * and the ONE canonicalization pipeline that turns a raw wikitext stage
 * string into a raw text / stage-form / canonical-id triple.
 * `canonicalizeLiquipediaStage` is the ONLY place a source stage string
 * becomes an app stage id anywhere in this phase — there is no second
 * normalizer, and no caller is permitted to re-derive a canonical stage id
 * by any other means.
 *
 * THIS MODULE CONTAINS NO FUZZY MATCHING, NO EDIT DISTANCE, AND NO
 * NEAREST-NEIGHBOUR FALLBACK, anywhere. That is a hard prohibition, not a
 * style preference: a fuzzy matcher would map a Melee stage name (e.g.
 * "Yoshi's Story") onto a similarly spelled Ultimate stage (e.g. "Yoshi’s
 * Island") and produce a silent wrong fact — exactly what ENR-07 forbids.
 * When a raw name has no exact match, the result carries `canonicalStageId:
 * null`, `needsReview: true`, and the raw string preserved — never a guess.
 *
 * Deliberately does NOT delegate to `apps/api/src/startgg/stageMap.ts`'s
 * `resolveStageByName`, even though that function already exists and
 * exact-matches against the same `StageList`. `resolveStageByName`
 * normalizes with NFKD and strips every combining mark and every non-
 * alphanumeric character — which silently strips DIACRITICS (á/é/ê/etc.).
 * RESEARCH section 4.5 is explicit that diacritics are never stripped by
 * this phase: both Liquipedia and this app's own stage names carry accented
 * characters (`Pokémon`, `Kalos Pokémon League`), and the only transform
 * this module applies to them is NFC normalization. Delegating to
 * `resolveStageByName` would therefore be MORE lenient than the locked
 * pipeline permits, so this module keeps its own local exact matcher built
 * directly from `StageList`, applying only the specific, enumerated
 * transforms this plan's canonicalization pipeline names: NFC normalize,
 * form-prefix extraction, counterpick-suffix stripping, apostrophe
 * normalization, whitespace collapse, then an exact case-insensitive
 * lookup.
 *
 * No I/O, no async, no database access — a pure function library.
 */

export type LiquipediaStageForm = (typeof RESEARCH_LIQUIPEDIA_STAGE_FORMS)[number];

// ---------------------------------------------------------------------------
// Stage-form prefix vocabulary (RESEARCH section 4.2, on-wiki Lua source)
// ---------------------------------------------------------------------------

/**
 * The complete, observed stage-form prefix vocabulary, in the fixed
 * evaluation order `extractStagePrefix` checks them in. Every prefix is
 * exactly two CODE POINTS (a marker character followed by an ASCII space) —
 * `Φ` (U+03A6) and `Ω` (U+03A9) are each a single Greek-letter code point
 * despite being two UTF-8 BYTES, so extraction below iterates code points
 * (`Array.from`), never byte offsets, so the two multi-byte prefixes are
 * handled identically to the ASCII `'B '` one.
 */
export const LIQUIPEDIA_STAGE_FORM_PREFIXES: ReadonlyArray<{
  prefix: string;
  form: LiquipediaStageForm;
}> = [
  { prefix: 'Φ ', form: 'hazardless' },
  { prefix: 'Ω ', form: 'omega' },
  { prefix: 'B ', form: 'battlefield' },
];

/**
 * Recognises a candidate "unrecognised leading symbol": a single
 * NON-ASCII code point immediately followed by a literal space, where
 * that code point did not match one of the three known prefixes above.
 * Deliberately scoped to non-ASCII so it can never misfire on a real
 * stage name that happens to start with an ASCII letter/digit (every
 * name in `StageList` does) — Φ and Ω are themselves non-ASCII, so a
 * hypothetical future marker sharing their shape (another Greek letter,
 * a dingbat, etc.) is caught by the same test once it fails the
 * known-prefix check.
 *
 * Implemented as an explicit code-point comparison (never a regex ASCII
 * range escape) so this file carries no raw control-byte hazard.
 */
function isUnrecognisedPrefixCandidate(value: string): boolean {
  const codePoints = Array.from(value);
  const first = codePoints[0];
  if (first === undefined || codePoints[1] !== ' ') {
    return false;
  }
  const codePoint = first.codePointAt(0) ?? 0;
  return codePoint > 127;
}

interface ExtractStagePrefixResult {
  form: LiquipediaStageForm;
  /**
   * The remainder after the prefix is removed — for the `'unknown'` form
   * this is deliberately the FULL, unmodified input (the unrecognised
   * symbol is never stripped from it, per ENR-07: we don't know what it
   * means, so we don't guess where the name starts).
   */
  rest: string;
}

/**
 * Extracts the stage-form prefix (if any) by CODE POINT, never by byte
 * offset. Checks the three known prefixes first, in the fixed order of
 * `LIQUIPEDIA_STAGE_FORM_PREFIXES`; if none match but the input still has
 * the two-code-point "symbol + space" shape of a form prefix, returns the
 * `'unknown'` form with the unrecognised symbol left in place; otherwise
 * returns `'normal'` — meaning NO prefix was present. `'normal'` is the
 * UNSTATED case, never an assertion that stage hazards are on: Liquipedia
 * editors apply the hazardless marker inconsistently (RESEARCH section
 * 4.3 — `Φ Hollow Bastion` and `Φ Battlefield` exist even though those
 * stages have no hazards to disable), so a bare stage name records only
 * that nothing was stated about its hazard setting.
 */
function extractStagePrefix(value: string): ExtractStagePrefixResult {
  const codePoints = Array.from(value);
  for (const { prefix, form } of LIQUIPEDIA_STAGE_FORM_PREFIXES) {
    const prefixCodePoints = Array.from(prefix);
    const candidate = codePoints.slice(0, prefixCodePoints.length).join('');
    if (candidate === prefix) {
      return { form, rest: codePoints.slice(prefixCodePoints.length).join('') };
    }
  }
  if (isUnrecognisedPrefixCandidate(value)) {
    return { form: 'unknown', rest: value };
  }
  return { form: 'normal', rest: value };
}

// ---------------------------------------------------------------------------
// Counterpick-suffix stripping (tournament ruleset stage lists only)
// ---------------------------------------------------------------------------

/**
 * `s_stageN=` tournament-level ruleset stage lists append a `(CP)`
 * counterpick marker (e.g. `Φ Kalos Pokémon League (CP)`, RESEARCH section
 * 4.4) — this is ruleset metadata, never part of the stage name itself, and
 * must be stripped before lookup rather than treated as a name variant.
 */
const COUNTERPICK_SUFFIX_PATTERN = /\s*\(cp\)\s*$/i;

function stripCounterpickSuffix(value: string): string {
  return value.replace(COUNTERPICK_SUFFIX_PATTERN, '');
}

// ---------------------------------------------------------------------------
// Apostrophe normalization (RESEARCH section 4.5 — the U+2019 trap)
// ---------------------------------------------------------------------------

/**
 * Typographic (U+2019 `’`, U+2018 `‘`), modifier-letter (U+02BC `ʼ`), and
 * acute-accent (U+00B4 `´`) apostrophe look-alikes, all folded to the ASCII
 * apostrophe (U+0027 `'`). `StageList` stores `Yoshi’s Island` with the
 * TYPOGRAPHIC apostrophe (U+2019); Liquipedia consistently writes the ASCII
 * form. Applying this normalization to BOTH sides of the lookup (this
 * module's input AND the stage-name lookup table built below) is what
 * makes the two agree — an ASCII-apostrophe lookup against an unnormalized
 * typographic-apostrophe table silently fails otherwise.
 */
const APOSTROPHE_VARIANTS = /[‘’ʼ´]/g;

function normalizeApostrophes(value: string): string {
  return value.replace(APOSTROPHE_VARIANTS, "'");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Exact-match lookup table (built once, from StageList)
// ---------------------------------------------------------------------------

interface StageLookupEntry {
  id: number;
  name: string;
}

/**
 * Case-insensitive, apostrophe-normalized lookup key builder — applied
 * identically to a query string AND to every `StageList` entry when the
 * table below is built, so the two sides can never drift. Diacritics are
 * DELIBERATELY not touched here (see this module's header) — NFC
 * normalization is the only transform applied to them, and NFC is already
 * applied by the caller before this function ever sees a value (see
 * `canonicalizeLiquipediaStage`).
 */
function buildLookupKey(value: string): string {
  return collapseWhitespace(normalizeApostrophes(value)).toLowerCase();
}

/**
 * First-occurrence-wins, matching `stageData.ts`'s own documented handling
 * of `StageList`'s duplicate ids (114-116 each appear twice) and mirroring
 * `stagesById`'s construction convention in that same module.
 */
const stageLookupByNormalizedName = new Map<string, StageLookupEntry>();
for (const stage of StageList) {
  const key = buildLookupKey(stage.name);
  if (!stageLookupByNormalizedName.has(key)) {
    stageLookupByNormalizedName.set(key, { id: stage.id, name: stage.name });
  }
}

// ---------------------------------------------------------------------------
// The canonicalization pipeline
// ---------------------------------------------------------------------------

export interface CanonicalizeLiquipediaStageOptions {
  /**
   * The game the SOURCE page declared (e.g. `TournamentInfo.game`), or
   * `null` when the source page stated nothing. `null` is treated as
   * "unknown", never as a match — the game-scope guard below only ever
   * PASSES when both sides are known and equal.
   */
  sourceGame: string | null;
  /** The game this enrichment run is targeting (e.g. `'ultimate'`). */
  targetGame: string;
}

export interface CanonicalizeLiquipediaStageResult {
  /** Byte-identical to the input — never mutated, never trimmed, never re-cased. */
  rawStage: string;
  /** The cleaned display name after prefix/suffix/apostrophe/whitespace normalization. */
  baseName: string;
  stageForm: LiquipediaStageForm;
  canonicalStageId: number | null;
  canonicalStageName: string | null;
  /** True whenever this observation could not be confidently resolved and a human should look at it. */
  needsReview: boolean;
  /** A stated, human-readable reason for a null canonical id, or `null` on a confident hit. */
  reason: string | null;
}

/**
 * Runs the ONE canonicalization pipeline, in exactly this order (RESEARCH
 * section 4.5, "recommended canonicalization pipeline"), each step
 * documented with its reason:
 *
 * 1. NFC-normalize — a stable baseline so later code-point comparisons
 *    (the prefix table, the apostrophe table) are comparing like with like.
 * 2. Extract and strip the stage-form prefix, by code point.
 * 3. Strip a trailing counterpick suffix (`(CP)`) — ruleset metadata, not a
 *    name variant.
 * 4. Normalize typographic/modifier/acute apostrophes to ASCII.
 * 5. Collapse internal whitespace.
 * 6. Apply the game-scope guard: an observation whose source page declared
 *    a DIFFERENT game than the target abstains rather than mapping across
 *    games, even if the raw name happens to also exist in the target
 *    game's list (RESEARCH section 4.5 — `Dream Land`/`Pokémon Stadium`
 *    exist in `StageList` but arrive from Melee pages).
 * 7. Perform an EXACT, case-insensitive lookup with the identical
 *    apostrophe normalization applied to the `StageList` side. No fuzzy
 *    matching, no edit distance, no nearest-neighbour fallback — see this
 *    module's header.
 */
export function canonicalizeLiquipediaStage(
  rawStage: string,
  options: CanonicalizeLiquipediaStageOptions,
): CanonicalizeLiquipediaStageResult {
  const nfc = rawStage.normalize('NFC');
  const { form, rest } = extractStagePrefix(nfc);
  const withoutCounterpick = stripCounterpickSuffix(rest);
  const withAsciiApostrophes = normalizeApostrophes(withoutCounterpick);
  const baseName = collapseWhitespace(withAsciiApostrophes);

  if (form === 'unknown') {
    return {
      rawStage,
      baseName,
      stageForm: 'unknown',
      canonicalStageId: null,
      canonicalStageName: null,
      needsReview: true,
      reason:
        'unrecognised leading stage-form symbol; the prefix meaning is unknown so no canonical mapping is attempted',
    };
  }

  if (options.sourceGame != null && options.sourceGame !== options.targetGame) {
    return {
      rawStage,
      baseName,
      stageForm: form,
      canonicalStageId: null,
      canonicalStageName: null,
      needsReview: false,
      reason: `source page declared game "${options.sourceGame}", which differs from the target game "${options.targetGame}"; stage mapping abstains rather than guessing across games`,
    };
  }

  const hit = stageLookupByNormalizedName.get(buildLookupKey(baseName));
  if (!hit) {
    return {
      rawStage,
      baseName,
      stageForm: form,
      canonicalStageId: null,
      canonicalStageName: null,
      needsReview: true,
      reason:
        'no exact match against the app stage list; never guessed onto a similarly spelled entry',
    };
  }

  return {
    rawStage,
    baseName,
    stageForm: form,
    canonicalStageId: hit.id,
    canonicalStageName: hit.name,
    needsReview: false,
    reason: null,
  };
}
