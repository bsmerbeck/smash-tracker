import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import { isPathSafeProviderId } from '@smash-tracker/shared';

/**
 * Phase 30.2 Plan 03 (ENR-01, ENR-10): the durable freshness-metadata cache
 * that makes "an unchanged page is never refetched" a structural property
 * rather than a hope.
 *
 * Storage layout: `liquipediaPageCache/{pageId}` — one flat node whose keys
 * are supplied by the caller. NOTE (30.2 production defect A): although a
 * Liquipedia page's freshness LOOKS like a property of the shared wiki, the
 * enrichment run's skip decision built on it carries an implicit
 * "this page's observations are already persisted" contract, and observation
 * persistence is PER-TENANT — so `run.ts` now salts every `pageId` it passes
 * here with the tenant id (`cacheKeyFor`). An earlier tenant-less key let one
 * account's run mark shared event pages fresh and a later account's run
 * silently skip persisting its own observations from them. This module
 * itself stays key-agnostic; the tenant scoping is the caller's contract.
 * (Genuinely global wiki-level state — the limiter's budget nodes in
 * `limiter.ts` — remains global by design.)
 *
 * This module stores freshness METADATA, never response bytes: RTDB is not
 * a blob store, and the largest legitimate Liquipedia response observed
 * during research was 1.4 MB (`30.2-RESEARCH.md` §15). The durable
 * no-refetch guarantee is carried by the freshness key here plus the
 * normalized observations a later plan persists into
 * `researchEnrichmentObservations`; raw response bytes are cached only on
 * local disk for the duration of an operator run, never in RTDB.
 *
 * The stored shape is declared LOCALLY (`liquipediaPageCacheRecordSchema`)
 * rather than in `packages/shared`, unlike most other stored RTDB shapes in
 * this codebase: this cache is server-only operational state with no web
 * consumer, and `packages/shared` is imported by the browser bundle — there
 * is no reason for this record's fields to ship in that bundle.
 *
 * THE ENR-10 HAZARD (`30.2-RESEARCH.md` §8.6): a Liquipedia player VOD
 * page's `revid` does NOT change when its content changes — the wikitext is
 * a frozen two-template stub (`{{ResultsPageHeader}}\n{{Player vod list}}`)
 * whose revision predates its current generated content by years, because
 * the actual rows are rendered live from LiquipediaDB on every request. A
 * refresh keyed only on `revid` for this page class would conclude
 * "unchanged" FOREVER and never ingest a new VOD. `isLiquipediaPageFresh`
 * therefore branches on `pageClass`:
 *
 * - `'wikitext'` pages (e.g. bracket pages): freshness requires equal
 *   revision id AND equal sha1 AND equal parser version — cheap and
 *   correct, because the wikitext IS the content.
 * - `'generated'` pages (e.g. player `VODs` subpages, parse-class): freshness
 *   requires equal CONTENT HASH AND equal parser version; the revision id
 *   is EXPLICITLY IGNORED, because it carries no signal for this page
 *   class.
 */

export const LIQUIPEDIA_PAGE_CACHE_PATH = 'liquipediaPageCache';

export type LiquipediaPageClass = 'wikitext' | 'generated';

/**
 * Every optional member uses `.nullish()` (house constraint 1) — never
 * `.optional()`/`.nullable()` alone — because this is a STORED shape and
 * RTDB strips absent keys on write; every writer below conditional-spreads
 * rather than writing an explicit `null`.
 */
export const liquipediaPageCacheRecordSchema = z.object({
  pageId: z.string().min(1),
  title: z.string().min(1),
  pageClass: z.enum(['wikitext', 'generated']),
  parserVersion: z.string().min(1),
  fetchedAtMs: z.number(),
  revisionId: z.number().nullish(),
  sha1: z.string().nullish(),
  contentHash: z.string().nullish(),
  byteSize: z.number().nullish(),
  observationCount: z.number().nullish(),
  lastFreshCheckAtMs: z.number().nullish(),
});

export type LiquipediaPageCacheRecord = z.infer<typeof liquipediaPageCacheRecordSchema>;

/** Input to `writeLiquipediaPageCache` — identical shape to the stored record; optional members are plain `undefined` when absent, never `null` (conditional-spread on write, below). */
export type LiquipediaPageCacheWriteInput = LiquipediaPageCacheRecord;

function pageCacheRef(database: Database, pageId: string) {
  return database.ref(`${LIQUIPEDIA_PAGE_CACHE_PATH}/${pageId}`);
}

