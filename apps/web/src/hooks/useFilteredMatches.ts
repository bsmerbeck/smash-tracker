import { useMemo } from 'react';
import {
  resolveAliasChain,
  type Match,
  type OpponentAliasMap,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { useMatches } from '@/hooks/useMatches';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import type { AnalyticsRangeFilter, AnalyticsSourceFilter } from '@/context/AnalyticsFilterContext';
import { entryDisplayDateRange } from '@/lib/historicalTournament';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Approximate month length (30 days), matching the coarse "3m/6m/12m" granularity of the filter UI. */
const RANGE_DAYS: Record<Exclude<AnalyticsRangeFilter, 'all'>, number> = {
  '3m': 30 * 3,
  '6m': 30 * 6,
  '12m': 30 * 12,
};

/**
 * Filters matches by origin: manually-entered vs imported from a
 * tournament site. Moved from the removed SourceFilterTabs.
 *
 * The filter's `'startgg'` value predates parry.gg (V8-A) and means
 * "Competitive" in the UI (see AnalyticsFilterControls) — rather than add a
 * third persisted filter value (and migrate every existing localStorage
 * value + every call site that passes the literal `'startgg'` string), the
 * existing "Competitive" bucket is broadened to match EITHER tournament-site
 * source. This is the intentional minimal extension for V8-A: one bucket
 * for "any verified competitive import", not a per-site bucket.
 */
export function filterBySource(matches: Match[], filter: AnalyticsSourceFilter): Match[] {
  if (filter === 'all') {
    return matches;
  }
  if (filter === 'startgg') {
    return matches.filter((m) => m.source === 'startgg' || m.source === 'parrygg');
  }
  return matches.filter((m) => m.source == null);
}

/**
 * The trailing-window cutoff (epoch ms) for `filter`, or `null` for `'all'`
 * (no cut). This is the SINGLE place the trailing-window arithmetic lives —
 * both `filterByRange` (matches) and `filterEntriesByRange` (tournament
 * registry rows) go through this, so match rows and registry rows can never
 * disagree about where the window starts (quick 260902-bm9, D-01).
 */
export function rangeCutoff(filter: AnalyticsRangeFilter, now = Date.now()): number | null {
  if (filter === 'all') {
    return null;
  }
  return now - RANGE_DAYS[filter] * DAY_MS;
}

/**
 * Filters matches to those within the given trailing time range, relative to
 * `now`. `'all'` performs no cut. The cutoff is inclusive (`match.time >=
 * now - range`). The cutoff itself comes from `rangeCutoff`, so match rows
 * and registry rows can never disagree about where the window starts.
 */
export function filterByRange(
  matches: Match[],
  filter: AnalyticsRangeFilter,
  now = Date.now(),
): Match[] {
  const cutoff = rangeCutoff(filter, now);
  if (cutoff === null) {
    return matches;
  }
  return matches.filter((m) => m.time >= cutoff);
}

/**
 * Filters tournament registry rows to those whose DISPLAY date range (see
 * `entryDisplayDateRange`) ends on or after the same trailing-window cutoff
 * `filterByRange` uses for matches — `'all'` performs no cut. Two
 * consequences are deliberate, quick 260902-bm9 (D-01):
 *  - keying on the display range's END, not its start, is what keeps a
 *    multi-day event that began before the window, and an upcoming event
 *    that hasn't happened yet, both visible;
 *  - an entry the app cannot date (`entryDisplayDateRange` returns `null`)
 *    is never hidden — it already renders the missing-data marker in its
 *    Dates cell, and dropping the row because its dates are absent would
 *    hide real data behind missing metadata.
 * This is the TIME axis only: the source filter (All/Casual/Competitive) is
 * deliberately NOT applied to registry rows, since tournament entries are
 * inherently competitive (D-02).
 */
export function filterEntriesByRange(
  entries: TournamentEntry[],
  filter: AnalyticsRangeFilter,
  now = Date.now(),
): TournamentEntry[] {
  const cutoff = rangeCutoff(filter, now);
  if (cutoff === null) {
    return entries;
  }
  return entries.filter((entry) => {
    const range = entryDisplayDateRange(entry);
    return range === null || range.endMs >= cutoff;
  });
}

/**
 * Rewrites `match.opponent` to its canonical name per `aliasMap` (alias ->
 * canonical), following the FULL alias chain to its terminal name
 * (CR-01/WR-04) via the shared `resolveAliasChain` primitive — never a raw
 * single-hop lookup. Applied to the RAW, un-normalized `match.opponent`
 * (unlike the engine's `canonicalOpponentName`, which normalizes first) so
 * a match with no alias entry at all is returned byte-for-byte unchanged —
 * same object reference, no unnecessary re-renders downstream, and no
 * casing/content change purely from this pass. This is the SINGLE CHOKE
 * POINT for opponent identity merging: every consumer that reads
 * `match.opponent` should go through `useFilteredMatches` (which applies
 * this) rather than raw `useMatches`, so scouting/tables/dashboards all see
 * merged identities automatically without each needing alias-awareness of
 * their own.
 *
 * Calling the SAME `resolveAliasChain` primitive
 * `packages/shared/src/evidence/opponentEvidence.ts` and the API's
 * report/prep call sites use (via `canonicalOpponentName`/
 * `makeCanonicalizer`) is what makes this and the engine's own hop agree on
 * which terminal name a chain resolves to — see `resolveAliasChain`'s doc
 * comment for the ownership split.
 */
export function applyOpponentAliases(matches: Match[], aliasMap: OpponentAliasMap): Match[] {
  if (Object.keys(aliasMap).length === 0) {
    return matches;
  }
  return matches.map((match) => {
    if (!match.opponent || !Object.prototype.hasOwnProperty.call(aliasMap, match.opponent)) {
      return match;
    }
    const resolved = resolveAliasChain(match.opponent, aliasMap);
    return resolved === match.opponent ? match : { ...match, opponent: resolved };
  });
}

export type OpponentSource = 'startgg' | 'parrygg' | 'manual' | 'mixed';

/**
 * Per canonical opponent name (post-alias-merge — call after
 * `applyOpponentAliases`), classifies where their matches came from:
 * 'startgg' or 'parrygg' when every match for that name came from exactly
 * one of those tournament sites, 'manual' when none did, 'mixed' otherwise
 * — including an opponent seen on BOTH start.gg and parry.gg with no manual
 * matches at all (V8-A: two verified sources is still "more than one
 * source", so it gets the same multi-source badge as
 * verified-plus-manual, rather than a dedicated third combination). Powers
 * the source badges on the scouting list + report header. Matches without
 * an opponent name are ignored.
 */
export function getOpponentSources(matches: Match[]): Map<string, OpponentSource> {
  const flags = new Map<string, { hasStartgg: boolean; hasParrygg: boolean; hasManual: boolean }>();
  for (const match of matches) {
    if (!match.opponent) {
      continue;
    }
    const entry = flags.get(match.opponent) ?? {
      hasStartgg: false,
      hasParrygg: false,
      hasManual: false,
    };
    if (match.source === 'startgg') {
      entry.hasStartgg = true;
    } else if (match.source === 'parrygg') {
      entry.hasParrygg = true;
    } else {
      entry.hasManual = true;
    }
    flags.set(match.opponent, entry);
  }

  const sources = new Map<string, OpponentSource>();
  for (const [opponent, { hasStartgg, hasParrygg, hasManual }] of flags) {
    const siteCount = (hasStartgg ? 1 : 0) + (hasParrygg ? 1 : 0);
    if (siteCount === 2 || (siteCount === 1 && hasManual)) {
      sources.set(opponent, 'mixed');
    } else if (hasStartgg) {
      sources.set(opponent, 'startgg');
    } else if (hasParrygg) {
      sources.set(opponent, 'parrygg');
    } else {
      sources.set(opponent, 'manual');
    }
  }
  return sources;
}

export interface UseFilteredMatchesResult {
  /** Matches after applying the global source + time-range filter. */
  matches: Match[];
  /** All of the user's matches, unfiltered — for empty-state checks and "most used" style aggregates. */
  allMatches: Match[];
  /**
   * Matches with only the time-range filter applied (source filter
   * intentionally ignored) — for widgets that compare across sources
   * themselves (e.g. a casual-vs-competitive split) and need both buckets
   * available regardless of the global source filter's current value.
   */
  timeFilteredMatches: Match[];
  isLoading: boolean;
  /**
   * Plan 39.1-20 (UIX-07): true while the underlying matches query is
   * in-flight AND the initial load has already settled once (`!isLoading`)
   * — a background refetch, not the first paint. Threaded straight from
   * `useMatches()`'s own react-query `isFetching`, which was previously
   * discarded here; every one of the eight analytics pages needs this to
   * implement the "hold the previous frame at reduced opacity" refetch rule
   * (UI-SPEC §7.2/§10.5) without re-deriving it from a second query call.
   */
  isFetching: boolean;
  /** True when the active filters exclude at least one record the user actually has. */
  filterActive: boolean;
}

/**
 * Wraps `useMatches` with opponent-alias canonicalization + the global
 * analytics filter (source + time range) applied, in that order — aliases
 * are resolved first so every downstream filter/consumer already sees
 * merged identities (the single choke point; see `applyOpponentAliases`).
 *
 * The alias query is enabled only when authed (same gate as `useMatches`);
 * while it's loading (or absent), an empty map is used rather than gating
 * render on it, per the locked design — no loading flicker for pages that
 * just want to show opponent names quickly and re-render once aliases land.
 */
export function useFilteredMatches(): UseFilteredMatchesResult {
  const { data: rawMatches = [], isLoading, isFetching } = useMatches();
  const { data: aliasMap } = useOpponentAliases();
  const { source, range } = useAnalyticsFilter();

  const allMatches = useMemo(() => {
    return applyOpponentAliases(rawMatches, aliasMap ?? {});
  }, [rawMatches, aliasMap]);

  const timeFilteredMatches = useMemo(() => {
    return filterByRange(allMatches, range);
  }, [allMatches, range]);

  const matches = useMemo(() => {
    return filterBySource(timeFilteredMatches, source);
  }, [timeFilteredMatches, source]);

  return {
    matches,
    allMatches,
    timeFilteredMatches,
    isLoading,
    isFetching,
    filterActive: matches.length !== allMatches.length,
  };
}
