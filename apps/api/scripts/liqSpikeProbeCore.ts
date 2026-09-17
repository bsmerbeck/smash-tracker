import type { LiquipediaClient } from '../src/liquipedia/client.js';

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
 */

export type LiqSpikeFamily = 'player-results' | 'tournament-results' | 'other-entrant-brackets';

export interface LiqSpikeTarget {
  family: LiqSpikeFamily;
  /** Real page titles fetched via `action=query`+`prop=revisions` (wikitext). At most four per family — a bounded probe, not a crawl. */
  titles: string[];
  /** Why this family matters to LIQ-01. */
  why: string;
  /**
   * Optional `list=allpages` discovery prefix — also `action=query`, never
   * parse-class. Exercises `client.listSubpages` for a family whose
   * child-page structure (an event's own bracket subpages) is itself part
   * of what the spike observes.
   */
  discoverPrefix?: string;
}

/**
 * The three page families D-22 names, with real page titles. Deliberately
 * few per family (a bounded probe, not a crawl): player results/placements
 * pages, tournament results pages, and bracket pages for entrants outside
 * the four demo accounts the shipped VOD/bracket sync already reaches.
 */
export const LIQ_SPIKE_TARGETS: readonly LiqSpikeTarget[] = Object.freeze([
  {
    family: 'player-results',
    titles: ['Sparg0/Results', 'MkLeo/Results', 'Hungrybox/Results', 'IzAw/Results'],
    why: "A player's aggregated results/placements page — the shape a cross-player opponent-evidence surface (LIQ-04, Phase 42) would need to read, distinct from the already-shipped `*/VODs` family.",
  },
  {
    family: 'tournament-results',
    titles: [
      'Genesis 9/Ultimate',
      'Smash Summit 13/Ultimate',
      'Battle of BC 7/Ultimate',
      'CEO 2025/Ultimate',
    ],
    why: 'A tournament event page carrying its own results/placement table, independent of any one tracked player.',
    discoverPrefix: 'Genesis 9/Ultimate',
  },
  {
    family: 'other-entrant-brackets',
    titles: [
      'Genesis 9/Ultimate/Singles Bracket',
      'Smash Summit 13/Ultimate/Singles Bracket',
      'Battle of BC 7/Ultimate/Singles Bracket',
    ],
    why: 'A bracket page for entrants outside the four tracked demo accounts — the same page shape the shipped VOD/bracket sync already reaches for `*/VODs`-linked tournaments, checked here for reachability beyond that set.',
  },
]);

/**
 * A revision whose wikitext is below this byte threshold AND consists of
 * nothing but template transclusions is classified `stub-generator-only` —
 * the exact shape already proven for the shipped VODs-page family
 * (`{{ResultsPageHeader}}\n{{Player vod list}}`, well under 100 bytes). Set
 * comfortably above that known stub size and comfortably below the smallest
 * substantive wikitext already in the corpus (over 19 KB), so the mechanical
 * rule cannot straddle a real page by accident.
 */
export const LIQ_SPIKE_STUB_BYTE_THRESHOLD_BYTES = 200;

export type LiqSpikeWikitextVerdict = 'sufficient' | 'stub-generator-only' | 'missing';

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
  completedAtMs: number;
}

export interface LiqSpikeDiscoveryResult {
  family: LiqSpikeFamily;
  prefix: string;
  discoveredCount: number;
  completedAtMs: number;
}

export interface LiqSpikeBudget {
  generalRequests: number;
  /** Always 0 — this probe issues `action=query` only. */
  parseClassRequests: number;
  /** `null` when fewer than two general-class requests were observed (no spacing to measure). */
  minObservedGeneralSpacingMs: number | null;
  /** Always `null` — no parse-class request is ever issued by this probe. */
  minObservedParseClassSpacingMs: number | null;
}

export interface LiqSpikeReport {
  pages: LiqSpikePageResult[];
  discoveries: LiqSpikeDiscoveryResult[];
  budget: LiqSpikeBudget;
}

export interface LiqSpikeDeps {
  client: LiquipediaClient;
  now: () => number;
  log: (line: string) => void;
}

