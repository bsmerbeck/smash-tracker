import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AuthContext } from '@/context/AuthContext';
import {
  getActiveSubjectClientId,
  subjectSegment,
  subscribeActiveSubject,
} from '@/lib/subjectQueryKey';

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
  /**
   * Phase 35-03 (Task 4, NEW-H1, planner decision 9): the subject this
   * state was SEEDED from. Additive-only — nothing outside this file
   * constructs an `AnalyticsFilterContextValue` (`useAnalyticsFilter.ts`
   * only imports the type), so this field cannot break an existing
   * consumer. Its purpose is to let a PROGRAMMATIC writer
   * (`useAutoWidenEmptyRange`) verify the state it is about to judge
   * belongs to its own subject before acting, instead of assuming it.
   */
  subjectClientId: string | null;
}

/** Legacy, un-scoped key — read-only seed for the personal scope. Never written by this module (D-08). */
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

/**
 * Phase 35-03 (Task 4, D-05/NEW-M2): composes the uid + subject segment into
 * the scoped storage key. Takes a RAW `clientId` — exactly like
 * `analyticsSelectionStorageKey` and `rangeAutoWidenSessionKey` — and
 * derives its segment through the single shared `subjectSegment` speller; it
 * must never spell `client:` itself. A `null` uid (signed-out, or a bare
 * `AnalyticsFilterProvider` rendered without an `AuthProvider`, which
 * several existing suites do) resolves to the literal `anonymous` segment,
 * which keeps those suites meaningful without reintroducing an un-scoped
 * key.
 */
export function analyticsFilterStorageKey(uid: string | null, clientId: string | null): string {
  return `${ANALYTICS_FILTER_STORAGE_KEY}.${uid ?? 'anonymous'}.${subjectSegment(clientId)}`;
}

function readScopedFilterState(storageKey: string): AnalyticsFilterState | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw == null ? null : parseStoredFilterState(raw);
  } catch {
    return null;
  }
}

function readLegacyFilterState(): AnalyticsFilterState | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY);
    return raw == null ? null : parseStoredFilterState(raw);
  } catch {
    return null;
  }
}

/**
 * Resolves the state to seed/re-seed from, for a resolved storage key. A
 * `null` key (the auth-loading window) yields the defaults. Otherwise reads
 * the scoped key; when absent AND `clientId` is null (the personal scope),
 * falls back to the legacy un-scoped key as a ONE-TIME seed (D-08) — never
 * for a client subject, which never had a legacy value to seed from.
 */
function readFilterState(storageKey: string | null, clientId: string | null): AnalyticsFilterState {
  if (storageKey == null) {
    return DEFAULT_ANALYTICS_FILTER_STATE;
  }
  const scoped = readScopedFilterState(storageKey);
  if (scoped != null) {
    return scoped;
  }
  if (clientId == null) {
    const legacy = readLegacyFilterState();
    if (legacy != null) {
      return legacy;
    }
  }
  return DEFAULT_ANALYTICS_FILTER_STATE;
}

