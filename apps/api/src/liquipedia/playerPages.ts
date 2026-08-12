import {
  buildLiquipediaPageUrl,
  type LiquipediaClient,
  type LiquipediaRevisionQueryResult,
} from './client.js';

/**
 * Phase 30.2 Plan 06 (ENR-03): player VOD-subpage TITLE resolution —
 * canonicalising a demo-account label BEFORE any `/VODs` subpage title is
 * ever constructed, deduplicating identical resolved titles before any
 * parse-class budget is spent, and treating a genuinely absent page as a
 * first-class, reasoned result rather than a thrown error or a silent
 * fallback to a different source.
 *
 * This module NEVER fetches a VOD page's generated content — it only
 * resolves TITLES via cheap `action=query` head-revision probes
 * (`LiquipediaClient.headRevisions`, never `getGeneratedVodPage`). The
 * caller that eventually spends a parse-class request does so against the
 * DEDUPED `resolved[].vodPageTitle` list this module returns, which is what
 * makes "two real, byte-identical `/VODs` pages cost one parse budget, not
 * two" (RESEARCH section 5.3) a property of THIS module rather than of the
 * caller's own diligence.
 *
 * Two-step resolution order, and why the order is load-bearing:
 *
 * 1. Batch-probe the bare PLAYER labels, redirects enabled — `MkLeo`
 *    redirects to `MKLeo` at the PLAYER-page level. Canonicalising here
 *    catches it.
 * 2. Construct `/VODs` subpage titles from the CANONICAL player titles,
 *    dedupe, THEN batch-probe the unique set.
 *
 * Reversing this order (canonicalising the `/VODs` title directly) would
 * NOT catch the trap: neither `MkLeo/VODs` nor `MKLeo/VODs` is itself a
 * redirect (RESEARCH section 5.3 — "I parsed both. Identical content —
 * harmless data-wise, expensive process-wise") — they are two REAL,
 * independently existing pages. Only canonicalising the PLAYER title, one
 * level up, collapses them.
 */

/** The single, constant subpage suffix every VOD page title is built from — never an inline literal at any call site. */
export const LIQUIPEDIA_VOD_SUBPAGE_SUFFIX = '/VODs';

/** ENR-03's four-player coverage is structurally three pages plus one honest zero (RESEARCH section 5.2) — this is that zero's stated reason. It must NEVER be satisfied by substituting bracket-page VODs and calling the result VOD-page ingestion; bracket-page enrichment for that player remains a separate, legitimate path handled by the bracket adapters. */
export const LIQUIPEDIA_VOD_PAGE_MISSING_REASON =
  'sourcePageMissing: no Liquipedia VOD subpage exists for this player (an honest zero, not a fetch failure — never satisfied by substituting a bracket-page VOD)';

/** T-30.2-29: a label that would widen the constructed title beyond a single VOD subpage is refused before any request is made. */
export const LIQUIPEDIA_INVALID_LABEL_REASON =
  'label rejected before any request: a path separator or a leading namespace separator would ' +
  'construct a title outside the intended single VOD subpage';

function isValidPlayerLabel(label: string): boolean {
  return label.length > 0 && !label.includes('/') && !label.startsWith(':');
}

/** Builds `<canonicalPlayerTitle>/VODs`. Throws — BEFORE any request could ever be built from the result — for a title that would carry an extra path or namespace separator (T-30.2-29). */
export function buildVodPageTitle(canonicalPlayerTitle: string): string {
  if (!isValidPlayerLabel(canonicalPlayerTitle)) {
    throw new Error(
      `Liquipedia VOD page title refused for "${canonicalPlayerTitle}": ${LIQUIPEDIA_INVALID_LABEL_REASON}`,
    );
  }
  return `${canonicalPlayerTitle}${LIQUIPEDIA_VOD_SUBPAGE_SUFFIX}`;
}

export interface ResolvedPlayerVodPage {
  label: string;
  canonicalPlayerTitle: string;
  vodPageTitle: string;
  vodPageUrl: string;
  /** Present for provenance (ENR-04) even though this page class's revision id is NOT usable as a freshness key (RESEARCH section 8.6) — see `vodList.ts`'s content-hash freshness key instead. */
  revisionId: number | null;
  present: boolean;
  reason: string | null;
}

export interface DedupedPlayerVodPage {
  label: string;
  /** The label whose resolved `vodPageTitle` this one merged into — always a label that appears earlier in the input order. */
  mergedInto: string;
}

export interface ResolvePlayerVodPagesResult {
  resolved: ResolvedPlayerVodPage[];
  deduped: DedupedPlayerVodPage[];
}

