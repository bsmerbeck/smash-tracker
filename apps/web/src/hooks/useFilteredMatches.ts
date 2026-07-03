import { useMemo } from 'react';
import type { Match } from '@smash-tracker/shared';
import { useMatches } from '@/hooks/useMatches';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
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

/** Wraps `useMatches` with the global analytics filter (source + time range) applied. */
export function useFilteredMatches(): UseFilteredMatchesResult {
  const { data: allMatches = [], isLoading } = useMatches();
  const { source, range } = useAnalyticsFilter();

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
