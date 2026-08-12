import { RESEARCH_ENRICHMENT_TEMPLATE_FAMILIES } from '@smash-tracker/shared';

/**
 * Phase 30.2 Plan 04 (ENR-02): bounded, pure wikitext primitives shared by
 * every Liquipedia bracket adapter in this phase — comment stripping,
 * brace-depth-aware template splitting, anchored parameter parsing, entity
 * decoding, markup stripping, and deterministic three-way template-family
 * detection.
 *
 * This module never mutates its input, performs no authorization, emits
 * nothing, and does no I/O of any kind — it is a pure function library over
 * strings, callable identically from a unit test, the API ingestion path,
 * and a future dry-run CLI script. No function below contains a regex with
 * a nested quantifier applied to the whole document (RESEARCH section 15's
 * catastrophic-backtracking row): `splitTopLevelTemplates` is a hand-rolled,
 * bounded, brace-depth-aware scanner, never a regex, and every other regex
 * here is anchored to a fixed, small pattern.
 *
 * `detectTemplateFamily`'s `'unknown'` outcome is a FIRST-CLASS result, not
 * an error and not a silent skip: a caller records it together with
 * `hashWikitext`'s content hash so the page remains countable and auditable
 * (T-30.2-21). This module never falls back to guessing a family, and
 * `canonicalizeLiquipediaStage` (stage.ts, this same plan) never fuzzy-
 * matches a name — see that module's header for the ENR-07 rationale this
 * one shares.
 */

// ---------------------------------------------------------------------------
// Bounds (T-30.2-17 — denial-of-service mitigation)
// ---------------------------------------------------------------------------

/**
 * Maximum brace-nesting depth `splitTopLevelTemplates` will descend into
 * before reporting `truncated: true` and stopping. A pathological input of
 * deeply repeated `{{` sequences terminates at this bound instead of
 * consuming unbounded time/memory — this is the DoS mitigation for
 * T-30.2-17, referenced again below where the scanner enforces it.
 */
export const LIQUIPEDIA_PARAM_MAX_DEPTH = 12;

/**
 * Maximum number of top-level template calls `splitTopLevelTemplates` will
 * collect from a single page before reporting `truncated: true` and
 * stopping — the second half of the T-30.2-17 bound, alongside
 * `LIQUIPEDIA_PARAM_MAX_DEPTH` above.
 */
export const LIQUIPEDIA_PARAM_MAX_TEMPLATES = 500;

/**
 * Re-exported from the shared package so every consumer of this module
 * reads the template-family vocabulary from a single place. Note this
 * vocabulary is a SUPERSET of what `detectTemplateFamily` below can return
 * (`'legacy' | 'match2' | 'unknown'`) — it also admits `'vodlist'`, which is
 * assigned by the VOD-list adapter in a later plan, never by this module.
 */
export const LIQUIPEDIA_TEMPLATE_FAMILIES = RESEARCH_ENRICHMENT_TEMPLATE_FAMILIES;

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Removes every `<!-- ... -->` HTML comment from `source`, verbatim,
 * including ones that sit between a pipe and the next parameter name (a
 * comment sitting mid-parameter-list is common in bracket wikitext — see
 * RESEARCH section 8.5). Never treats comment text as a round label or any
 * other authoritative value.
 *
 * The regex below is non-greedy (`[\s\S]*?`) and bounded by the very next
 * `-->`, so it cannot exhibit catastrophic backtracking even on a large
 * document.
 */
export function stripWikiComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

// ---------------------------------------------------------------------------
// Template splitting (brace-depth-aware scanner, never a regex)
// ---------------------------------------------------------------------------

export interface LiquipediaTemplateCall {
  /** The template's name, trimmed, as written immediately after `{{`. */
  name: string;
  /** Everything between the name and the matching closing `}}`, unstripped. */
  body: string;
  /** The character offset of the opening `{{` in the original source. */
  start: number;
}

export interface SplitTopLevelTemplatesOptions {
  maxDepth?: number;
  maxTemplates?: number;
}

export interface SplitTopLevelTemplatesResult {
  templates: LiquipediaTemplateCall[];
  /** True when the scan stopped early because a bound was hit. */
  truncated: boolean;
}

