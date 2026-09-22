import { useEffect, useRef } from 'react';
import type { HorizonKey } from '@smash-tracker/shared';

export interface UseClaimFollowsHorizonOptions {
  /** The page's ONE resolved horizon (`useHorizon`). */
  horizon: HorizonKey;
  /** `useHorizon`'s own loading flag — the horizon is a placeholder default until it settles. */
  horizonLoading: boolean;
  /** The `claim=` axis currently in the URL, if any. */
  claimId: string | undefined;
  /** Whether the page's own insights can resolve `claimId` right now. */
  hasClaim: (claimId: string) => boolean;
  /** The page's URL writer: re-point the claim to `next`, or drop it (`null`). */
  rewriteClaim: (next: string | null) => void;
}

/**
 * WR-01 (39.1-REVIEW): an insight's `claim=` id ends in the horizon it was
 * computed over (`${templateId}:${scopeKey}:${horizon}`). When the page's
 * horizon changes after a door was followed, that id stops resolving and
 * `FilteredMatchList`'s tolerant fallback silently lists every game in the
 * terminus base — under a header that still reads like the old door.
 *
 * This re-points the claim to the SAME template/scope at the new horizon
 * when the page can resolve that id, and drops it otherwise. Only a change
 * between two SETTLED horizons counts: the placeholder default `useHorizon`
 * reports while loading is never treated as a user change, so a shared or
 * reloaded door URL is left exactly as it arrived.
 */
export function useClaimFollowsHorizon({
  horizon,
  horizonLoading,
  claimId,
  hasClaim,
  rewriteClaim,
}: UseClaimFollowsHorizonOptions): void {
  const settledHorizon = useRef<HorizonKey | null>(null);
  useEffect(() => {
    if (horizonLoading) return;
    const before = settledHorizon.current;
    settledHorizon.current = horizon;
    if (before == null || before === horizon || claimId == null) return;
    const suffix = `:${before}`;
    if (!claimId.endsWith(suffix)) return;
    const candidate = `${claimId.slice(0, -suffix.length)}:${horizon}`;
    rewriteClaim(hasClaim(candidate) ? candidate : null);
  }, [horizon, horizonLoading, claimId, hasClaim, rewriteClaim]);
}
