import { LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS } from '../src/liquipedia/limiter.js';
import type { LiquipediaClient, LiquipediaPageRevisionResult } from '../src/liquipedia/client.js';
import { assertOutputPathIsGitignored } from './outputPathGuard.js';

/**
 * Phase 36 Plan 07 (LIQ-01): the pure, testable half of the Liquipedia
 * research spike. `liqSpikeProbe.ts` is the thin CLI composition root that
 * supplies a real client (the shipped transport, the shipped RTDB-backed
 * distributed limiter, the required-contact User-Agent); this module never
 * constructs any of the three and never touches parse-class machinery — see
 * the plan's verify guard, which fails the build if the parse-class
 * allowlist, its predicate, or the generated-page method are referenced
 * anywhere below. The spike proves whether NEW page families are reachable
 * through `action=query` alone. Deciding a family genuinely needs
 * parse-class is a deliberate, later, Phase 42 allowlist change (D-22) —
 * this probe can only ever record a proposal for that change, never apply
 * one.
 *
 * Owner rerun incident (fix B): the first live run reported a 304ms
 * "spacing" between general-class requests, nowhere near the real ~2000ms
 * the shipped limiter enforces. That number was measured on request
 * COMPLETIONS, which conflate each request's own network latency with the
 * limiter's actual spacing. `checkGeneralRequestStartSpacing` below checks
 * the real figure — request START timestamps, supplied by the caller's
 * `fetchImpl` wrapper — and FAILS LOUDLY if it is ever violated.
 *
 * Owner rerun incident (fix C): the same live run returned two real
 * `/Results` pages at 246 and 248 bytes that are template stubs, but a
 * bare byte-threshold gate let both sail past as `sufficient` purely
 * because they were "long enough". `classifyWikitext` below is now
 * structural — template-only or bare-redirect content is
 * `stub-generator-only` regardless of size.
 *
 * Owner rerun incident (fix D): every `tournament-results`/
 * `other-entrant-brackets` title in the first version of this probe was a
 * guess, and all of them were wrong (0 subpages discovered, every title
 * reported missing). Both families were made DISCOVERABLE at run time via
 * `list=allpages` — SUPERSEDED by fix 3 below, which retracts one part of
 * this fix (seeding discovery from a player page's own internal links)
 * after it wasted the entire request budget on Melee-era pages.
 *
 * Owner rerun incident #2 (fix 2, classifier): the fix-C classifier was
 * STILL guessed against the real 245/248-byte page shapes (no network
 * access to inspect them, so the "template-only" shape assumed for those
 * two bytes counts was never actually confirmed) — the owner's rerun
 * showed both still classified `sufficient`. Rather than guess again,
 * `classifyWikitext` now strips templates/comments/categories/magic words
 * MECHANICALLY and checks what's left, AND every fetched page's raw
 * wikitext is persisted into the gitignored report (never printed), AND a
 * leak-free structural fingerprint (brace/link/pipe counts, line count,
 * redirect flag, first template name only) is printed to the console for
 * any page under ~1 KB — so the NEXT rerun's verdict is evidence-based,
 * not another guess.
 *
 * Owner rerun incident #2 (fix 3, discovery budget governance): the SAME
 * rerun showed fix D's "seed discovery from a player page's own internal
 * links" idea backfiring badly — `Hungrybox/Results` links to Melee-era
 * majors ("Zenith 2011", "Pound 4", ...), and following them burned the
 * ENTIRE 20-request budget on prefixes that were never going to yield an
 * Ultimate-era page, leaving `tournament-results`/`other-entrant-brackets`
 * with ZERO samples. This fix RETRACTS link-following entirely (discovery
 * now seeds ONLY from `LIQ_SPIKE_SERIES_PREFIX_SEEDS`, the deliberately
 * curated series names) and adds explicit PER-FAMILY reserved request
 * budgets (`LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS`/
 * `LIQ_SPIKE_RESERVED_FETCH_REQUESTS`) so ONE family's discovery attempts
 * can never crowd out another's — the plan is logged up front, and a
 * family that finds nothing within its OWN reservation is recorded as
 * `not-sampled` with a reason, never silently starved by a sibling
 * family's discovery loop. (A `list=search`/`srsearch` cheap-naming
 * discovery mechanism was also considered for this fix, but the shipped
 * `LiquipediaClient` interface exposes no generic query seam for it —
 * adding one would mean editing `client.ts`, outside this fix's
 * authorization, so it was not implemented; see the plan's SUMMARY.)
 *
 * Owner rerun #3 (D-29 confirmed live: `minObservedGeneralStartSpacingMs=
 * 2000`, budget 6/20, no thrown error; classifier confirmed against reality:
 * MKLeo/Results and Sparg0/Results, 245/248 bytes, both `stub-generator-only`
 * with an IDENTICAL fingerprint — `templates{{=7 links[[=0 pipes|=9 lines=11
 * firstTemplate="ResultsPageHeader"`; Hungrybox/Results sufficient,
 * IzAw/Results missing). REMAINING DEFECT this round fixes: discovery found
 * real subpages (Genesis 9, Smash Summit 10, Battle of BC 10, CEO 10,
 * Riptide 10) and STILL reported `not-sampled` for `tournament-results` —
 * the exact-suffix filters (`isTournamentEventPageTitle`/
 * `isSinglesBracketPageTitle`, requiring a literal `/Ultimate` or
 * `/Ultimate/Singles Bracket` tail) were THEMSELVES still a guess at
 * Liquipedia's naming convention, and none of the real discovered titles
 * carried that exact tail. Fixed by:
 *  - persisting and printing EVERY discovered title (`discoveredTitles` on
 *    `LiqSpikeDiscoveryResult`), so the real naming is visible even when
 *    nothing is accepted (previously discarded entirely);
 *  - replacing the exact-suffix filters with evidence-tolerant, whole-word
 *    token checks (`containsUltimateToken`/`containsBracketToken`/
 *    `containsSinglesToken`) plus a "most recent-looking page" fallback
 *    (`extractTrailingNumber`) for `tournament-results` and a
 *    "first subpage returned" fallback for `other-entrant-brackets`, so the
 *    run ALWAYS samples at least one real page per family instead of
 *    guessing a fourth exact shape;
 *  - recording, per sampled tournament/bracket page, whether its raw
 *    wikitext carries bracket/match-family templates (`containsBracketTemplate`/
 *    `containsMatchTemplate`, plus per-template-family counts in the
 *    fingerprint's `bracketTemplateCounts`) and a `resultsFormat` verdict
 *    (`'wikitext'` vs `'generated-template'` vs `'unknown'`) — this answers
 *    "are results/brackets reachable via wikitext at all" even for a family
 *    that never gets its own separate bracket subpage.
 * `listSubpages`'s per-request result limit was investigated for raising
 * (to reduce discovery-request count) and left UNCHANGED: the shipped
 * client sets no `aplimit` parameter at all (relying on the MediaWiki
 * default) and exposes no way for a caller to override it without adding a
 * parameter to `client.ts`, outside this fix's authorization.
 *
 * Owner rerun #4 (evidence-tolerant discovery fix confirmed live: 11/20
 * general requests, `budgetExhausted=false`; `tournament-results` sampled
 * real early-edition pages via the `fallback-latest` reason — no discovered
 * title anywhere carried an "Ultimate" token, because `listSubpages`
 * returns the first page of results ALPHABETICALLY and the shipped client
 * requests no `aplimit`, so only the earliest editions of each series are
 * ever seen; `other-entrant-brackets` sampled real 7-25 KB bracket pages).
 * REMAINING DEFECT this round fixes: `computeBracketTemplateCounts` matched
 * "Bracket"/"Match" only when a template name literally STARTED with that
 * word (`{{Bracket...}}`, `{{Match...}}`) — a guess never checked against
 * real bytes. All four real bracket pages sampled this run reported
 * `Bracket=0 Match=0`, an implausible result on 7-25 KB bracket pages that
 * the owner caught live. The real template names captured in this run's
 * report carry those words as a SUBSTRING, never as the first word —
 * `BracketMatchDetails` (the match wrapper, 21-30 uses per page),
 * `32DEWBracketA`, `DEFinalSmwBracket`, and siblings. Fixed by extracting
 * every `{{TemplateName`/`{{TemplateName|...}}` invocation's name and
 * matching "bracket"/"match"/"teamcard"/"prize" as a case-insensitive
 * substring anywhere in that name — EXCLUDING page-transclusion syntax
 * (`{{:Page Name}}`, a leading colon, which embeds a whole separate page
 * rather than calling a template, and would otherwise falsely flag a
 * tournament page that merely LINKS to its own bracket subpages as if it
 * carried bracket templates directly). `match2Count` is unchanged (a bare
 * text-token scan, not template-name-based) since no `match2`-shaped
 * markup was observed anywhere in this wiki's real samples — see the
 * LIQ-01 spike record for the full finding.
 */

