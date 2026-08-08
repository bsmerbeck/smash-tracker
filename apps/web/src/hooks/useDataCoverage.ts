import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ResearchCoverageResponse } from '@smash-tracker/shared';
import { api, ApiError } from '@/lib/api';
import { useEffectiveSubject } from './useEffectiveSubject';
import { useResearchSubject } from './useResearchSubject';

/**
 * Phase 30 (start.gg Lossless Ingestion & Four-Player Coverage Audit,
 * ING-04/ING-05/WKSP-01A, plan 30-06): the ONE browser-side source of truth
 * for the tenant's data-completeness snapshot, consumed by
 * `DataCoveragePanel`. Modeled member-for-member on `useResearchSubject`.
 *
 * The active tenant comes from `useEffectiveSubject()` — not
 * `useActiveSubject()` alone — because the parallel `/workspace/:tenantId`
 * owned-workspace route family exists too, and `useResearchSubject`'s own
 * doc comment records why a hook scoped to one family leaves the other
 * silently unhandled. This HOOK is therefore subject-family agnostic and
 * would work correctly on either family. The PANEL that consumes it (Task 2)
 * is mounted only in the coach-side `ClientWorkspaceLayout`, because the
 * owned `/workspace/:tenantId` family renders through a separate layout
 * (`apps/web/src/routes/AppRouter.tsx` lines 484-492). That is acceptable
 * for this phase — the four research tenants are unclaimed, so no owner ever
 * reaches the owned family for them — but this is a scope statement, not a
 * two-family rendering claim (review C-M9). Mounting on the owned family is
 * a later phase's decision, made when a research tenant can actually be
 * claimed.
 *
 * The query is enabled ONLY when a client id is resolved AND
 * `useResearchSubject().isResearch` is true — never on an ordinary
 * workspace, never while the kind lookup is pending, and never after the
 * kind lookup has failed. `isResearch` on the returned object always mirrors
 * `useResearchSubject().isResearch` regardless of this hook's own query
 * state, so a caller can always tell whether the underlying workspace is a
 * research tenant even before (or if never) a coverage request resolves.
 *
 * A 404 from the coverage route means "not for you" — the research family's
 * uniform rejection posture for a caller who is not an allowlisted admin
 * AND a member of the tenant — and is mapped to `isForbidden: true`,
 * `isError: false`: a normal, silent outcome, never an error to display.
 * Every other failure sets `isError: true`, `isForbidden: false`.
 *
 * The response's `coverage` member is `null` until a backfill run has
 * actually completed — a first-class state (`hasCompletedRun: false`), never
 * an empty result to be confused with zero counts (D-15).
 *
 * The returned object is memoized on its primitive members plus a
 * `useCallback`-stabilized `retry`, so its identity is stable across renders
 * when the underlying state hasn't changed — mirrors `useResearchSubject`'s
 * own no-churn discipline.
 */
export interface DataCoverageStatus {
  isResearch: boolean;
  isPending: boolean;
  isError: boolean;
  isForbidden: boolean;
  hasCompletedRun: boolean;
  data: ResearchCoverageResponse | null;
  retry: () => void;
}

export function dataCoverageQueryKey(clientId: string) {
  return ['research-coverage', clientId] as const;
}

export function useDataCoverage(): DataCoverageStatus {
  const { clientId } = useEffectiveSubject();
  const { isResearch } = useResearchSubject();
  const enabled = clientId != null && isResearch;

  const query = useQuery({
    queryKey: dataCoverageQueryKey(clientId ?? ''),
    queryFn: () => api.research.coverage(clientId!),
    enabled,
  });

  const retry = useCallback(() => {
    void query.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `query.refetch` is TanStack Query's own stable reference for a given queryKey; re-deriving it on every query object change would defeat the point of memoizing `retry`.
  }, [query.refetch]);

  return useMemo(() => {
    if (!enabled) {
      return {
        isResearch,
        isPending: false,
        isError: false,
        isForbidden: false,
        hasCompletedRun: false,
        data: null,
        retry,
      };
    }
    if (query.isPending) {
      return {
        isResearch,
        isPending: true,
        isError: false,
        isForbidden: false,
        hasCompletedRun: false,
        data: null,
        retry,
      };
    }
    if (query.isError) {
      const isForbidden = query.error instanceof ApiError && query.error.status === 404;
      return {
        isResearch,
        isPending: false,
        isError: !isForbidden,
        isForbidden,
        hasCompletedRun: false,
        data: null,
        retry,
      };
    }
    const data = query.data ?? null;
    return {
      isResearch,
      isPending: false,
      isError: false,
      isForbidden: false,
      hasCompletedRun: data?.coverage != null,
      data,
      retry,
    };
  }, [enabled, isResearch, query.isPending, query.isError, query.error, query.data, retry]);
}
