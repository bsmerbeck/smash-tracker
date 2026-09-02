import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMatches } from '@/hooks/useMatches';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { filterByRange } from '@/hooks/useFilteredMatches';
import type { AnalyticsRangeFilter } from '@/context/AnalyticsFilterContext';

/**
 * Quick 260901-tj7: sessionStorage flag guarding the widen evaluation across
 * a `MainLayout` remount. `AppRouter.tsx` wraps each route's element in its
 * own `<ProtectedRoute><MainLayout>…`, so navigating between pages unmounts
 * and remounts `MainLayout` — and with it, resets any plain `useRef` guard.
 * Without this session-level flag, a user who deliberately picks `12m` and
 * then navigates to another page would have that pick silently auto-flipped
 * back to `all` on the next mount, which is exactly what D-01 forbids.
 */
export const RANGE_AUTO_WIDEN_SESSION_KEY = 'smash-tracker.analyticsRangeAutoWiden';

/** Reuses the same labels `AnalyticsFilterControls` renders (D-03) rather than re-typing them. */
const RANGE_LABEL_KEYS: Record<Exclude<AnalyticsRangeFilter, 'all'>, string> = {
  '3m': 'filters.months3',
  '6m': 'filters.months6',
  '12m': 'filters.months12',
};

function readSessionFlag(): boolean {
  try {
    return window.sessionStorage.getItem(RANGE_AUTO_WIDEN_SESSION_KEY) != null;
  } catch {
    // sessionStorage can throw (private browsing, disabled storage) — treat
    // as "not yet evaluated"; the in-memory ref guard still protects this
    // mounted instance from a double-fire within the same effect lifetime.
    return false;
  }
}

function writeSessionFlag(): void {
  try {
    window.sessionStorage.setItem(RANGE_AUTO_WIDEN_SESSION_KEY, '1');
  } catch {
    // Ignore storage failures — nothing else depends on this write succeeding.
  }
}

/**
 * Quick 260901-tj7: the owner-reported "everything empty" bug traced back to
 * a PERSISTED analytics time range (e.g. `12m`), not the coded default
 * (already `'all'`) — a library entirely outside that window silently
 * emptied every analytics page, and the small `FilteredEmptyNotice` was easy
 * to miss under a page that otherwise looked broken.
 *
 * This hook evaluates ONCE per app session (not once per widen): the first
 * time match data has loaded, if the persisted range excludes every match
 * the user has, it widens the range to `'all'` (via the provider's normal
 * `setRange`, so the choice persists — D-02) and shows a one-time toast
 * naming the previous range (D-03). Evaluating once — and marking the
 * session spent whether or not a widen actually happened — is what makes a
 * range the user later picks in-session immune to being auto-flipped, even
 * across the `MainLayout` remount described above. The source (All/Casual/
 * Competitive) filter is never touched (D-01).
 *
 * D-05: mounted exactly once, from `MainLayout` — the single authenticated
 * shell chokepoint — never inside `useFilteredMatches` itself (~15
 * concurrent callers). Composes raw `useMatches` (the same subject-aware
 * query `useFilteredMatches` reads) rather than `useFilteredMatches`, since
 * the opponent-alias query it also pulls in can't affect a time-range
 * emptiness test.
 */
export function useAutoWidenEmptyRange(): void {
  const { t } = useTranslation();
  const { data: matches, isLoading } = useMatches();
  const { range, setRange } = useAnalyticsFilter();
  const evaluatedRef = useRef(false);

  useEffect(() => {
    if (evaluatedRef.current || isLoading || matches == null) {
      // The data-null check is load-bearing: when the query is disabled
      // (signed out), TanStack v5 reports isLoading === false with
      // data === undefined — marking the session evaluated here would burn
      // the one shot before any real data ever arrived.
      return;
    }

    if (readSessionFlag()) {
      evaluatedRef.current = true;
      return;
    }

    // The evaluation is spent whether or not it widens (D-01: "evaluate ONCE
    // per app session") — this is what makes a later in-session pick immune.
    evaluatedRef.current = true;
    writeSessionFlag();

    if (range === 'all' || matches.length === 0) {
      return;
    }
    if (filterByRange(matches, range).length > 0) {
      return;
    }

    // Read the label BEFORE widening — once setRange('all') lands, `range`
    // no longer names the previous value.
    const label = t(RANGE_LABEL_KEYS[range]);
    setRange('all');
    toast.info(t('filters.autoWidened', { range: label }));
  }, [matches, isLoading, range, setRange, t]);
}