/**
 * The exact `.gitignore` glob covering this probe's output (see the repo
 * root `.gitignore`, D-28). Uses `[^/]*` (not `.*`, WR-04-i2) — gitignore's
 * `*` glob never crosses a directory boundary, so the wildcard segment here
 * must not either, or the "exact glob" claim above is false for a nested
 * path like `apps/api/liq-spike-report-dir/evil.json`.
 */
export const LIQ_SPIKE_REPORT_OUT_PATTERN = /^apps\/api\/liq-spike-report[^/]*\.json$/;

export const LIQ_SPIKE_REPORT_OUT_PATTERN_DESCRIPTION = 'apps/api/liq-spike-report*.json';

/**
 * WR-03/D-28: refuses to write unless `--out` matches
 * `apps/api/liq-spike-report*.json` (the exact gitignored pattern this
 * script's docstring promises) AND is confirmed ignored by
 * `git check-ignore -q`. Called BEFORE any network/RTDB read — see
 * `liqSpikeProbe.ts`'s `main()`. Throws `UnsafeOutputPathError`; the
 * message never includes any page content or PII. Returns the resolved
 * absolute path — see `assertOutputPathIsGitignored`'s doc comment for why
 * the caller must write to exactly this value.
 */
export function assertSafeLiqSpikeOutPath(options: {
  outPath: string;
  repoRoot: string;
  isGitIgnored?: (absolutePath: string, repoRoot: string) => boolean;
}): string {
  return assertOutputPathIsGitignored({
    ...options,
    allowedPattern: LIQ_SPIKE_REPORT_OUT_PATTERN,
    allowedPatternDescription: LIQ_SPIKE_REPORT_OUT_PATTERN_DESCRIPTION,
  });
}

export type LiqSpikeFamily = 'player-results' | 'tournament-results' | 'other-entrant-brackets';

export interface LiqSpikeTarget {
  family: LiqSpikeFamily;
  /** Real page titles fetched via `action=query`+`prop=revisions` (wikitext). At most four per family — a bounded probe, not a crawl. */
  titles: string[];
  /** Why this family matters to LIQ-01. */
  why: string;
}

/**
 * The ONLY statically-titled family. `player-results` pages for the four
 * tracked demo accounts are real, specific, known titles — no discovery is
 * needed to name them. `tournament-results` and `other-entrant-brackets`
 * are NOT listed here: every title in those two families was a guess in the
 * first version of this probe, and every guess was wrong (the owner's first
 * live run: 0 subpages discovered, every title reported missing). Both are
 * now resolved at RUN TIME by `runLiqSpike`'s discovery stages below,
 * through `list=allpages` only — never a second guess.
 */
export const LIQ_SPIKE_TARGETS: readonly LiqSpikeTarget[] = Object.freeze([
  {
    family: 'player-results',
    titles: ['Sparg0/Results', 'MkLeo/Results', 'Hungrybox/Results', 'IzAw/Results'],
    why: "A player's aggregated results/placements page — the shape a cross-player opponent-evidence surface (LIQ-04, Phase 42) would need to read, distinct from the already-shipped VODs-page family.",
  },
]);

/** Upper bound on TOTAL `action=query` requests this probe will ever issue in one run, across static fetches and both discovery cascades — stated explicitly so a run can never silently balloon past a bounded spike. */
export const LIQ_SPIKE_MAX_GENERAL_REQUESTS = 20;

/** Upper bound on titles fetched per discovered family — mirrors the static family's own "at most four" bound. */
export const LIQ_SPIKE_MAX_TITLES_PER_DISCOVERY_FAMILY = 4;

/**
 * Upper bound on `list=allpages` discovery ATTEMPTS spent per discovered
 * family (fix 3). Reserved SEPARATELY per family — never shared — so one
 * family's fruitless discovery loop (e.g. every series-name prefix missing
 * a real page) can never crowd out the request budget the OTHER discovered
 * family still needs. The owner's rerun showed exactly this failure mode
 * under fix D's link-following: it silently consumed the ENTIRE run
 * chasing Melee-era prefixes, leaving zero budget for anything else.
 */
export const LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS = 5;

/** Upper bound on the wikitext-fetch request spent per discovered family, once titles are found — always exactly one batched call. */
export const LIQ_SPIKE_RESERVED_FETCH_REQUESTS = 1;

/**
 * Series-name prefixes seeding `tournament-results` discovery — a SERIES
 * name (the recurring event brand every year's page nests under), never a
 * full guessed page title. Fix 3 (owner rerun #2): this is now the ONLY
 * seed source — a player page's own internal links are NOT followed
 * (retracted; see this file's module doc comment for why).
 */
export const LIQ_SPIKE_SERIES_PREFIX_SEEDS: readonly string[] = Object.freeze([
  'Genesis',
  'Smash Summit',
  'Battle of BC',
  'CEO',
  'Riptide',
]);

