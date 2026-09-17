/**
 * Phase 36 (TRND-01, D-02): persistence for the dismissible "rating model
 * updated" note. Cloned from `analyticsSelection.ts`'s parse/read/persist
 * discipline verbatim — a `typeof window` guard, try/catch around every
 * storage call, a silent catch, never rethrow, never log.
 *
 * The key is scoped by BOTH uid and rating-model version, and is GLOBAL to
 * the uid rather than per-subject — the historical recompute (D-02) is one
 * global decision, not a per-coach-client one, so dismissing the note on
 * Dashboard also dismisses it on Trends/Groups/GSP. The stored value is
 * always the scalar string `'1'`, never an array or object, so the RTDB
 * positional-nullable-array hazard cannot apply even if this ever moved
 * server-side.
 */
export const RATING_MODEL_NOTE_KEY_PREFIX = 'smash-tracker.ratingModelNote';

/** Composes the uid + rating-model version into the full localStorage key. */
export function ratingModelNoteStorageKey(uid: string, version: number): string {
  return `${RATING_MODEL_NOTE_KEY_PREFIX}.${uid}.v${version}`;
}

/**
 * Returns `false` (not dismissed) when `uid` is nullish, `window` is
 * undefined, storage access throws, or the stored value is anything other
 * than the literal string `'1'` — a malformed/missing value never throws
 * and always degrades to "show the note".
 */
export function isRatingModelNoteDismissed(uid: string | null, version: number): boolean {
  if (!uid || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ratingModelNoteStorageKey(uid, version)) === '1';
  } catch {
    return false;
  }
}

/**
 * Marks the note dismissed for `uid` at `version`. No-op on a nullish uid or
 * undefined `window`; a storage write failure (private mode, blocked
 * storage) is caught silently — dismissal then lasts for the session's
 * component state only, per the plan's error-state contract.
 */
export function dismissRatingModelNote(uid: string | null, version: number): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ratingModelNoteStorageKey(uid, version), '1');
  } catch {
    // Ignore storage failures — dismissal just won't persist past this session.
  }
}