const EMPTY_QUERY_RESULT: LiquipediaRevisionQueryResult = {
  pages: [],
  normalized: [],
  redirects: [],
};

/** Builds an `original title -> resolved title` map from a query result's `normalized` and `redirects` arrays, chaining a normalization through a subsequent redirect for the SAME original title. Both arrays appear only when they apply (RESEARCH section 8.1) — an original title absent from either array resolves to itself. */
function buildTitleResolutionMap(result: LiquipediaRevisionQueryResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of result.normalized) {
    map.set(entry.from, entry.to);
  }
  for (const entry of result.redirects) {
    const priorNormalizedForm = map.get(entry.from);
    map.set(entry.from, entry.to);
    if (priorNormalizedForm && priorNormalizedForm !== entry.from) {
      map.set(priorNormalizedForm, entry.to);
    }
  }
  return map;
}

function resolveTitle(original: string, titleMap: Map<string, string>): string {
  return titleMap.get(original) ?? original;
}

/**
 * Resolves the VOD-subpage title for every requested player label, in the
 * two-step order this module's header documents. A label rejected by
 * `buildVodPageTitle`'s guard is returned as a first-class, non-present
 * entry WITHOUT being included in either batch request — an invalid label
 * never costs the batch anything.
 */
export async function resolvePlayerVodPages(
  client: LiquipediaClient,
  labels: string[],
): Promise<ResolvePlayerVodPagesResult> {
  const validLabels: string[] = [];
  const invalidResolved: ResolvedPlayerVodPage[] = [];
  for (const label of labels) {
    if (isValidPlayerLabel(label)) {
      validLabels.push(label);
    } else {
      invalidResolved.push({
        label,
        canonicalPlayerTitle: label,
        vodPageTitle: '',
        vodPageUrl: '',
        revisionId: null,
        present: false,
        reason: LIQUIPEDIA_INVALID_LABEL_REASON,
      });
    }
  }

  // Step 1: canonicalise the bare player labels.
  const playerProbe =
    validLabels.length > 0 ? await client.headRevisions(validLabels) : EMPTY_QUERY_RESULT;
  const playerTitleMap = buildTitleResolutionMap(playerProbe);

  const canonicalByLabel = new Map<string, string>();
  for (const label of validLabels) {
    canonicalByLabel.set(label, resolveTitle(label, playerTitleMap));
  }

  // Step 2: construct + DEDUPE the VOD subpage titles from the canonical
  // player titles, THEN batch-probe the unique set in one request.
  const labelsByVodTitle = new Map<string, string[]>();
  for (const label of validLabels) {
    const canonicalPlayerTitle = canonicalByLabel.get(label)!;
    const vodPageTitle = buildVodPageTitle(canonicalPlayerTitle);
    const existing = labelsByVodTitle.get(vodPageTitle);
    if (existing) {
      existing.push(label);
    } else {
      labelsByVodTitle.set(vodPageTitle, [label]);
    }
  }

  const uniqueVodTitles = [...labelsByVodTitle.keys()];
  const vodProbe =
    uniqueVodTitles.length > 0 ? await client.headRevisions(uniqueVodTitles) : EMPTY_QUERY_RESULT;
  const vodTitleMap = buildTitleResolutionMap(vodProbe);
  const pageByTitle = new Map(vodProbe.pages.map((page) => [page.title, page]));

  const resolved: ResolvedPlayerVodPage[] = [...invalidResolved];
  const deduped: DedupedPlayerVodPage[] = [];

  for (const [vodPageTitle, labelsForTitle] of labelsByVodTitle) {
    const resolvedVodTitle = resolveTitle(vodPageTitle, vodTitleMap);
    const page = pageByTitle.get(resolvedVodTitle) ?? pageByTitle.get(vodPageTitle);
    const present = page?.present === true;
    const revisionId = present && page?.present ? (page.revisionId ?? null) : null;
    const reason = present ? null : LIQUIPEDIA_VOD_PAGE_MISSING_REASON;

    labelsForTitle.forEach((label, index) => {
      resolved.push({
        label,
        canonicalPlayerTitle: canonicalByLabel.get(label)!,
        vodPageTitle: resolvedVodTitle,
        vodPageUrl: buildLiquipediaPageUrl(resolvedVodTitle),
        revisionId,
        present,
        reason,
      });
      if (index > 0) {
        deduped.push({ label, mergedInto: labelsForTitle[0]! });
      }
    });
  }

  return { resolved, deduped };
}
