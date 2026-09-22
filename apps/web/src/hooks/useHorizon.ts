import { useEffect, useState } from 'react';
import { resolveWindow, type HorizonKey, type Match } from '@smash-tracker/shared';
import { useAuth } from '@/hooks/useAuth';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import {
  analyticsSelectionStorageKey,
  persistSelection,
  readStoredSelection,
  type StoredAnalyticsSelection,
} from '@/lib/analyticsSelection';

/** D-06: the switch's default choice — every unknown/absent/unavailable stored value resolves here. */
export const DEFAULT_HORIZON: HorizonKey = 'last30';

/**
 * Whether `matches` has at least one game inside the `lastEvent` window,
 * i.e. whether the scope has any tournament (named-event) games at all.
 * Deliberately a PLAIN function (not inlined into the hook body): the
 * `Date.now()` read it needs is impure, and this codebase's
 * `react-hooks/purity` lint rule forbids calling an impure global directly
 * inside a hook/component body — mirroring `useFilteredMatches.ts`'s own
 * `rangeCutoff`/`filterByRange`, whose `now = Date.now()` default parameter
 * lives in a plain util function for the same reason.
 */
function hasLastEventGames(matches: Match[], nowMs = Date.now()): boolean {
  return resolveWindow({ matches, horizon: 'lastEvent', scoped: false, nowMs }).window.games > 0;
}

/**
 * 39.1-REVIEW iteration 2 CR-01: the in-tab change channel that makes every
 * `useHorizon()` call for one (uid, subject) ONE source of truth. Each call
 * still seeds from the persisted `analyticsSelection` record (unchanged
 * persistence semantics), but a `setHorizon` from ANY call — the page's
 * `HorizonSwitch`, the page itself, FighterHero's recent figures — is
 * broadcast here, and every mounted call on the same storage key adopts it
 * in the same event batch. Without it each call kept a private `useState`
 * copy: a switch press re-highlighted the switch and wrote localStorage while
 * every page figure stayed on the old horizon until remount (`storage` events
 * never fire in the writing tab). Keyed by the storage key, so a change on
 * one subject never reaches another subject's calls. Holds no value of its
 * own — only live listeners — so nothing survives an unmount.
 */
type HorizonListener = (storageKey: string, next: HorizonKey) => void;
const horizonListeners = new Set<HorizonListener>();

function broadcastHorizon(storageKey: string, next: HorizonKey): void {
  for (const listener of horizonListeners) listener(storageKey, next);
}

export interface UseHorizonResult {
  horizon: HorizonKey;
  /** The ONLY writer of a horizon choice — an explicit user change (D-06). */
  setHorizon: (next: HorizonKey) => void;
  /** False when the current scope (subject) has no tournament (named-event) games. */
  isLastEventAvailable: boolean;
  isLoading: boolean;
}

/**
 * Plan 39.1-12 (INS-02, D-06): the one page-level `HorizonSwitch`'s state,
 * persisted per (uid, subject) through Phase 35's device-local
 * `analyticsSelection` store — the SAME store `usePersistedSelection` writes
 * fighter/opponent choices to, extended with an additive `horizon` field
 * (`lib/analyticsSelection.ts`).
 *
 * Mirrors `usePersistedSelection`'s write discipline — `setHorizon` is the
 * ONLY call site of `persistSelection` in this module, so a computed default
 * can never be persisted — with ONE deliberate difference from that sibling
 * hook: the storage READ itself is also deferred until the match query has
 * settled, not just the write. `usePersistedSelection`'s own lazy
 * `useState` initializer reads storage on mount regardless of `isLoading`;
 * this hook's own contract (zero reads AND zero writes while the match
 * query is in flight) forbids that, so the read is instead performed via
 * the same "adjust state during render" pattern `usePersistedSelection`
 * already uses for a subject-key change, gated additionally on `!isLoading`.
 * Do not "simplify" this back to a lazy `useState` initializer — that
 * reintroduces a read during loading.
 *
 * `isLastEventAvailable` is derived from `resolveWindow` (the same shared
 * insight-engine primitive the rest of Track C composes) rather than a
 * locally re-implemented "has a named event" scan — a stored `lastEvent`
 * value is honored only when that window actually has at least one game;
 * otherwise the hook resolves to the default and writes nothing (D-06).
 */
export function useHorizon(): UseHorizonResult {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { clientId } = useEffectiveSubject();
  const { allMatches, isLoading } = useFilteredMatches();

  const storageKey = uid ? analyticsSelectionStorageKey(uid, clientId) : null;

  const [record, setRecord] = useState<StoredAnalyticsSelection>({});
  // `undefined` means "never seeded" — distinct from a real `null` key
  // (signed out / no subject), so the first not-loading render always seeds
  // once, even when there is nothing to read.
  const [seededKey, setSeededKey] = useState<string | null | undefined>(undefined);

  if (!isLoading && seededKey !== storageKey) {
    setSeededKey(storageKey);
    setRecord(readStoredSelection(uid, clientId));
  }

  // CR-01: adopt a horizon written by any other call on the SAME subject.
  // Subscribed above the loading early return (Rules of Hooks); a call that
  // is still loading adopts it too and then re-seeds from storage, which
  // `persistSelection` has already written, so the two agree.
  useEffect(() => {
    if (storageKey == null) return undefined;
    const listener: HorizonListener = (changedKey, next) => {
      if (changedKey !== storageKey) return;
      setRecord((prev) => (prev.horizon === next ? prev : { ...prev, horizon: next }));
    };
    horizonListeners.add(listener);
    return () => {
      horizonListeners.delete(listener);
    };
  }, [storageKey]);

  if (isLoading) {
    return {
      horizon: DEFAULT_HORIZON,
      setHorizon: () => {},
      isLastEventAvailable: false,
      isLoading: true,
    };
  }

  const isLastEventAvailable = hasLastEventGames(allMatches);

  const storedHorizon = record.horizon;
  let horizon: HorizonKey = DEFAULT_HORIZON;
  if (storedHorizon === 'last30' || storedHorizon === 'last90') {
    horizon = storedHorizon;
  } else if (storedHorizon === 'lastEvent' && isLastEventAvailable) {
    horizon = 'lastEvent';
  }

  function setHorizon(next: HorizonKey): void {
    setRecord((prev) => ({ ...prev, horizon: next }));
    persistSelection(uid, clientId, { horizon: next });
    if (storageKey != null) broadcastHorizon(storageKey, next);
  }

  return { horizon, setHorizon, isLastEventAvailable, isLoading: false };
}
