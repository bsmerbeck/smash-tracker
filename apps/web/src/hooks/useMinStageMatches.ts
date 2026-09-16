import { useCallback, useContext, useSyncExternalStore } from 'react';
import { AuthContext } from '@/context/AuthContext';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import {
  DEFAULT_MIN_STAGE_MATCHES,
  persistSelection,
  readStoredSelection,
} from '@/lib/analyticsSelection';

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Phase 35-03 (D-11): the ONE per-subject min-matches-per-stage threshold
 * shared by Matchup Stage Guide, Matchup Insights, and Counterpick Advisor —
 * converging their three previously-independent `useState(3)`s (two with
 * their own `Select` UI, one a hardcoded constant) into a single value read
 * from and written to the `minStageMatches` field of the same
 * subject-scoped record `lib/analyticsSelection.ts`/`usePersistedSelection`
 * already own.
 *
 * Reads the auth context directly via `useContext(AuthContext)` rather than
 * `useAuth()` so a component rendered without an `AuthProvider` degrades to
 * the default (uid null) instead of throwing (NEW-L2 precedent in
 * `usePersistedSelection`). `clientId` comes from `useEffectiveSubject()`,
 * which returns an `ActiveSubject` object — `.clientId` is what builds the
 * storage key.
 *
 * A module-level listener set is the change-notification channel: the
 * setter persists then notifies every subscriber, so two widgets mounted
 * under the same subject (e.g. Matchup Insights and Counterpick Advisor on
 * the same Matchups page) stay in step without a remount. The hook performs
 * no write of its own on mount or on read (D-06) — `setMinStageMatches` is
 * the only call site of `persistSelection` in this module.
 */
export function useMinStageMatches(): [number, (next: number) => void] {
  const auth = useContext(AuthContext);
  const uid = auth?.user?.uid ?? null;
  const { clientId } = useEffectiveSubject();

  const getSnapshot = useCallback(
    () => readStoredSelection(uid, clientId).minStageMatches ?? DEFAULT_MIN_STAGE_MATCHES,
    [uid, clientId],
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setMinStageMatches = useCallback(
    (next: number) => {
      persistSelection(uid, clientId, { minStageMatches: next });
      notify();
    },
    [uid, clientId],
  );

  return [value, setMinStageMatches];
}
