import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react';

export type AnalyticsSourceFilter = 'all' | 'manual' | 'startgg';
export type AnalyticsRangeFilter = 'all' | '3m' | '6m' | '12m';

export interface AnalyticsFilterState {
  source: AnalyticsSourceFilter;
  range: AnalyticsRangeFilter;
}

export interface AnalyticsFilterContextValue extends AnalyticsFilterState {
  setSource: (next: AnalyticsSourceFilter) => void;
  setRange: (next: AnalyticsRangeFilter) => void;
  /** Resets both filters to their defaults ('all' source, 'all' time range). */
  resetFilters: () => void;
}

export const ANALYTICS_FILTER_STORAGE_KEY = 'smash-tracker.analyticsFilter';

export const DEFAULT_ANALYTICS_FILTER_STATE: AnalyticsFilterState = {
  source: 'all',
  range: 'all',
};

const SOURCE_VALUES: AnalyticsSourceFilter[] = ['all', 'manual', 'startgg'];
const RANGE_VALUES: AnalyticsRangeFilter[] = ['all', '3m', '6m', '12m'];

/** Parses a persisted filter state, tolerating missing/malformed localStorage content. */
function parseStoredFilterState(raw: string | null): AnalyticsFilterState {
  if (!raw) {
    return DEFAULT_ANALYTICS_FILTER_STATE;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_ANALYTICS_FILTER_STATE;
    }
    const candidate = parsed as Partial<AnalyticsFilterState>;
    const source = SOURCE_VALUES.includes(candidate.source as AnalyticsSourceFilter)
      ? (candidate.source as AnalyticsSourceFilter)
      : DEFAULT_ANALYTICS_FILTER_STATE.source;
    const range = RANGE_VALUES.includes(candidate.range as AnalyticsRangeFilter)
      ? (candidate.range as AnalyticsRangeFilter)
      : DEFAULT_ANALYTICS_FILTER_STATE.range;
    return { source, range };
  } catch {
    return DEFAULT_ANALYTICS_FILTER_STATE;
  }
}

function readInitialFilterState(): AnalyticsFilterState {
  if (typeof window === 'undefined') {
    return DEFAULT_ANALYTICS_FILTER_STATE;
  }
  try {
    return parseStoredFilterState(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY));
  } catch {
    // localStorage can throw (e.g. private browsing, disabled storage).
    return DEFAULT_ANALYTICS_FILTER_STATE;
  }
}

function persistFilterState(state: AnalyticsFilterState): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(ANALYTICS_FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures — filters just won't persist this session.
  }
}

export const AnalyticsFilterContext = createContext<AnalyticsFilterContextValue | undefined>(
  undefined,
);

/**
 * Global source/time-range analytics filter, persisted to localStorage and
 * honored by every data page (Dashboard, Fighter Analysis, Matchups, Match
 * Data) via `useFilteredMatches`. Replaces the old per-page SourceFilterTabs.
 */
export function AnalyticsFilterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AnalyticsFilterState>(readInitialFilterState);

  const setSource = useCallback((next: AnalyticsSourceFilter) => {
    setState((prev) => {
      const updated = { ...prev, source: next };
      persistFilterState(updated);
      return updated;
    });
  }, []);

  const setRange = useCallback((next: AnalyticsRangeFilter) => {
    setState((prev) => {
      const updated = { ...prev, range: next };
      persistFilterState(updated);
      return updated;
    });
  }, []);

  const resetFilters = useCallback(() => {
    persistFilterState(DEFAULT_ANALYTICS_FILTER_STATE);
    setState(DEFAULT_ANALYTICS_FILTER_STATE);
  }, []);

  const value = useMemo<AnalyticsFilterContextValue>(
    () => ({ ...state, setSource, setRange, resetFilters }),
    [state, setSource, setRange, resetFilters],
  );

  return (
    <AnalyticsFilterContext.Provider value={value}>{children}</AnalyticsFilterContext.Provider>
  );
}