/** The ONE write call site in this module — a `null` key (auth loading) writes nothing. */
function persistFilterState(storageKey: string | null, state: AnalyticsFilterState): void {
  if (storageKey == null || typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
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
 *
 * Phase 35-03 (Task 4, D-08): subject-scoped per (uid, subject), with a
 * one-time legacy seed for the personal scope. Mounted OUTSIDE
 * `<BrowserRouter>` (`AppProviders.tsx`), so it reads the subject through
 * `getActiveSubjectClientId()` + `subscribeActiveSubject` (Task 3) instead
 * of `useEffectiveSubject()`/`useActiveSubject()` — calling either of those
 * here would throw on every page at boot (RESEARCH Pitfall 3). It reads
 * auth via `useContext(AuthContext)` directly rather than `useAuth()` for
 * the identical reason: several existing suites render this provider with
 * no `AuthProvider` at all.
 */
export function AnalyticsFilterProvider({ children }: { children: ReactNode }) {
  const auth = useContext(AuthContext);
  const uid = auth?.user?.uid ?? null;
  const loading = auth?.loading ?? false;

  // A `string | null` primitive snapshot — `Object.is` comparison is stable
  // without memoization. Correct on the FIRST render of a hard load or deep
  // link into either client route family (H-3/NEW-H2), because the reader
  // derives from `window.location.pathname` on every call; the store is
  // consulted only for the change-NOTIFICATION signal.
  const clientId = useSyncExternalStore(
    subscribeActiveSubject,
    getActiveSubjectClientId,
    getActiveSubjectClientId,
  );

  const storageKey = loading ? null : analyticsFilterStorageKey(uid, clientId);

  const [seededKey, setSeededKey] = useState(storageKey);
  const [state, setState] = useState<AnalyticsFilterState>(() =>
    readFilterState(storageKey, clientId),
  );

  // "Latest value" refs for the three setters below, kept stable (empty
  // `useCallback` deps — planner decision 7) so their identity never
  // churns: `setRange` is a declared dependency of
  // `useAutoWidenEmptyRange`'s effect, and churning it on every subject
  // switch or filter change would churn that effect too. Synced via a
  // no-deps `useEffect` (runs after every commit) rather than assigned
  // during render — this codebase's `react-hooks/refs` lint rule forbids
  // writing `ref.current` during render (see `usePersistedSelection.ts`'s
  // own docstring for the same constraint). This is safe for the
  // batched-setters case (NEW-L1) because each setter ALSO advances
  // `stateRef.current` eagerly, synchronously, inside its own body — see
  // below — so two setters fired back-to-back in one handler never depend
  // on the effect having flushed between them.
  const uidRef = useRef(uid);
  const loadingRef = useRef(loading);
  const stateRef = useRef(state);
  useEffect(() => {
    uidRef.current = uid;
    loadingRef.current = loading;
    stateRef.current = state;
  });

  // React's documented "adjust state when a prop changes" pattern (no
  // effect): when the resolved storage key differs from the one `state`
  // was seeded from, re-seed synchronously during render — the same
  // pattern `usePersistedSelection` uses, and sound here for the identical
  // reason: `getActiveSubjectClientId()` is a pure `window.location.pathname`
  // parse, already correct on the FIRST render of any subject change. The
  // re-seed calls ONLY the raw `useState` setter — never `setSource`/
  // `setRange`/`resetFilters` — because a re-seed is not a user change
  // (D-06) and must write nothing (NEW3-L1).
  if (storageKey !== seededKey) {
    setSeededKey(storageKey);
    setState(readFilterState(storageKey, clientId));
    // `stateRef` is NOT written here — writing `ref.current` during render
    // is forbidden by this codebase's `react-hooks/refs` lint rule. The
    // no-deps `useEffect` above re-syncs it after this render commits,
    // which is always before any setter can possibly be called (setters
    // only run from event handlers/effects, strictly after commit).
  }

  const setSource = useCallback((next: AnalyticsSourceFilter) => {
    const updated = { ...stateRef.current, source: next };
    stateRef.current = updated;
    const key = loadingRef.current
      ? null
      : analyticsFilterStorageKey(uidRef.current, getActiveSubjectClientId());
    persistFilterState(key, updated);
    setState(updated);
  }, []);

  const setRange = useCallback((next: AnalyticsRangeFilter) => {
    const updated = { ...stateRef.current, range: next };
    stateRef.current = updated;
    const key = loadingRef.current
      ? null
      : analyticsFilterStorageKey(uidRef.current, getActiveSubjectClientId());
    persistFilterState(key, updated);
    setState(updated);
  }, []);

  const resetFilters = useCallback(() => {
    stateRef.current = DEFAULT_ANALYTICS_FILTER_STATE;
    const key = loadingRef.current
      ? null
      : analyticsFilterStorageKey(uidRef.current, getActiveSubjectClientId());
    persistFilterState(key, DEFAULT_ANALYTICS_FILTER_STATE);
    setState(DEFAULT_ANALYTICS_FILTER_STATE);
  }, []);

  const value = useMemo<AnalyticsFilterContextValue>(
    () => ({ ...state, setSource, setRange, resetFilters, subjectClientId: clientId }),
    [state, setSource, setRange, resetFilters, clientId],
  );

  return (
    <AnalyticsFilterContext.Provider value={value}>{children}</AnalyticsFilterContext.Provider>
  );
}