/**
 * Splits `source` into its TOP-LEVEL `{{...}}` template calls only — a
 * hand-rolled, brace-depth-aware scanner, never a regex (RESEARCH section
 * 11: "don't build a general wikitext parser"). A template nested inside
 * another template's body (e.g. `r1m1details={{BracketMatchDetails|...}}`
 * nested inside `{{8DEWBracketA|...}}`) is never returned as its own entry
 * — the outer scan only starts a new template the instant it is looking at
 * depth 0, and jumps straight past a matched template's entire nested
 * structure before resuming.
 *
 * Bounded by `LIQUIPEDIA_PARAM_MAX_DEPTH` (nesting depth) and
 * `LIQUIPEDIA_PARAM_MAX_TEMPLATES` (result count) — see their doc comments
 * above for the DoS rationale (T-30.2-17). A pathological input of deeply
 * repeated opening braces with no matching close hits the depth bound and
 * reports `truncated: true` rather than scanning unbounded.
 */
export function splitTopLevelTemplates(
  source: string,
  options?: SplitTopLevelTemplatesOptions,
): SplitTopLevelTemplatesResult {
  const maxDepth = options?.maxDepth ?? LIQUIPEDIA_PARAM_MAX_DEPTH;
  const maxTemplates = options?.maxTemplates ?? LIQUIPEDIA_PARAM_MAX_TEMPLATES;
  const templates: LiquipediaTemplateCall[] = [];
  const len = source.length;
  let truncated = false;
  let i = 0;

  while (i < len) {
    if (source[i] === '{' && source[i + 1] === '{') {
      const start = i;
      const nameStart = i + 2;

      // The name runs until the first `|`, newline, or the closing `}}` —
      // whichever comes first. A comment cannot appear here without also
      // containing one of those delimiters, so no comment-stripping is
      // needed for name detection itself.
      let nameEnd = nameStart;
      while (
        nameEnd < len &&
        source[nameEnd] !== '|' &&
        source[nameEnd] !== '\n' &&
        !(source[nameEnd] === '}' && source[nameEnd + 1] === '}') &&
        !(source[nameEnd] === '{' && source[nameEnd + 1] === '{')
      ) {
        nameEnd++;
      }
      const name = source.slice(nameStart, nameEnd).trim();

      // Scan forward tracking brace depth until this template's own `}}`
      // closes it (depth returns to 0). Any `{{...}}` encountered along the
      // way — including a full nested template — is consumed as part of
      // this template's body and never becomes its own top-level entry.
      let depth = 1;
      let k = nameEnd;
      let hitDepthLimit = false;
      while (k < len && depth > 0) {
        if (source[k] === '{' && source[k + 1] === '{') {
          depth++;
          if (depth > maxDepth) {
            hitDepthLimit = true;
            break;
          }
          k += 2;
          continue;
        }
        if (source[k] === '}' && source[k + 1] === '}') {
          depth--;
          k += 2;
          continue;
        }
        k++;
      }

      if (hitDepthLimit) {
        truncated = true;
        break;
      }
      if (depth > 0) {
        // Unterminated template (ran off the end of the source without a
        // matching close) — nothing more to parse; stop cleanly rather than
        // fabricating a body.
        break;
      }

      const body = source.slice(nameEnd, k - 2);
      templates.push({ name, body, start });

      if (templates.length >= maxTemplates) {
        truncated = true;
        break;
      }
      i = k;
      continue;
    }
    i++;
  }

  return { templates, truncated };
}

// ---------------------------------------------------------------------------
// Parameter parsing (top-level pipes only, anchored on full parameter names)
// ---------------------------------------------------------------------------

/**
 * Splits `body` on TOP-LEVEL `|` characters only — a pipe nested inside a
 * `{{...}}` template call or a `[[...]]` wiki link is not a separator. A
 * single shared depth counter tracks both bracket kinds since neither can
 * legally close the other.
 */
function splitTopLevelPipes(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  const len = body.length;

  while (i < len) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth++;
      current += two;
      i += 2;
      continue;
    }
    if (two === '}}' || two === ']]') {
      depth = Math.max(0, depth - 1);
      current += two;
      i += 2;
      continue;
    }
    if (body[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += body[i];
    i++;
  }
  parts.push(current);
  return parts;
}