/** True when every non-blank line of `wikitext` is a single `{{...}}` template transclusion — the shape of a generator-only page. */
function isTemplateOnlyWikitext(wikitext: string): boolean {
  const lines = wikitext
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => /^\{\{[^{}]*\}\}$/.test(line));
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Anchored on both ends, mirroring the shipped VODs-page allowlist pattern's own convention — never a substring match. */
function proposeAllowlistRegexFor(title: string): string {
  const lastSegment = title.includes('/') ? title.slice(title.lastIndexOf('/') + 1) : title;
  return `^[^/]+/${escapeRegExpLiteral(lastSegment)}$`;
}

function classifyWikitext(content: string, byteSize: number): LiqSpikeWikitextVerdict {
  if (byteSize < LIQ_SPIKE_STUB_BYTE_THRESHOLD_BYTES && isTemplateOnlyWikitext(content)) {
    return 'stub-generator-only';
  }
  return 'sufficient';
}

function computeMinSpacingMs(timestampsMs: number[]): number | null {
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

/**
 * Runs the bounded LIQ-01 spike: `action=query` only, through the
 * caller-supplied client. Never throws on a missing title — records it as
 * `missing` instead, so a family with no reachable page still produces
 * evidence rather than aborting the run.
 */
export async function runLiqSpike(
  deps: LiqSpikeDeps,
  targets: readonly LiqSpikeTarget[] = LIQ_SPIKE_TARGETS,
): Promise<LiqSpikeReport> {
  const pages: LiqSpikePageResult[] = [];
  const discoveries: LiqSpikeDiscoveryResult[] = [];
  const generalRequestTimestampsMs: number[] = [];

  for (const target of targets) {
    if (target.discoverPrefix) {
      const discovered = await deps.client.listSubpages(target.discoverPrefix);
      const completedAtMs = deps.now();
      generalRequestTimestampsMs.push(completedAtMs);
      discoveries.push({
        family: target.family,
        prefix: target.discoverPrefix,
        discoveredCount: discovered.length,
        completedAtMs,
      });
      deps.log(
        `liq-spike: [${target.family}] discovered ${discovered.length} subpage(s) under "${target.discoverPrefix}"`,
      );
    }

    const result = await deps.client.getWikitext(target.titles);
    const completedAtMs = deps.now();
    generalRequestTimestampsMs.push(completedAtMs);

    for (const page of result.pages) {
      if (!page.present) {
        pages.push({
          family: target.family,
          title: page.title,
          revisionId: undefined,
          byteSize: 0,
          wikitextVerdict: 'missing',
          completedAtMs,
        });
        deps.log(`liq-spike: [${target.family}] "${page.title}" -> missing`);
        continue;
      }

      const content = page.content ?? '';
      const byteSize = page.size ?? Buffer.byteLength(content, 'utf8');
      const wikitextVerdict = classifyWikitext(content, byteSize);
      pages.push({
        family: target.family,
        title: page.title,
        revisionId: page.revisionId,
        byteSize,
        wikitextVerdict,
        ...(wikitextVerdict === 'stub-generator-only'
          ? { proposedAllowlistRegex: proposeAllowlistRegexFor(page.title) }
          : {}),
        completedAtMs,
      });
      deps.log(
        `liq-spike: [${target.family}] "${page.title}" -> ${wikitextVerdict} (revid=${page.revisionId ?? 'n/a'}, bytes=${byteSize})`,
      );
    }
  }

  const budget: LiqSpikeBudget = {
    generalRequests: generalRequestTimestampsMs.length,
    parseClassRequests: 0,
    minObservedGeneralSpacingMs: computeMinSpacingMs(generalRequestTimestampsMs),
    minObservedParseClassSpacingMs: null,
  };

  deps.log(
    `liq-spike: budget general=${budget.generalRequests} parse-class=${budget.parseClassRequests} ` +
      `minObservedGeneralSpacingMs=${budget.minObservedGeneralSpacingMs ?? 'n/a'}`,
  );

  return { pages, discoveries, budget };
}
