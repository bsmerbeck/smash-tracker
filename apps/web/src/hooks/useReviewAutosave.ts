import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReviewDraft, ReviewSection } from '@smash-tracker/shared';
import { reviewDraftSchema } from '@smash-tracker/shared';
import { api, ApiError } from '@/lib/api';
import { reviewDraftQueryKey } from './useCoachingReviews';

/** Matches the search-debounce delay `useParrygg.ts` already established for a fast-changing text input, applied here to the composer's edit buffer. */
const AUTOSAVE_DEBOUNCE_MS = 1200;

/**
 * Debounces a fast-changing value so a dependent effect only fires
 * `delayMs` after the value stops changing. Copied verbatim from
 * `useParrygg.ts`'s `useDebouncedValue` per 12-06-PLAN.md's explicit
 * instruction (no new package for a ~10-line utility).
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface ReviewAutosaveInput {
  sections: ReviewSection[];
  coachPrivateNotes: string | null;
}

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export interface UseReviewAutosaveResult {
  status: AutosaveStatus;
  /** The server's current draft as returned by a 409 — `null` unless `status === 'conflict'`. */
  conflictServerDraft: ReviewDraft | null;
  /**
   * "See theirs" — discards the coach's in-flight local buffer, adopts the
   * server draft as the new baseline, and resumes autosave. Returns the
   * server draft so the caller (the composer) can reset its own local
   * sections/private-notes state to match — this hook never reaches into
   * the caller's state itself.
   */
  resolveWithServerDraft: () => ReviewDraft | null;
  /**
   * "Keep mine" — re-submits the coach's CURRENT local buffer against the
   * server's now-known revision (never the stale one that caused the 409)
   * and resumes autosave.
   */
  resolveKeepMine: () => void;
}

/**
 * Drives a debounced, revision-checked autosave PATCH against
 * `.../reviews/:reviewId/draft` (REV-02/D-07). On a stale-`expectedRevision`
 * 409 (T-12-18), the debounce loop STOPS immediately — no further PATCH is
 * attempted, and no local change is ever silently reapplied on top of the
 * server's newer text — until the caller resolves the conflict via
 * `resolveWithServerDraft`/`resolveKeepMine` (typically from an
 * `AutosaveConflictDialog`).
 */
export function useReviewAutosave(
  clientId: string,
  reviewId: string,
  input: ReviewAutosaveInput,
  initialRevision: number,
): UseReviewAutosaveResult {
  const queryClient = useQueryClient();
  const debounced = useDebouncedValue(input, AUTOSAVE_DEBOUNCE_MS);

  const expectedRevisionRef = useRef(initialRevision);
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [conflictServerDraft, setConflictServerDraft] = useState<ReviewDraft | null>(null);

  // Freezes the debounce-triggered PATCH loop while a conflict is
  // unresolved (T-12-18) — the ONLY way this ref clears is an explicit
  // resolveWithServerDraft/resolveKeepMine call.
  const pausedRef = useRef(false);
  // Skips the very first debounce tick, which fires on mount with the
  // just-fetched draft — already in sync with the server, so PATCHing it
  // would be a wasted round-trip (and could even race a still-loading
  // initialRevision).
  const skipNextRef = useRef(true);
  // Always holds the LATEST local buffer (updated every render, never a
  // dependency) so `resolveKeepMine` re-submits what the coach is looking
  // at right now, not a stale debounced snapshot.
  const latestInputRef = useRef(input);
  useEffect(() => {
    latestInputRef.current = input;
  });
  // The last CONTENT (not object identity) this hook has already PATCHed
  // or intentionally skipped. `input` is a fresh object literal every
  // render (the composer holds sections/private-notes as plain React
  // state), so debounce's identity-based effect would otherwise re-fire —
  // and re-PATCH — on every unrelated re-render (e.g. switching the
  // Client review / Private notes tab) even when nothing actually changed.
  const lastSyncedSnapshotRef = useRef(JSON.stringify(input));

  useEffect(() => {
    expectedRevisionRef.current = initialRevision;
  }, [initialRevision]);

  useEffect(() => {
    if (skipNextRef.current) {
      skipNextRef.current = false;
      lastSyncedSnapshotRef.current = JSON.stringify(debounced);
      return;
    }
    if (pausedRef.current) {
      return;
    }
    const snapshot = JSON.stringify(debounced);
    if (snapshot === lastSyncedSnapshotRef.current) {
      // Content-identical to the last PATCH/skip — a re-render produced a
      // new object identity but no real edit happened; don't waste a
      // round-trip (and don't advance the "saved" status either).
      return;
    }
    lastSyncedSnapshotRef.current = snapshot;

    let cancelled = false;
    setStatus('saving');

    api.coaching.reviews
      .patchDraft(clientId, reviewId, {
        expectedRevision: expectedRevisionRef.current,
        sections: debounced.sections,
        coachPrivateNotes: debounced.coachPrivateNotes,
      })
      .then((draft) => {
        if (cancelled) return;
        expectedRevisionRef.current = draft.revision;
        queryClient.setQueryData(reviewDraftQueryKey(clientId, reviewId), draft);
        setStatus('saved');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 409) {
          // See `apiRequest`'s `ApiError.details` fallback in `lib/api.ts` —
          // the 409 body's `serverDraft` field lands here.
          const parsed = reviewDraftSchema.safeParse(
            (err.details as { serverDraft?: unknown } | undefined)?.serverDraft,
          );
          pausedRef.current = true;
          setConflictServerDraft(parsed.success ? parsed.data : null);
          setStatus('conflict');
          return;
        }
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
    // debounced is a fresh object each debounce tick (identity comparison is
    // fine here — React re-runs on every new tick regardless); clientId/
    // reviewId identify which draft this hook instance targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, clientId, reviewId]);

  function resolveWithServerDraft(): ReviewDraft | null {
    if (!conflictServerDraft) {
      return null;
    }
    expectedRevisionRef.current = conflictServerDraft.revision;
    queryClient.setQueryData(reviewDraftQueryKey(clientId, reviewId), conflictServerDraft);
    pausedRef.current = false;
    // The next debounce tick would otherwise immediately re-fire with the
    // buffer that JUST caused the conflict — skip it once, mirroring the
    // mount-time skip above, since the caller is about to reset its local
    // state to match the server draft this function returns.
    skipNextRef.current = true;
    setStatus('idle');
    setConflictServerDraft(null);
    return conflictServerDraft;
  }

  function resolveKeepMine(): void {
    if (!conflictServerDraft) {
      return;
    }
    const resumeRevision = conflictServerDraft.revision;
    pausedRef.current = false;
    setStatus('saving');
    setConflictServerDraft(null);

    api.coaching.reviews
      .patchDraft(clientId, reviewId, {
        expectedRevision: resumeRevision,
        sections: latestInputRef.current.sections,
        coachPrivateNotes: latestInputRef.current.coachPrivateNotes,
      })
      .then((draft) => {
        expectedRevisionRef.current = draft.revision;
        queryClient.setQueryData(reviewDraftQueryKey(clientId, reviewId), draft);
        // The debounce effect above will also fire once more for this same
        // buffer (its dependency didn't change identity, but a subsequent
        // edit will) — skip that redundant PATCH.
        skipNextRef.current = true;
        setStatus('saved');
      })
      .catch(() => {
        setStatus('error');
      });
  }

  return { status, conflictServerDraft, resolveWithServerDraft, resolveKeepMine };
}
