import { subjectSegment } from '@/lib/subjectQueryKey';

/**
 * Plan 39.1-12 (INS-02/INS-04, D-06, T-39.1-12-01..05): per-(uid, subject)
 * dismissed insight ids, device-local. A SIBLING key to
 * `lib/analyticsSelection.ts`'s selection store — never folded into that
 * fixed-shape record (39.1-RESEARCH.md Assumption A2) — because a dismissed
 * id list grows unboundedly, unlike the small, fixed set of selection
 * fields. Reuses `subjectSegment` (never re-spelled here) for the SAME
 * reason `analyticsSelectionStorageKey` does: the `client:` literal must be
 * spelled in exactly one place (NEW-M2).
 */
export const INSIGHT_DISMISSALS_KEY_PREFIX = 'smash-tracker.analyticsInsightDismissals';

/**
 * T-39.1-12-03 (DoS guard): the maximum number of dismissed ids retained per
 * (uid, subject) — a long-lived device must not grow this list without
 * bound. `capDismissedIds` evicts the OLDEST entries first, keeping the
 * newest `MAX_DISMISSED_INSIGHTS`.
 */
export const MAX_DISMISSED_INSIGHTS = 100;

/**
 * Composes the uid + subject segment into the full localStorage key — the
 * SAME (uid, subject) shape `analyticsSelectionStorageKey` uses, under a
 * different prefix, so the two stores can never collide but always isolate
 * on the same subject boundary (T-39.1-12-01).
 */
export function insightDismissalsStorageKey(uid: string, clientId: string | null): string {
  return `${INSIGHT_DISMISSALS_KEY_PREFIX}.${uid}.${subjectSegment(clientId)}`;
}

/**
 * Parses a stored dismissal list, tolerating missing/malformed content
 * (T-39.1-12-02): a nullish/empty `raw`, invalid JSON, a non-array JSON
 * value, or an array containing non-string entries all resolve to a list of
 * only the valid string ids present — never a thrown error. Mirrors
 * `analyticsSelection.ts`'s `parseStoredSelection` tolerant-parse
 * discipline.
 */
export function parseStoredDismissals(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** Returns `[]` when `uid` is nullish — there is no subject to read for. */
export function readStoredDismissals(uid: string | null, clientId: string | null): string[] {
  if (!uid || typeof window === 'undefined') return [];
  try {
    return parseStoredDismissals(
      window.localStorage.getItem(insightDismissalsStorageKey(uid, clientId)),
    );
  } catch {
    return [];
  }
}

/**
 * Evicts the OLDEST entries at over `MAX_DISMISSED_INSIGHTS`, keeping the
 * newest — `ids` is assumed oldest-first (append order), matching how
 * `useInsightDismissals`'s `dismiss` grows the list.
 */
export function capDismissedIds(ids: string[]): string[] {
  return ids.length > MAX_DISMISSED_INSIGHTS ? ids.slice(ids.length - MAX_DISMISSED_INSIGHTS) : ids;
}

/**
 * Writes `ids` (capped via `capDismissedIds`) to the dismissal store.
 * No-ops when `uid` is nullish or `window` is undefined; every storage call
 * is inside a silent try/catch (T-39.1-12-05) — a throwing/unavailable
 * store must leave the page fully usable, the dismissal just won't persist
 * this session.
 */
export function writeStoredDismissals(
  uid: string | null,
  clientId: string | null,
  ids: string[],
): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    const key = insightDismissalsStorageKey(uid, clientId);
    window.localStorage.setItem(key, JSON.stringify(capDismissedIds(ids)));
  } catch {
    // Ignore storage failures — the dismissal just won't persist this session.
  }
}
