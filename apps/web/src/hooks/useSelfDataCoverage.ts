import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ResearchCoverageResponse } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * Phase 30.1 Plan 05 (WKSP-01A, review H5/C2-H2, T-30.1-12): the self-only
 * counterpart to `useDataCoverage` — the ONE browser-side source of truth
 * for the LOGGED-IN ACCOUNT's own migrated completeness report, consumed by
 * `SelfDataCoveragePanel`.
 *
 * Unlike `useDataCoverage` (research-tenant-scoped, gated on
 * `useResearchSubject().isResearch`), this hook is enabled for ANY
 * authenticated user — no tenant, no kind lookup, no admin gate — because
 * `GET /api/users/me/coverage` accepts no subject parameter and always
 * resolves the caller's own `request.uid` server-side. An ordinary account
 * with no migrated research data gets the benign empty shape
 * (`coverage: null`), which is the normal/expected steady state, not an
 * error.
 *
 * `hasCompletedRun` mirrors `useDataCoverage`'s own derivation
 * (`data?.coverage != null`) so the two hooks stay behaviorally identical
 * on the one thing that matters to the shared `DataCoveragePanelView`.
 */
export interface SelfDataCoverageStatus {
  isPending: boolean;
  isError: boolean;
  hasCompletedRun: boolean;
  data: ResearchCoverageResponse | null;
}

export const SELF_COVERAGE_QUERY_KEY = ['self-coverage'] as const;

export function useSelfDataCoverage(): SelfDataCoverageStatus {
  const { user } = useAuth();
  const enabled = user != null;

  const query = useQuery({
    queryKey: SELF_COVERAGE_QUERY_KEY,
    queryFn: () => api.users.coverage(),
    enabled,
  });

  return useMemo(() => {
    if (!enabled || query.isPending) {
      return { isPending: enabled, isError: false, hasCompletedRun: false, data: null };
    }
    if (query.isError) {
      return { isPending: false, isError: true, hasCompletedRun: false, data: null };
    }
    const data = query.data ?? null;
    return {
      isPending: false,
      isError: false,
      hasCompletedRun: data?.coverage != null,
      data,
    };
  }, [enabled, query.isPending, query.isError, query.data]);
}
