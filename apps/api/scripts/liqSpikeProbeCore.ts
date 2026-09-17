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

const TOURNAMENT_EVENT_PAGE_SUFFIX = '/Ultimate';
const SINGLES_BRACKET_PAGE_SUFFIX = '/Ultimate/Singles Bracket';

/** A mechanical shape filter over `list=allpages` results — never a guess: keeps only titles ending in the tournament-event suffix, excluding a bracket subpage (which also ends in the outer suffix). */
export function isTournamentEventPageTitle(title: string): boolean {
  return (
    title.endsWith(TOURNAMENT_EVENT_PAGE_SUFFIX) && !title.endsWith(SINGLES_BRACKET_PAGE_SUFFIX)
  );
}

/** A mechanical shape filter keeping only titles shaped like a singles-bracket subpage of a discovered tournament event page. */
export function isSinglesBracketPageTitle(title: string): boolean {
  return title.endsWith(SINGLES_BRACKET_PAGE_SUFFIX);
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
export interface LiqSpikeWikitextFingerprint {
  templateOpenCount: number;
  internalLinkOpenCount: number;
  pipeCount: number;
  lineCount: number;
  startsWithRedirect: boolean;
  firstTemplateName: string | null;
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
  /** Present only for a page under `LIQ_SPIKE_FINGERPRINT_MAX_BYTES` — see `LiqSpikeWikitextFingerprint`. */
  fingerprint?: LiqSpikeWikitextFingerprint;
  /**
   * The full, byte-faithful wikitext this probe fetched, for every PRESENT
   * page regardless of size. Persisted ONLY into the gitignored `--out`
   * report file (`liqSpikeProbe.ts` never prints this field) — the
   * fingerprint above is what reaches the console.
   */
  rawWikitext?: string;
  completedAtMs: number;
}

export interface LiqSpikeDiscoveryResult {
  family: LiqSpikeFamily;
  /** The `list=allpages` prefix tried — a series name or a discovered tournament event page, never a guessed full title. */
  prefix: string;
  discoveredCount: number;
  /** Discovered titles this family's shape filter actually accepted (bounded by the per-family title cap). */
  acceptedTitles: string[];
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
function computeWikitextFingerprint(content: string): LiqSpikeWikitextFingerprint {
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
        completedAtMs,
      });
      deps.log(`liq-spike: [${family}] "${page.title}" -> missing`);
      return { verdict: 'missing', content: '' };
    }

    const content = page.content ?? '';
    const byteSize = page.size ?? Buffer.byteLength(content, 'utf8');
    const wikitextVerdict = classifyWikitext(content);
    const fingerprint =
      byteSize < LIQ_SPIKE_FINGERPRINT_MAX_BYTES ? computeWikitextFingerprint(content) : undefined;
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
      completedAtMs,
    });
    deps.log(
      `liq-spike: [${family}] "${page.title}" -> ${wikitextVerdict} (revid=${page.revisionId ?? 'n/a'}, bytes=${byteSize})`,
    );
    return { verdict: wikitextVerdict, content };
  };

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
  // links — see this file's module doc comment) ----
  const tournamentTitles: string[] = [];
  const seenTournamentTitles = new Set<string>();
  let tournamentDiscoveryAttempts = 0;

  for (const prefix of seedPrefixes) {
    if (tournamentDiscoveryAttempts >= LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS) {
      break;
    }
    if (!hasBudget() || tournamentTitles.length >= maxTitlesPerDiscoveryFamily) {
      break;
    }
    const discovered = await deps.client.listSubpages(prefix, { maxContinuations: 0 });
    tournamentDiscoveryAttempts += 1;
    generalRequestCount += 1;
    const completedAtMs = deps.now();
    completionTimestampsMs.push(completedAtMs);

    const accepted: string[] = [];
    for (const entry of discovered) {
      if (
        isTournamentEventPageTitle(entry.title) &&
        !seenTournamentTitles.has(entry.title) &&
        tournamentTitles.length + accepted.length < maxTitlesPerDiscoveryFamily
      ) {
        accepted.push(entry.title);
      }
    }
    for (const title of accepted) {
      seenTournamentTitles.add(title);
      tournamentTitles.push(title);
    }

    discoveries.push({
      family: 'tournament-results',
      prefix,
      discoveredCount: discovered.length,
      acceptedTitles: accepted,
      completedAtMs,
    });
    deps.log(
      `liq-spike: [tournament-results] discovered ${discovered.length} subpage(s) under "${prefix}"` +
        (accepted.length > 0 ? `, accepted: ${accepted.join(', ')}` : ''),
    );
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

  // ---- Stage 3: discover real other-entrant-brackets titles, seeded from Stage 2's discovered event pages ----
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

    const accepted: string[] = [];
    for (const entry of discovered) {
      if (
        isSinglesBracketPageTitle(entry.title) &&
        !seenBracketTitles.has(entry.title) &&
        bracketTitles.length + accepted.length < maxTitlesPerDiscoveryFamily
      ) {
        accepted.push(entry.title);
      }
    }
    for (const title of accepted) {
      seenBracketTitles.add(title);
      bracketTitles.push(title);
    }

    discoveries.push({
      family: 'other-entrant-brackets',
      prefix: eventTitle,
      discoveredCount: discovered.length,
      acceptedTitles: accepted,
      completedAtMs,
    });
    deps.log(
      `liq-spike: [other-entrant-brackets] discovered ${discovered.length} subpage(s) under "${eventTitle}"` +
        (accepted.length > 0 ? `, accepted: ${accepted.join(', ')}` : ''),
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
    recordNormalizations('other-entrant-brackets', result.normalized, normalizations, 'normalized');
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
}