/**
 * Owner rerun #3: the exact-suffix filters this replaced
 * (`/Ultimate`/`/Ultimate/Singles Bracket`) were themselves a GUESS at
 * Liquipedia's naming convention, and the live rerun proved it wrong —
 * discovery found real pages (Genesis 9, Smash Summit 10, Battle of BC 10,
 * CEO 10, Riptide 10) that the exact-suffix check rejected outright,
 * leaving `tournament-results` with zero samples even though real pages
 * were RIGHT THERE. These token-based checks are evidence-tolerant: they
 * accept a broader, still-mechanical shape (a whole word/path-segment
 * match, never a substring), and — for `tournament-results` specifically —
 * a "most recent-looking page" fallback (`extractTrailingNumber` below)
 * guarantees the run samples at least one real page even when no title
 * contains the token at all, so the NEXT rerun learns the real naming
 * instead of guessing a fourth time.
 */
const ULTIMATE_TOKEN_PATTERN = /\bUltimate\b/i;
const BRACKET_TOKEN_PATTERN = /\bBracket\b/i;
const SINGLES_TOKEN_PATTERN = /\bSingles\b/i;

/** True when `title` contains "Ultimate" as a whole word/path segment (case-insensitive) — evidence-tolerant, never an exact-suffix guess. */
export function containsUltimateToken(title: string): boolean {
  return ULTIMATE_TOKEN_PATTERN.test(title);
}

/** True when `title` contains "Bracket" as a whole word (case-insensitive). */
export function containsBracketToken(title: string): boolean {
  return BRACKET_TOKEN_PATTERN.test(title);
}

/** True when `title` contains "Singles" as a whole word (case-insensitive) — used to PREFER a singles bracket over a doubles/other bracket, never to exclude the latter outright. */
export function containsSinglesToken(title: string): boolean {
  return SINGLES_TOKEN_PATTERN.test(title);
}

/**
 * Extracts the LAST run of digits anywhere in `title` (a year or edition
 * number, e.g. `10` from `"Battle of BC 10"`) — used ONLY to rank fallback
 * candidates by "most recent-looking" when no token match exists at all.
 * Never used to construct or guess a title; only to choose among titles
 * the API already returned. `null` when the title carries no such number.
 */
