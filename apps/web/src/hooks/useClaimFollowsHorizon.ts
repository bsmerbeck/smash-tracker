import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { HorizonKey } from '@smash-tracker/shared';
import { DRILL_DOWN_CLAIM_PARAM } from '@/lib/drillDownParams';

export interface UseClaimFollowsHorizonOptions {
  /** The page's ONE resolved horizon (`useHorizon`). */
  horizon: HorizonKey;
  /** `useHorizon`'s own loading flag — the horizon is a placeholder default until it settles. */
  horizonLoading: boolean;
  /** `useHorizon`'s `explicitChangeCount` — only a horizon change that comes with a bump is the user's. */
  horizonChangeCount: number;
  /** The `claim=` axis currently in the URL, if any. */
  claimId: string | undefined;
  /** Whether the page's own insights can resolve `claimId` right now. */
  hasClaim: (claimId: string) => boolean;
  /** The page's URL writer: re-point the claim to `next`. */
  rewriteClaim: (next: string) => void;
}

/**
 * WR-01 (39.1-REVIEW): an insight's `claim=` id ends in the horizon it was
 * computed over (`${templateId}:${scopeKey}:${horizon}`). When the viewer
 * changes the page's horizon after following a door, this re-points the
 * claim to the SAME template/scope at the new horizon when the page can
 * resolve that id — the user asked for the new window, so the door follows.
 *
 * One behaviour for every page that accepts `claim=` (iteration 2): a claim
 * that does NOT resolve is never rewritten or silently dropped here. It is
 * left in the URL and `FilteredMatchList` drops it from the narrowing with
 * an explicit "not applied" notice. That covers both the in-session case
 * with no same-scope insight at the new horizon and the ARRIVAL case — a
 * door URL whose suffix differs from the viewer's persisted horizon
 * (reload, Back, a coach/shared URL). Only a horizon change that arrives
 * WITH a bump of `useHorizon`'s `explicitChangeCount` is the user's: the
 * loading placeholder settling, and the persisted value landing once auth
 * or the subject key resolves, both move `horizon` with no bump, so an
 * arriving URL is never re-pointed to a window its sender did not choose.
 */
export function useClaimFollowsHorizon({
  horizon,
  horizonLoading,
  horizonChangeCount,
  claimId,
  hasClaim,
  rewriteClaim,
}: UseClaimFollowsHorizonOptions): void {
  const settled = useRef<{ horizon: HorizonKey; changeCount: number } | null>(null);
  useEffect(() => {
    if (horizonLoading) return;
    const prev = settled.current;
    settled.current = { horizon, changeCount: horizonChangeCount };
    if (prev == null || prev.changeCount === horizonChangeCount) return;
    const before = prev.horizon;
    if (before === horizon || claimId == null) return;
    const suffix = `:${before}`;
    if (!claimId.endsWith(suffix)) return;
    const candidate = `${claimId.slice(0, -suffix.length)}:${horizon}`;
    if (hasClaim(candidate)) rewriteClaim(candidate);
  }, [horizon, horizonLoading, horizonChangeCount, claimId, hasClaim, rewriteClaim]);
}

/**
 * The URL writer `useClaimFollowsHorizon` needs, shared by every host: sets
 * `claim=` in place, keeping the pathname (so `/coach/:clientId/*` and
 * `/workspace/:tenantId/*` prefixes survive) and every other param.
 * `replace`, and no hash — the user is at the control they pressed, not at
 * the terminus.
 */
export function useUrlClaimRewriter(): (next: string) => void {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      params.set(DRILL_DOWN_CLAIM_PARAM, next);
      const search = params.toString();
      navigate(
        { pathname: location.pathname, search: search ? `?${search}` : '' },
        { replace: true },
      );
    },
    [searchParams, navigate, location.pathname],
  );
}