/**
 * Parses a template's body into a `key -> value` map, splitting on
 * top-level pipes only and trimming each side of the first top-level `=`
 * in each segment. A comment sitting between a pipe and the next parameter
 * name is stripped FIRST so it can never merge two parameters together
 * (RESEARCH section 8.5). A pipe-separated segment with no `=` (a
 * positional argument, e.g. `{{Bracket|Bracket/8U8L4DSL2DSL1D|id=...}}`'s
 * first argument) is skipped — this module's callers read match2's
 * positional layout name directly off the source via `detectTemplateFamily`
 * / a later plan's match2 adapter, never through this map.
 */
export function parseTemplateParameters(body: string): Map<string, string> {
  const stripped = stripWikiComments(body);
  const params = new Map<string, string>();
  for (const part of splitTopLevelPipes(stripped)) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) {
      params.set(key, value);
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Anchored accessors — prevent the two documented prefix-collision classes
// ---------------------------------------------------------------------------

/**
 * A bracket side: `'r'` (winners) or `'l'` (losers), matching the legacy
 * family's `rNmM...` / `lNmM...` parameter-name grammar (RESEARCH section
 * 2.4).
 */
export type LiquipediaBracketSide = 'r' | 'l';

/**
 * Builds the exact set-level parameter name (`{side}{round}m{match}{suffix}`,
 * e.g. `r3m1p1score`, `r3m2win`, `l1m1date`) and reads it from `params`.
 *
 * Exists to prevent two measured collision classes (RESEARCH section 8.10)
 * a caller could otherwise hit by scanning/prefix-matching parameter names
 * instead of building the exact name: (1) a SET-level winner name
 * (`rNmMwin`) is a strict string prefix of every PER-GAME winner name
 * (`rNmMwin1`, `rNmMwin2`, ...) — `getSetParam(..., 'win')` never matches
 * `rNmMwin1` because it looks up the exact key `rNmMwin`, not a prefix; (2)
 * a single-digit match index is a strict string prefix of a two-digit one
 * (`r1m1...` is a prefix of `r1m10...` through `r1m16...`, observed on the
 * SCU pools fixture) — building the key from the numeric `match` argument
 * rather than string-matching means `r1m1` and `r1m10` are never confused.
 */
export function getSetParam(
  params: Map<string, string>,
  side: LiquipediaBracketSide,
  round: number,
  match: number,
  suffix: string,
): string | undefined {
  return params.get(`${side}${round}m${match}${suffix}`);
}

/**
 * Builds the exact GAME-level (per-game-row) parameter name
 * (`{side}{round}m{match}{suffix}{ordinal}`, e.g. `r3m1stage2`,
 * `r1m1p1char3`, `r3m2win1`) and reads it from `params`. See
 * `getSetParam`'s doc comment for the two collision classes both accessors
 * exist to prevent — `getGameParam(..., 'win', 1)` builds `rNmMwin1`
 * directly rather than ever being confused with the set-level `rNmMwin`.
 */
export function getGameParam(
  params: Map<string, string>,
  side: LiquipediaBracketSide,
  round: number,
  match: number,
  suffix: string,
  ordinal: number,
): string | undefined {
  return params.get(`${side}${round}m${match}${suffix}${ordinal}`);
}

// ---------------------------------------------------------------------------
// Entity decoding and markup stripping
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decodes literal HTML entities into their literal Unicode characters —
 * numeric (`&#39;`, `&#160;`, `&#x2019;`) and the small named set MediaWiki
 * output actually uses (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`,
 * `&nbsp;`). This is ENTITY decoding only, not semantic normalization —
 * `&nbsp;`/`&#160;` become the literal U+00A0 non-breaking-space character,
 * not an ordinary space; whitespace collapsing (if a caller wants it) is a
 * separate, deliberate step (see `stage.ts`'s canonicalization pipeline).
 * An entity this table doesn't recognise, or a malformed numeric reference,
 * is left byte-for-byte unchanged rather than guessed at.
 */
export function decodeWikiEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isNaN(codePoint)) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const replacement = NAMED_ENTITIES[entity.toLowerCase()];
    return replacement ?? match;
  });
}