export function extractTrailingNumber(title: string): number | null {
  const match = title.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

export type LiqSpikeWikitextVerdict = 'sufficient' | 'stub-generator-only' | 'missing';

/**
 * A leak-free structural summary of a page's wikitext — printed to the
 * console for any page under `LIQ_SPIKE_FINGERPRINT_MAX_BYTES`, so the
 * classification is evidence-based rather than a guess without ever
 * printing the actual content. `firstTemplateName` is the ONE piece of
 * near-content this carries (a template NAME, e.g. "Infobox player
 * results" — never a template argument, a page value, or prose).
 */
/**
 * Counts only — never a matched excerpt — of the specific template
 * families that indicate a page's results/bracket data lives inside a
 * generator template rather than as plain wikitext. Names and counts only,
 * per the owner's rerun-#3 instruction; leaks no page content.
 */
export interface LiqSpikeBracketTemplateCounts {
  bracketCount: number;
  matchCount: number;
  match2Count: number;
  teamCardCount: number;
  prizePoolCount: number;
}

export interface LiqSpikeWikitextFingerprint {
  templateOpenCount: number;
  internalLinkOpenCount: number;
  pipeCount: number;
  lineCount: number;
  startsWithRedirect: boolean;
  firstTemplateName: string | null;
  bracketTemplateCounts: LiqSpikeBracketTemplateCounts;
}

export interface LiqSpikePageResult {
  family: LiqSpikeFamily;
  title: string;
  revisionId: number | undefined;
  byteSize: number;
  wikitextVerdict: LiqSpikeWikitextVerdict;
  /**
   * Present only when `wikitextVerdict === 'stub-generator-only'`: the
   * anchored regex a DELIBERATE future allowlist change would need, stated
   * as a plain string — never applied here, never a code change.
   */
  proposedAllowlistRegex?: string;
  /**
   * Present for every `player-results` page under
   * `LIQ_SPIKE_FINGERPRINT_MAX_BYTES`, and ALWAYS for `tournament-results`/
   * `other-entrant-brackets` pages regardless of size (owner rerun #3, item
   * 4) — a real tournament page is expected to exceed the 1KB gate that
   * exists purely to avoid a noisy fingerprint for every large player page.
   * See `LiqSpikeWikitextFingerprint`.
   */
  fingerprint?: LiqSpikeWikitextFingerprint;
  /**
   * The full, byte-faithful wikitext this probe fetched, for every PRESENT
   * page regardless of size. Persisted ONLY into the gitignored `--out`
   * report file (`liqSpikeProbe.ts` never prints this field) — the
   * fingerprint above is what reaches the console.
   */
  rawWikitext?: string;
  /** `true` when the raw wikitext contains at least one `{{Bracket...}}` transclusion — a boolean flag, never a count or excerpt (owner rerun #3, item 3). */
  containsBracketTemplate: boolean;
  /** `true` when the raw wikitext contains at least one `{{Match...}}` transclusion or a `match2`-system token. */
  containsMatchTemplate: boolean;
  /**
   * Whether this page's placements/results appear directly as stored
   * wikitext (`'wikitext'`), only inside a generator template with no
   * substantive content outside it (`'generated-template'` — would need
   * `action=parse`/LPDB to read), or the page is missing (`'unknown'`).
   */
  resultsFormat: 'wikitext' | 'generated-template' | 'unknown';
  completedAtMs: number;
}

export interface LiqSpikeDiscoveredPage {
  title: string;
  pageId: number;
}

export interface LiqSpikeDiscoveryResult {
  family: LiqSpikeFamily;
  /** The `list=allpages` prefix tried — a series name or a discovered tournament event page, never a guessed full title. */
  prefix: string;
  discoveredCount: number;
  /**
   * EVERY page `list=allpages` returned for this prefix (title + pageid) —
   * public wiki page names, never PII (owner rerun #3, item 1: the prior
   * version discarded these, so nobody could see what Liquipedia actually
   * names these pages). Always namespace 0 — the shipped client's
   * `listSubpages` always queries `apnamespace=0` — so no separate
   * namespace field is carried per entry.
   */
  discoveredTitles: LiqSpikeDiscoveredPage[];
  /** Discovered titles this family's evidence-tolerant filter actually accepted (bounded by the per-family title cap). */
  acceptedTitles: string[];
  /** One reason per `acceptedTitles` entry, same order — e.g. `'ultimate-token'`, `'fallback-latest'`, `'bracket-token'`, `'bracket-token-singles'`, `'fallback-first-subpage'`. */
  acceptedReasons: string[];
  completedAtMs: number;
}

export interface LiqSpikeNormalization {
  family: LiqSpikeFamily;
  from: string;
  to: string;
}

export interface LiqSpikeBudget {
  generalRequests: number;
  /** Always 0 — this probe issues `action=query` only. */
  parseClassRequests: number;
  /** Minimum observed spacing between consecutive general-class request COMPLETIONS. Secondary/informational only: it conflates each request's own network latency with the limiter's actual spacing and can read anywhere from far below to far above the true interval — see `minObservedGeneralStartSpacingMs` for the figure that actually proves limiter compliance. */
  minObservedGeneralCompletionSpacingMs: number | null;
  /** Minimum observed spacing between consecutive general-class request STARTS (fetch dispatch time, recorded by the caller's `fetchImpl` wrapper — see `LiqSpikeDeps.generalRequestStartTimestampsMs`). `null` when the caller supplied no start timestamps. */
  minObservedGeneralStartSpacingMs: number | null;
  /** Always `null` — no parse-class request is ever issued by this probe. */
  minObservedParseClassSpacingMs: number | null;
  /** The cap this run enforced (see `LIQ_SPIKE_MAX_GENERAL_REQUESTS`). */
  maxGeneralRequests: number;
  /** True when the run stopped issuing further requests because it hit `maxGeneralRequests` before exhausting its discovery candidates. */
  budgetExhausted: boolean;
}

/**
 * Fix 3 (owner rerun #2): one entry per family, so a family that got no
 * samples is a RECORDED, explained outcome — never silent starvation by a
 * sibling family's discovery loop, and never conflated with a family that
 * genuinely has no reachable page.
 */
export interface LiqSpikeFamilyOutcome {
  family: LiqSpikeFamily;
  status: 'sampled' | 'not-sampled';
  /** Present only when `status === 'not-sampled'` — e.g. `"budget"` or `"no matching titles discovered among N prefix(es) tried"`. */
  reason?: string;
  sampledTitles: string[];
}

export interface LiqSpikeReport {
  pages: LiqSpikePageResult[];
  discoveries: LiqSpikeDiscoveryResult[];
  /** Every `query.normalized` entry the API itself returned (e.g. a title-casing correction) — surfaced, never guessed around. */
  normalizations: LiqSpikeNormalization[];
  /** Every `query.redirects` entry the API itself followed (the `redirects=1` parameter every `getWikitext` call already sends). */
  redirectsFollowed: LiqSpikeNormalization[];
  /** One entry per family (`player-results`, `tournament-results`, `other-entrant-brackets`) — see `LiqSpikeFamilyOutcome`. */
  familyOutcomes: LiqSpikeFamilyOutcome[];
  budget: LiqSpikeBudget;
}

/**
 * Fix 4: thrown by `runLiqSpike` for ANY failure — including a real
 * general-class request-spacing violation (fix 1 makes that structurally
 * impossible under normal, sequential, single-process operation, but the
 * check itself stays; a defensive check that can never fire costs nothing,
 * and removing it would trade a provable guarantee for an assumption) and
 * any other error (a network failure, a malformed response, ...) —
 * carrying whatever evidence THIS run had already gathered before the
 * failure. The caller (`liqSpikeProbe.ts`) writes `partialReport` to the
 * guard-validated `--out` path before exiting non-zero: the owner must
 * never again lose an entire run's fetched evidence to a late failure, the
 * way the first live run's ENOENT write bug did.
 */
export class LiqSpikePartialRunError extends Error {
  constructor(
    message: string,
    readonly partialReport: LiqSpikeReport,
  ) {
    super(message);
    this.name = 'LiqSpikePartialRunError';
  }
}

export interface LiqSpikeDeps {
  client: LiquipediaClient;
  now: () => number;
  log: (line: string) => void;
  /**
   * Populated by the CALLER's `fetchImpl` wrapper with the `now()` value at
   * the moment EACH underlying HTTP request was actually dispatched (i.e.
   * immediately after the limiter granted) — this module has no access to
   * the raw transport and never populates this itself. When omitted, the
   * report's start-spacing fields are `null` and no compliance check runs.
   */
  generalRequestStartTimestampsMs?: number[];
}

export interface LiqSpikeRunOptions {
  seedPrefixes?: readonly string[];
  maxGeneralRequests?: number;
  maxTitlesPerDiscoveryFamily?: number;
}

/** A page under this size gets a printed structural fingerprint (leak-free) instead of its verdict being taken on faith. */
export const LIQ_SPIKE_FINGERPRINT_MAX_BYTES = 1024;

/** Matches a MediaWiki redirect declaration, e.g. `#REDIRECT [[MKLeo/Results]]`, at the very start of the wikitext (leading whitespace tolerated). */
const REDIRECT_DECLARATION_PATTERN = /^\s*#REDIRECT\s*:?\s*\[\[[^\]]+\]\]\s*/i;

/** HTML comments — never substantive content. */
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

/** A single, non-nested `{{...}}` template transclusion. Applied repeatedly (bounded) below to also remove simply-nested templates. */
const TEMPLATE_TRANSCLUSION_PATTERN = /\{\{[^{}]*\}\}/g;

/** A category link — organizational metadata, never substantive content. */
const CATEGORY_LINK_PATTERN = /\[\[Category:[^\]]*\]\]/gi;

/** MediaWiki "magic words" (`__NOTOC__`, `__TOC__`, etc.) — page-behavior directives, never content. */
const MAGIC_WORD_PATTERN = /__[A-Z][A-Z0-9_]*__/g;

/** Bounds the repeated template-stripping pass below against pathological/malformed input. */
const MAX_TEMPLATE_STRIP_ITERATIONS = 10;

/**
 * Strips templates (repeatedly, to also clear simply-nested ones),
 * comments, category links, magic words, and a single leading redirect
 * declaration — the generator/organizational scaffolding a Liquipedia page
 * can carry — leaving only whatever, if anything, is genuine page content.
 */
function stripNonSubstantiveWikitext(wikitext: string): string {
  let stripped = wikitext.replace(REDIRECT_DECLARATION_PATTERN, '');
  stripped = stripped.replace(HTML_COMMENT_PATTERN, '');
  for (let i = 0; i < MAX_TEMPLATE_STRIP_ITERATIONS; i += 1) {
    const next = stripped.replace(TEMPLATE_TRANSCLUSION_PATTERN, '');
    if (next === stripped) {
      break;
    }
    stripped = next;
  }
  stripped = stripped.replace(CATEGORY_LINK_PATTERN, '');
  stripped = stripped.replace(MAGIC_WORD_PATTERN, '');
  return stripped;
}

