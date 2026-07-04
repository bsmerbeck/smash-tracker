import { useMemo } from 'react';
import type { Match, OpponentAliasMap } from '@smash-tracker/shared';
import { useMatches } from '@/hooks/useMatches';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import type { AnalyticsRangeFilter, AnalyticsSourceFilter } from '@/context/AnalyticsFilterContext';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Approximate month length (30 days), matching the coarse "3m/6m/12m" granularity of the filter UI. */
const RANGE_DAYS: Record<Exclude<AnalyticsRangeFilter, 'all'>, number> = {
  '3m': 30 * 3,
  '6m': 30 * 6,
  '12m': 30 * 12,
};

/** Filters matches by origin: manually-entered vs imported from start.gg. Moved from the removed SourceFilterTabs. */
export function filterBySource(matches: Match[], filter: AnalyticsSourceFilter): Match[] {
  if (filter === 'all') {
    return matches;
  }
  if (filter === 'startgg') {
    return matches.filter((m) => m.source === 'startgg');
  }
  return matches.filter((m) => m.source == null);
}

/**
 * Filters matches to those within the given trailing time range, relative to
 * `now`. `'all'` performs no cut. The cutoff is inclusive (`match.time >=
 * now - range`).
 */
export function filterByRange(
  matches: Match[],
  filter: AnalyticsRangeFilter,
  now = Date.now(),
): Match[] {
  if (filter === 'all') {
    return matches;
  }
  const cutoff = now - RANGE_DAYS[filter] * DAY_MS;
  return matches.filter((m) => m.time >= cutoff);
}

/**
 * Rewrites `match.opponent` to its canonical name per `aliasMap` (alias ->
 * canonical). Matches with no `opponent` set, or whose opponent isn't a key
 * in the map, are returned unchanged (same object reference — no unnecessary
 * re-renders downstream). This is the SINGLE CHOKE POINT for opponent
 * identity merging: every consumer that reads `match.opponent` should go
 * through `useFilteredMatches` (which applies this) rather than raw
 * `useMatches`, so scouting/tables/dashboards all see merged identities
 * automatically without each needing alias-awareness of their own.
 */
export function applyOpponentAliases(matches: Match[], aliasMap: OpponentAliasMap): Match[] {
  if (Object.keys(aliasMap).length === 0) {
    return matches;
  }
  return matches.map((match) => {
    if (!match.opponent || !Object.prototype.hasOwnProperty.call(aliasMap, match.opponent)) {
      return match;
    }
    return { ...match, opponent: aliasMap[match.opponent]! };
  });
}

export type OpponentSource = 'startgg' | 'manual' | 'mixed';

/**
 * Per canonical opponent name (post-alias-merge — call after
 * `applyOpponentAliases`), classifies where their matches came from:
 * 'startgg' when every match for that name was imported, 'manual' when none
 * were, 'mixed' otherwise. Powers the source badges on the scouting list +
 * report header. Matches without an opponent name are ignored.
 */
export function getOpponentSources(matches: Match[]): Map<string, OpponentSource> {
  const flags = new Map<string, { hasStartgg: boolean; hasManual: boolean }>();
  for (const match of matches) {
    if (!match.opponent) {
      continue;
    }
    const entry = flags.get(match.opponent) ?? { hasStartgg: false, hasManual: false };
    if (match.source === 'startgg') {
      entry.hasStartgg = true;
    } else {
      entry.hasManual = true;
    }
    flags.set(match.opponent, entry);
  }

  const sources = new Map<string, OpponentSource>();
  for (const [opponent, { hasStartgg, hasManual }] of flags) {
    if (hasStartgg && hasManual) {
      sources.set(opponent, 'mixed');
    } else if (hasStartgg) {
      sources.set(opponent, 'startgg');
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
  const { data: rawMatches = [], isLoading } = useMatches();
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
    filterActive: matches.length !== allMatches.length,
  };
}