/**
 * Removes wiki markup that must never reach a display string: bold
 * (`'''text'''`) and italic (`''text''`) quote runs, the pipe-escape
 * template call (`{{!}}`, resolved to the literal `|` character it stands
 * in for — RESEARCH section 8.4's `previous=Supernova/2025/Ultimate{{!}}...`
 * example), and any `[[File:...]]` / `[[Image:...]]` link (RESEARCH section
 * 7: Liquipedia images are frequently under separate, CC-BY-SA-incompatible
 * licenses, and this phase never ingests or hot-links them). This is
 * defence in depth alongside "never render a Liquipedia string as HTML" —
 * see this plan's threat register, T-30.2-19.
 */
export function stripWikiMarkup(value: string): string {
  let result = value.replace(/\{\{!\}\}/g, '|');
  result = result.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '');
  // Bold (3 quotes) must be removed before italic (2 quotes), or a bold run
  // would be seen as an italic run plus one leftover quote.
  result = result.replace(/'''/g, '');
  result = result.replace(/''/g, '');
  return result;
}

// ---------------------------------------------------------------------------
// Content hashing (for the first-class `unknown`-family outcome)
// ---------------------------------------------------------------------------

/**
 * Hashes `source` verbatim using an INJECTED hash implementation (never
 * `node:crypto` imported at module scope — this module has no such
 * constraint today, but mirrors `buildEnrichmentObservationId`'s injected-
 * hash convention in `researchEnrichment.ts` so every hash in this phase is
 * testable without wiring a real digest). The caller is responsible for
 * recording the returned hash alongside an `'unknown'` family outcome so
 * the unrecognised page remains countable and auditable (T-30.2-21) —
 * `detectTemplateFamily` itself never computes or stores a hash.
 */
export function hashWikitext(source: string, hashHex: (value: string) => string): string {
  return hashHex(source);
}

// ---------------------------------------------------------------------------
// Deterministic three-way family detection
// ---------------------------------------------------------------------------

export interface DetectTemplateFamilyResult {
  family: 'legacy' | 'match2' | 'unknown';
  signature: string | null;
}

/**
 * The modern nested (`match2`) family's signature: a `{{Bracket|...}}` call
 * whose first positional argument is a `Bracket/<layout>` name, followed by
 * an `id=` parameter (RESEARCH section 3.2/3.3).
 */
const MATCH2_SIGNATURE = /\{\{Bracket\|Bracket\/[\w-]+\|id=\w+/;

/**
 * The legacy prefixed-parameter family's signature: the presence of a
 * side-round-match player parameter, optionally suffixed `score` or `flag`
 * (RESEARCH section 3.1/3.3). Anchored with a leading `|` so it can only
 * match a real parameter name, never arbitrary prose.
 */
const LEGACY_SIGNATURE = /\|[rl]\d+m\d+p\d(?:score|flag)?=/;

/**
 * Detects which bracket-rendering template family produced `source`,
 * evaluated in this fixed order and documented here with its justification
 * (RESEARCH section 3.3): the modern `match2` signature is checked FIRST,
 * then the legacy signature, then `'unknown'`. The two signatures were
 * verified mutually exclusive across all six pages inspected during
 * research — a `match2` page contains no `rNmM` parameter, and a legacy
 * page contains no `{{Bracket|Bracket/...}}` call — so this fixed order
 * makes the outcome deterministic rather than dependent on where either
 * signature happens to sit in the document.
 *
 * `'unknown'` is a FIRST-CLASS outcome (T-30.2-21): a page whose template
 * family this function cannot recognise is never guessed at and never
 * silently skipped. The caller must record it, together with
 * `hashWikitext`'s content hash, as a countable unmatched-coverage entry —
 * this function itself never falls back to a family and never returns a
 * value outside `'legacy' | 'match2' | 'unknown'`.
 */
export function detectTemplateFamily(source: string): DetectTemplateFamilyResult {
  const match2Match = MATCH2_SIGNATURE.exec(source);
  if (match2Match) {
    return { family: 'match2', signature: match2Match[0] };
  }
  const legacyMatch = LEGACY_SIGNATURE.exec(source);
  if (legacyMatch) {
    return { family: 'legacy', signature: legacyMatch[0] };
  }
  return { family: 'unknown', signature: null };
}