/** A MediaWiki table block (`{|` ... `|}`) or a list-markup line (`*`, `#`, `;`, `:` at line start) — genuine content structure, never generator scaffolding. */
function hasTableOrListMarkup(wikitext: string): boolean {
  if (wikitext.includes('{|')) {
    return true;
  }
  return wikitext.split('\n').some((line) => /^\s*[*#;:]/.test(line));
}

/**
 * Classifies wikitext by CONTENT STRUCTURE, never by byte count and never
 * by a guessed shape. Two earlier versions of this function both guessed
 * wrong against the real page bodies (a bare byte threshold, then an
 * "every line is a solitary template" pattern) — this probe has no network
 * access to inspect the real bytes directly, so guessing a THIRD shape
 * would repeat the same mistake. Instead: strip every piece of generator/
 * organizational scaffolding (`stripNonSubstantiveWikitext`) and check
 * what's left — if nothing but whitespace remains AND there is no table or
 * list markup, the page is `stub-generator-only`; otherwise it is
 * `sufficient`, regardless of size. A revision the API reports missing is
 * handled by the caller before this function ever runs. Every fetched
 * page's raw wikitext is ALSO persisted into the report (see
 * `LiqSpikePageResult.rawWikitext`) so a wrong verdict here is checkable
 * evidence, not another guess to trust blindly.
 */
function classifyWikitext(content: string): LiqSpikeWikitextVerdict {
  const stripped = stripNonSubstantiveWikitext(content);
  if (stripped.trim().length === 0 && !hasTableOrListMarkup(stripped)) {
    return 'stub-generator-only';
  }
  return 'sufficient';
}

/**
 * A leak-free structural summary — see `LiqSpikeWikitextFingerprint`'s doc
 * comment. `firstTemplateName` reads only the text between `{{` and the
 * first `|` or `}}`, trimmed — never a template argument or page content.
 */
/**
 * Every `{{TemplateName`/`{{TemplateName|...}}` invocation's name in
 * `content`, trimmed, in document order — EXCLUDING page-transclusion
 * syntax (`{{:Page Name}}`, a leading colon), which embeds an entire
 * separate page rather than calling a template. Names only, never a
 * template argument or page content.
 */
function extractTemplateNames(content: string): string[] {
  const names: string[] = [];
  const pattern = /\{\{\s*([^|}\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const name = match[1]!.trim();
    if (name.startsWith(':')) {
      continue;
    }
    names.push(name);
  }
  return names;
}

function countNamesContaining(names: readonly string[], substring: string): number {
  const needle = substring.toLowerCase();
  return names.filter((name) => name.toLowerCase().includes(needle)).length;
}

/**
 * Counts specific template FAMILIES known to carry generated
 * results/bracket data on Liquipedia. `bracketCount`/`matchCount`/
 * `teamCardCount`/`prizePoolCount` match "bracket"/"match"/"teamcard"/
 * "prize" as a case-insensitive SUBSTRING anywhere in a template's name
 * (see this module's owner-rerun-#4 doc comment for why an anchored-at-start
 * match missed every real bracket page sampled live — e.g.
 * `BracketMatchDetails`, `32DEWBracketA`, `DEFinalSmwBracket`).
 * `match2Count` stays a bare full-text token scan (`\bmatch2\b`), not
 * template-name-based, for the `match2` data format used by some
 * Liquipedia wikis (not observed on this wiki's real samples). Names and
 * counts only — never a matched excerpt.
 */
function computeBracketTemplateCounts(content: string): LiqSpikeBracketTemplateCounts {
  const names = extractTemplateNames(content);
  return {
    bracketCount: countNamesContaining(names, 'bracket'),
    matchCount: countNamesContaining(names, 'match'),
    match2Count: (content.match(/\bmatch2\b/gi) ?? []).length,
    teamCardCount: countNamesContaining(names, 'teamcard'),
    prizePoolCount: countNamesContaining(names, 'prize'),
  };
}

/** True when any bracket/match-family template was found — the boolean this probe uses to decide whether results live in a generator template. */
function hasBracketOrMatchTemplates(counts: LiqSpikeBracketTemplateCounts): boolean {
  return counts.bracketCount > 0 || counts.matchCount > 0 || counts.match2Count > 0;
}

/**
 * Whether this page's placements/results appear directly as stored
 * wikitext, only inside a generator template (bracket/match templates
 * present but the page otherwise strips to nothing — see
 * `classifyWikitext`), or the page is missing/unclassifiable.
 */
function classifyResultsFormat(
  verdict: LiqSpikeWikitextVerdict,
  bracketOrMatchPresent: boolean,
): 'wikitext' | 'generated-template' | 'unknown' {
  if (verdict === 'missing') {
    return 'unknown';
  }
  if (verdict === 'sufficient') {
    return 'wikitext';
  }
  return bracketOrMatchPresent ? 'generated-template' : 'unknown';
}

function computeWikitextFingerprint(
  content: string,
  bracketTemplateCounts: LiqSpikeBracketTemplateCounts,
): LiqSpikeWikitextFingerprint {
  const templateOpenCount = (content.match(/\{\{/g) ?? []).length;
  const internalLinkOpenCount = (content.match(/\[\[/g) ?? []).length;
  const pipeCount = (content.match(/\|/g) ?? []).length;
  const lineCount = content.split('\n').length;
  const startsWithRedirect = /^\s*#REDIRECT/i.test(content);
  const firstTemplateMatch = content.match(/\{\{\s*([^|}]+)/);
  const firstTemplateName = firstTemplateMatch ? firstTemplateMatch[1]!.trim() : null;
  return {
    templateOpenCount,
    internalLinkOpenCount,
    pipeCount,
    lineCount,
    startsWithRedirect,
    firstTemplateName,
    bracketTemplateCounts,
  };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Anchored on both ends, mirroring the shipped VODs-page allowlist pattern's own convention — never a substring match. */
function proposeAllowlistRegexFor(title: string): string {
  const lastSegment = title.includes('/') ? title.slice(title.lastIndexOf('/') + 1) : title;
  return `^[^/]+/${escapeRegExpLiteral(lastSegment)}$`;
}

function computeMinSpacingMs(timestampsMs: readonly number[]): number | null {
  if (timestampsMs.length < 2) {
    return null;
  }
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < sorted.length; i += 1) {
    min = Math.min(min, sorted[i]! - sorted[i - 1]!);
  }
  return min;
}

export interface LiqSpikeStartSpacingCheck {
  minObservedStartSpacingMs: number | null;
  compliant: boolean;
  violation?: { indexA: number; indexB: number; gapMs: number };
}

/**
 * Checks general-class request START timestamps against the published
 * minimum interval. Fewer than two timestamps is trivially compliant (no
 * pair to check). Returns the FIRST violation found (there may be more) —
 * enough to fail loudly; a full accounting belongs in the written spike
 * record, not this hot check.
 */
export function checkGeneralRequestStartSpacing(
  startTimestampsMs: readonly number[],
  minIntervalMs: number = LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
): LiqSpikeStartSpacingCheck {
  if (startTimestampsMs.length < 2) {
    return { minObservedStartSpacingMs: null, compliant: true };
  }
  const sorted = [...startTimestampsMs].sort((a, b) => a - b);
  let min = Infinity;
  let violation: LiqSpikeStartSpacingCheck['violation'];
  for (let i = 1; i < sorted.length; i += 1) {
    const gapMs = sorted[i]! - sorted[i - 1]!;
    if (gapMs < min) {
      min = gapMs;
    }
    if (gapMs < minIntervalMs && !violation) {
      violation = { indexA: i - 1, indexB: i, gapMs };
    }
  }
  return { minObservedStartSpacingMs: min, compliant: violation === undefined, violation };
}

/**
 * Runs the bounded LIQ-01 spike: `action=query` only, through the
 * caller-supplied client.
 *
 * Stage 1 fetches the static `player-results` titles. Stage 2 discovers
 * real `tournament-results` titles via `list=allpages`, seeded ONLY from
 * `LIQ_SPIKE_SERIES_PREFIX_SEEDS` (fix 3 — a player page's own internal
 * links are never followed; see this file's module doc comment). Stage 3
 * discovers real `other-entrant-brackets` titles the SAME way, seeded from
 * the tournament event pages Stage 2 actually found (a discovered event
 * page's own bracket subpage lives directly under it). Stages 2 and 3 each
 * draw on their OWN reserved discovery/fetch budget
 * (`LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS`/
 * `LIQ_SPIKE_RESERVED_FETCH_REQUESTS`), never the other's, on top of the
 * overall `LIQ_SPIKE_MAX_GENERAL_REQUESTS` cap — the plan is logged up
 * front. Never throws on a missing or undiscoverable title — a family
 * that finds nothing is recorded `not-sampled` with a reason (see
 * `LiqSpikeFamilyOutcome`) and the run still completes cleanly. The ONE
 * thing this function DOES throw on is an observed general-class
 * request-spacing violation, which is a real terms-of-use breach and must
 * never be silently recorded.
 */
export async function runLiqSpike(
  deps: LiqSpikeDeps,
  targets: readonly LiqSpikeTarget[] = LIQ_SPIKE_TARGETS,
  runOptions: LiqSpikeRunOptions = {},
): Promise<LiqSpikeReport> {
  const seedPrefixes = runOptions.seedPrefixes ?? LIQ_SPIKE_SERIES_PREFIX_SEEDS;
  const maxGeneralRequests = runOptions.maxGeneralRequests ?? LIQ_SPIKE_MAX_GENERAL_REQUESTS;
  const maxTitlesPerDiscoveryFamily =
    runOptions.maxTitlesPerDiscoveryFamily ?? LIQ_SPIKE_MAX_TITLES_PER_DISCOVERY_FAMILY;

  const pages: LiqSpikePageResult[] = [];
  const discoveries: LiqSpikeDiscoveryResult[] = [];
  const normalizations: LiqSpikeNormalization[] = [];
  const redirectsFollowed: LiqSpikeNormalization[] = [];
  const familyOutcomes: LiqSpikeFamilyOutcome[] = [];
  const completionTimestampsMs: number[] = [];

  let generalRequestCount = 0;
  let budgetExhausted = false;

  const hasBudget = (): boolean => {
    if (generalRequestCount >= maxGeneralRequests) {
      if (!budgetExhausted) {
        budgetExhausted = true;
        deps.log(
          `liq-spike: general-request budget (${maxGeneralRequests}) exhausted — skipping remaining work`,
        );
      }
      return false;
    }
    return true;
  };

  deps.log(
    `liq-spike: planned up to ${
      targets.length +
      2 * (LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS + LIQ_SPIKE_RESERVED_FETCH_REQUESTS)
    } general requests (cap ${maxGeneralRequests}) — player-results=${targets.length} static fetch(es), ` +
      `tournament-results discovery<=${LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS}+fetch<=${LIQ_SPIKE_RESERVED_FETCH_REQUESTS}, ` +
      `other-entrant-brackets discovery<=${LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS}+fetch<=${LIQ_SPIKE_RESERVED_FETCH_REQUESTS}`,
  );

  const recordNormalizations = (
    family: LiqSpikeFamily,
    entries: { from: string; to: string }[] | undefined,
    sink: LiqSpikeNormalization[],
    label: string,
  ): void => {
    for (const entry of entries ?? []) {
      sink.push({ family, from: entry.from, to: entry.to });
      deps.log(`liq-spike: [${family}] ${label} "${entry.from}" -> "${entry.to}"`);
    }
  };

  const pushPage = (
    family: LiqSpikeFamily,
    page: LiquipediaPageRevisionResult,
    completedAtMs: number,
  ): { verdict: LiqSpikeWikitextVerdict; content: string } => {
    if (!page.present) {
      pages.push({
        family,
        title: page.title,
        revisionId: undefined,
        byteSize: 0,
        wikitextVerdict: 'missing',
        containsBracketTemplate: false,
        containsMatchTemplate: false,
        resultsFormat: 'unknown',
        completedAtMs,
      });
      deps.log(`liq-spike: [${family}] "${page.title}" -> missing`);
      return { verdict: 'missing', content: '' };
    }

    const content = page.content ?? '';
    const byteSize = page.size ?? Buffer.byteLength(content, 'utf8');
    const wikitextVerdict = classifyWikitext(content);
    const bracketTemplateCounts = computeBracketTemplateCounts(content);
    const bracketOrMatchPresent = hasBracketOrMatchTemplates(bracketTemplateCounts);
    const resultsFormat = classifyResultsFormat(wikitextVerdict, bracketOrMatchPresent);
    // Owner rerun #3, item 4: always fingerprint tournament-results/
    // other-entrant-brackets pages regardless of size — the 1KB gate exists
    // only to avoid a noisy fingerprint for every large player page, and a
    // real tournament page is expected to exceed it (Hungrybox/Results
    // alone was 9417 bytes).
    const shouldFingerprint =
      byteSize < LIQ_SPIKE_FINGERPRINT_MAX_BYTES || family !== 'player-results';
    const fingerprint = shouldFingerprint
      ? computeWikitextFingerprint(content, bracketTemplateCounts)
      : undefined;
    pages.push({
      family,
      title: page.title,
      revisionId: page.revisionId,
      byteSize,
      wikitextVerdict,
      ...(wikitextVerdict === 'stub-generator-only'
        ? { proposedAllowlistRegex: proposeAllowlistRegexFor(page.title) }
        : {}),
      ...(fingerprint ? { fingerprint } : {}),
      rawWikitext: content,
      containsBracketTemplate: bracketTemplateCounts.bracketCount > 0,
      containsMatchTemplate:
        bracketTemplateCounts.matchCount > 0 || bracketTemplateCounts.match2Count > 0,
      resultsFormat,
      completedAtMs,
    });
    deps.log(
      `liq-spike: [${family}] "${page.title}" -> ${wikitextVerdict} (revid=${page.revisionId ?? 'n/a'}, bytes=${byteSize}, resultsFormat=${resultsFormat})`,
    );
    return { verdict: wikitextVerdict, content };
  };

  // Fix 4: every stage below runs inside ONE try block. On ANY failure —
  // including the spacing-violation throw at the end — the catch builds a
  // report from WHATEVER these outer-scoped accumulators hold at that
  // moment and throws LiqSpikePartialRunError, so the caller can still
  // write real evidence to disk instead of losing the whole run.
  try {
    // ---- Stage 1: static player-results titles ----
    const playerResultsTitles: string[] = [];
    for (const target of targets) {
      playerResultsTitles.push(...target.titles);
      if (!hasBudget()) {
        break;
      }
      const result = await deps.client.getWikitext(target.titles);
      generalRequestCount += 1;
      const completedAtMs = deps.now();
      completionTimestampsMs.push(completedAtMs);

      recordNormalizations(target.family, result.normalized, normalizations, 'normalized');
      recordNormalizations(target.family, result.redirects, redirectsFollowed, 'redirected');

      for (const page of result.pages) {
        pushPage(target.family, page, completedAtMs);
      }
    }
    if (targets.length > 0) {
      familyOutcomes.push({
        family: 'player-results',
        status: 'sampled',
        sampledTitles: playerResultsTitles,
      });
    }

    // ---- Stage 2: discover real tournament-results titles (fix 3: seeded
    // ONLY from LIQ_SPIKE_SERIES_PREFIX_SEEDS, never from a player page's own
    // links — see this file's module doc comment). Owner rerun #3: EVERY
    // discovered title is persisted (item 1), and acceptance is
    // evidence-tolerant (item 2) — a whole-word "Ultimate" token match is
    // preferred; the "most recent-looking" fallback is used ONLY if that
    // token matched NOTHING across every prefix tried, decided once ALL
    // prefixes have been discovered (never per-prefix), so the run always
    // samples at least one real page instead of guessing a fourth exact
    // suffix. ----
    const tournamentTitles: string[] = [];
    const seenTournamentTitles = new Set<string>();
    let tournamentDiscoveryAttempts = 0;
    const tournamentPerPrefix: {
      prefix: string;
      entries: LiqSpikeDiscoveredPage[];
      completedAtMs: number;
    }[] = [];
    let anyUltimateTokenMatch = false;

    for (const prefix of seedPrefixes) {
      if (tournamentDiscoveryAttempts >= LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS) {
        break;
      }
      if (!hasBudget()) {
        break;
      }
      const discovered = await deps.client.listSubpages(prefix, { maxContinuations: 0 });
      tournamentDiscoveryAttempts += 1;
      generalRequestCount += 1;
      const completedAtMs = deps.now();
      completionTimestampsMs.push(completedAtMs);

      const entries: LiqSpikeDiscoveredPage[] = discovered.map((entry) => ({
        title: entry.title,
        pageId: entry.pageId,
      }));
      tournamentPerPrefix.push({ prefix, entries, completedAtMs });
      if (entries.some((entry) => containsUltimateToken(entry.title))) {
        anyUltimateTokenMatch = true;
      }

      deps.log(
        `liq-spike: [tournament-results] discovered ${discovered.length} subpage(s) under "${prefix}"` +
          (entries.length > 0 ? `: ${entries.map((entry) => entry.title).join(', ')}` : ''),
      );
    }

    // Acceptance, decided once — never per-prefix — per the fallback rule above.
    for (const { prefix, entries, completedAtMs } of tournamentPerPrefix) {
      const accepted: string[] = [];
      const acceptedReasons: string[] = [];

      if (anyUltimateTokenMatch) {
        for (const entry of entries) {
          if (
            containsUltimateToken(entry.title) &&
            !seenTournamentTitles.has(entry.title) &&
            tournamentTitles.length + accepted.length < maxTitlesPerDiscoveryFamily
          ) {
            accepted.push(entry.title);
            acceptedReasons.push('ultimate-token');
          }
        }
      } else if (tournamentTitles.length < maxTitlesPerDiscoveryFamily) {
        let best: LiqSpikeDiscoveredPage | undefined;
        let bestNumber = -Infinity;
        for (const entry of entries) {
          const trailing = extractTrailingNumber(entry.title);
          if (trailing !== null && trailing > bestNumber) {
            best = entry;
            bestNumber = trailing;
          }
        }
        if (best && !seenTournamentTitles.has(best.title)) {
          accepted.push(best.title);
          acceptedReasons.push('fallback-latest');
        }
      }

      for (const title of accepted) {
        seenTournamentTitles.add(title);
        tournamentTitles.push(title);
      }

      discoveries.push({
        family: 'tournament-results',
        prefix,
        discoveredCount: entries.length,
        discoveredTitles: entries,
        acceptedTitles: accepted,
        acceptedReasons,
        completedAtMs,
      });
      if (accepted.length > 0) {
        deps.log(
          `liq-spike: [tournament-results] accepted under "${prefix}": ` +
            accepted.map((title, i) => `"${title}" (reason=${acceptedReasons[i]})`).join(', '),
        );
      }
    }

    if (tournamentTitles.length === 0) {
      const reason = !hasBudget()
        ? 'budget'
        : `no matching titles discovered among ${tournamentDiscoveryAttempts} prefix(es) tried`;
      familyOutcomes.push({
        family: 'tournament-results',
        status: 'not-sampled',
        reason,
        sampledTitles: [],
      });
      deps.log(`liq-spike: [tournament-results] not-sampled: ${reason}`);
    } else if (hasBudget()) {
      const result = await deps.client.getWikitext(tournamentTitles);
      generalRequestCount += 1;
      const completedAtMs = deps.now();
      completionTimestampsMs.push(completedAtMs);
      recordNormalizations('tournament-results', result.normalized, normalizations, 'normalized');
      recordNormalizations('tournament-results', result.redirects, redirectsFollowed, 'redirected');
      for (const page of result.pages) {
        pushPage('tournament-results', page, completedAtMs);
      }
      familyOutcomes.push({
        family: 'tournament-results',
        status: 'sampled',
        sampledTitles: tournamentTitles,
      });
    } else {
      familyOutcomes.push({
        family: 'tournament-results',
        status: 'not-sampled',
        reason: 'budget',
        sampledTitles: [],
      });
      deps.log('liq-spike: [tournament-results] not-sampled: budget');
    }

    // ---- Stage 3: discover real other-entrant-brackets titles, seeded from
    // Stage 2's ACCEPTED event pages. Owner rerun #3, item 3: accept titles
    // containing "Bracket" (preferring ones that ALSO contain "Singles"),
    // falling back to the first subpage returned when nothing matches — a
    // per-event decision (unlike Stage 2's global fallback), since each
    // event page's own subpage listing is independent. ----
    const bracketTitles: string[] = [];
    const seenBracketTitles = new Set<string>();
    let bracketDiscoveryAttempts = 0;

    for (const eventTitle of tournamentTitles) {
      if (bracketDiscoveryAttempts >= LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS) {
        break;
      }
      if (!hasBudget() || bracketTitles.length >= maxTitlesPerDiscoveryFamily) {
        break;
      }
      const discovered = await deps.client.listSubpages(eventTitle, { maxContinuations: 0 });
      bracketDiscoveryAttempts += 1;
      generalRequestCount += 1;
      const completedAtMs = deps.now();
      completionTimestampsMs.push(completedAtMs);

      const entries: LiqSpikeDiscoveredPage[] = discovered.map((entry) => ({
        title: entry.title,
        pageId: entry.pageId,
      }));

      const accepted: string[] = [];
      const acceptedReasons: string[] = [];
      const bracketMatches = entries.filter(
        (entry) => containsBracketToken(entry.title) && !seenBracketTitles.has(entry.title),
      );
      const singlesBracketMatches = bracketMatches.filter((entry) =>
        containsSinglesToken(entry.title),
      );
      const preferred = singlesBracketMatches.length > 0 ? singlesBracketMatches : bracketMatches;
      const preferredReason =
        singlesBracketMatches.length > 0 ? 'bracket-token-singles' : 'bracket-token';
      for (const entry of preferred) {
        if (bracketTitles.length + accepted.length >= maxTitlesPerDiscoveryFamily) {
          break;
        }
        accepted.push(entry.title);
        acceptedReasons.push(preferredReason);
      }
      if (accepted.length === 0) {
        const first = entries.find((entry) => !seenBracketTitles.has(entry.title));
        if (first) {
          accepted.push(first.title);
          acceptedReasons.push('fallback-first-subpage');
        }
      }
      for (const title of accepted) {
        seenBracketTitles.add(title);
        bracketTitles.push(title);
      }

      discoveries.push({
        family: 'other-entrant-brackets',
        prefix: eventTitle,
        discoveredCount: entries.length,
        discoveredTitles: entries,
        acceptedTitles: accepted,
        acceptedReasons,
        completedAtMs,
      });
      deps.log(
        `liq-spike: [other-entrant-brackets] discovered ${discovered.length} subpage(s) under "${eventTitle}"` +
          (entries.length > 0 ? `: ${entries.map((entry) => entry.title).join(', ')}` : '') +
          (accepted.length > 0
            ? `; accepted: ${accepted.map((title, i) => `"${title}" (reason=${acceptedReasons[i]})`).join(', ')}`
            : ''),
      );
    }

    if (bracketTitles.length === 0) {
      const reason = !hasBudget()
        ? 'budget'
        : `no matching titles discovered among ${tournamentTitles.length} tournament event page(s) tried`;
      familyOutcomes.push({
        family: 'other-entrant-brackets',
        status: 'not-sampled',
        reason,
        sampledTitles: [],
      });
      deps.log(`liq-spike: [other-entrant-brackets] not-sampled: ${reason}`);
    } else if (hasBudget()) {
      const result = await deps.client.getWikitext(bracketTitles);
      generalRequestCount += 1;
      const completedAtMs = deps.now();
      completionTimestampsMs.push(completedAtMs);
      recordNormalizations(
        'other-entrant-brackets',
        result.normalized,
        normalizations,
        'normalized',
      );
      recordNormalizations(
        'other-entrant-brackets',
        result.redirects,
        redirectsFollowed,
        'redirected',
      );
      for (const page of result.pages) {
        pushPage('other-entrant-brackets', page, completedAtMs);
      }
      familyOutcomes.push({
        family: 'other-entrant-brackets',
        status: 'sampled',
        sampledTitles: bracketTitles,
      });
    } else {
      familyOutcomes.push({
        family: 'other-entrant-brackets',
        status: 'not-sampled',
        reason: 'budget',
        sampledTitles: [],
      });
      deps.log('liq-spike: [other-entrant-brackets] not-sampled: budget');
    }

    // ---- budget + FAIL LOUDLY on a real spacing violation ----
    const startCheck = checkGeneralRequestStartSpacing(deps.generalRequestStartTimestampsMs ?? []);
    if (!startCheck.compliant && startCheck.violation) {
      throw new Error(
        `liq-spike: general-class request start spacing violated the published ${LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS}ms interval ` +
          `(observed ${startCheck.violation.gapMs}ms between requests #${startCheck.violation.indexA} and #${startCheck.violation.indexB}) — ` +
          'this is a real Liquipedia terms-of-use violation and must never be silently recorded',
      );
    }

    const budget: LiqSpikeBudget = {
      generalRequests: generalRequestCount,
      parseClassRequests: 0,
      minObservedGeneralCompletionSpacingMs: computeMinSpacingMs(completionTimestampsMs),
      minObservedGeneralStartSpacingMs: startCheck.minObservedStartSpacingMs,
      minObservedParseClassSpacingMs: null,
      maxGeneralRequests,
      budgetExhausted,
    };

    deps.log(
      `liq-spike: budget general=${budget.generalRequests}/${budget.maxGeneralRequests} parse-class=${budget.parseClassRequests} ` +
        `minObservedGeneralStartSpacingMs=${budget.minObservedGeneralStartSpacingMs ?? 'n/a'} ` +
        `minObservedGeneralCompletionSpacingMs=${budget.minObservedGeneralCompletionSpacingMs ?? 'n/a'}`,
    );

    return { pages, discoveries, normalizations, redirectsFollowed, familyOutcomes, budget };
  } catch (error) {
    // Fix 4: build the best partial report possible from whatever these
    // outer-scoped accumulators hold at the moment of failure. The spacing
    // check above (if that's what threw) already ran, so
    // `minObservedGeneralStartSpacingMs` is still accurate here; anything
    // that failed earlier simply leaves it `null`, which is honest — no
    // compliance claim is made about a run that never got far enough to
    // measure it.
    const startCheck = checkGeneralRequestStartSpacing(deps.generalRequestStartTimestampsMs ?? []);
    const partialReport: LiqSpikeReport = {
      pages,
      discoveries,
      normalizations,
      redirectsFollowed,
      familyOutcomes,
      budget: {
        generalRequests: generalRequestCount,
        parseClassRequests: 0,
        minObservedGeneralCompletionSpacingMs: computeMinSpacingMs(completionTimestampsMs),
        minObservedGeneralStartSpacingMs: startCheck.minObservedStartSpacingMs,
        minObservedParseClassSpacingMs: null,
        maxGeneralRequests,
        budgetExhausted,
      },
    };
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`liq-spike: run failed after ${pages.length} page(s) fetched — ${message}`);
    throw new LiqSpikePartialRunError(message, partialReport);
  }
}