/**
 * Reads one page's cache entry. Guards the page-id path segment with
 * `isPathSafeProviderId` BEFORE constructing any reference (review C2-A6
 * precedent from `apps/api/src/research/ingestion/supplements.ts`) — an
 * unsafe id returns the absent result (`null`) directly, never throws.
 *
 * A page id that was never written also returns `null` — a first-class
 * absent result, never a throw — and a stored value that fails to parse
 * (e.g. written before a bound was tightened) safe-parses to the same
 * absent result rather than crashing the caller.
 */
export async function readLiquipediaPageCache(
  database: Database,
  pageId: string,
): Promise<LiquipediaPageCacheRecord | null> {
  if (!isPathSafeProviderId(pageId)) {
    return null;
  }

  const snapshot = await pageCacheRef(database, pageId).get();
  if (!snapshot.exists()) {
    return null;
  }

  const parsed = liquipediaPageCacheRecordSchema.safeParse(snapshot.val());
  return parsed.success ? parsed.data : null;
}

/**
 * Writes one page's cache entry. Guards the page-id path segment with
 * `isPathSafeProviderId` BEFORE constructing any reference, performing no
 * write (rather than throwing) on an unsafe id. Conditional-spreads every
 * optional member and parses through the schema BEFORE `set()`, so an
 * invalid shape fails at this boundary rather than reaching RTDB.
 */
export async function writeLiquipediaPageCache(
  database: Database,
  input: LiquipediaPageCacheWriteInput,
): Promise<void> {
  if (!isPathSafeProviderId(input.pageId)) {
    return;
  }

  const record = liquipediaPageCacheRecordSchema.parse({
    pageId: input.pageId,
    title: input.title,
    pageClass: input.pageClass,
    parserVersion: input.parserVersion,
    fetchedAtMs: input.fetchedAtMs,
    ...(input.revisionId != null ? { revisionId: input.revisionId } : {}),
    ...(input.sha1 != null ? { sha1: input.sha1 } : {}),
    ...(input.contentHash != null ? { contentHash: input.contentHash } : {}),
    ...(input.byteSize != null ? { byteSize: input.byteSize } : {}),
    ...(input.observationCount != null ? { observationCount: input.observationCount } : {}),
    ...(input.lastFreshCheckAtMs != null ? { lastFreshCheckAtMs: input.lastFreshCheckAtMs } : {}),
  } satisfies LiquipediaPageCacheRecord);

  await pageCacheRef(database, input.pageId).set(record);
}

export interface LiquipediaWikitextFreshnessProbe {
  pageClass: 'wikitext';
  revisionId?: number;
  sha1?: string;
}

export interface LiquipediaGeneratedFreshnessProbe {
  pageClass: 'generated';
  /** Deliberately accepted but NEVER consulted for freshness — see the module header's ENR-10 hazard explanation. Kept on the probe shape so a caller can pass through whatever `headRevisions` returned without having to strip it. */
  revisionId?: number;
  contentHash?: string;
}

export type LiquipediaFreshnessProbe =
  LiquipediaWikitextFreshnessProbe | LiquipediaGeneratedFreshnessProbe;

function bothDefinedAndEqual<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  return a != null && b != null && a === b;
}

/**
 * PURE predicate: no I/O, no clock, no randomness. Returns `false` for any
 * absent (`null`) cache entry, a `pageClass` mismatch between the cached
 * record and the probe, or a `parserVersion` mismatch — a parser-version
 * bump invalidates every cached page for that class regardless of how
 * "fresh" the underlying wiki content looks, because our OWN extraction
 * logic is what changed.
 */
export function isLiquipediaPageFresh(
  cached: LiquipediaPageCacheRecord | null,
  probe: LiquipediaFreshnessProbe,
  parserVersion: string,
): boolean {
  if (cached === null) {
    return false;
  }
  if (cached.pageClass !== probe.pageClass) {
    return false;
  }
  if (cached.parserVersion !== parserVersion) {
    return false;
  }

  if (probe.pageClass === 'wikitext') {
    return (
      bothDefinedAndEqual(cached.revisionId, probe.revisionId) &&
      bothDefinedAndEqual(cached.sha1, probe.sha1)
    );
  }

  // 'generated': content hash is the ONLY freshness signal — revisionId is
  // explicitly ignored (see module header).
  return bothDefinedAndEqual(cached.contentHash, probe.contentHash);
}
