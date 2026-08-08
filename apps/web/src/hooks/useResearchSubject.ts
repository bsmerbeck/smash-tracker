import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isResearchKind } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useEffectiveSubject } from './useEffectiveSubject';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-02, D-03,
 * review finding 29-07 HIGH/MEDIUM): the SINGLE browser-side source of
 * truth for "is the current workspace a research workspace." Consumed by
 * `ResearchSnapshotBanner`, the chrome's client chip (`Topbar.tsx`) and
 * client identity block (`SidebarContent.tsx`), `ResearchBadge`'s
 * workspace-context callers, and plan 29-09's telemetry suppression — no
 * consumer may duplicate subject tracking or re-fetch the kind itself.
 *
 * Its source is `api.coaching.clients.kind`, the authoritative per-tenant
 * endpoint plan 29-04 added (`GET /api/coaching/clients/:clientId/kind`) —
 * deliberately NEVER `useCoachingClients()`'s hub listing, which excludes
 * archived tenants by default and degrades an unresolved row's metadata for
 * a non-allowlisted caller. Neither failure mode is acceptable here: this
 * hook must answer correctly for an archived research tenant, and it must
 * never collapse a failed read into "ordinary."
 *
 * The active tenant id comes from `useEffectiveSubject()`, not
 * `useActiveSubject()` alone (review finding 29-07 MEDIUM) — the parallel
 * `/workspace/:tenantId` owned-workspace route family exists too, and a
 * hook scoped to `/coach/:clientId` only would leave it silently unlabeled.
 * Per `useActiveSubject`'s own doc-comment rule, every consumer here
 * branches on the resolved client id being non-null, never on `mode` alone.
 *
 * State mapping is exhaustive and never conflates two distinct failure
 * modes: no active tenant means all three flags are `false` and no request
 * is issued; an in-flight request means `isPending`; a successful research
 * resolution means `isResearch`; a successful ordinary resolution means
 * none of the flags are set; and a failed request means `isError` —
 * distinct from both `isPending` (an operator must not stare at a spinner
 * forever) and the "ordinary" shape (an operator must not see an unlabeled
 * research workspace because the kind lookup happened to fail). `retry`
 * re-issues the failed request.
 *
 * The returned object is memoized on its primitive members plus a
 * `useCallback`-stabilized `retry`, so its identity is stable across
 * renders when the underlying state hasn't changed — safe to place in an
 * effect dependency list, mirroring `useEffectiveSubject`'s own
 * no-churn discipline.
 */
export interface ResearchSubjectStatus {
  isResearch: boolean;
  isPending: boolean;
  isError: boolean;
  retry: () => void;
}

export function researchSubjectQueryKey(clientId: string) {
  return ['research-subject-kind', clientId] as const;
}

export function useResearchSubject(): ResearchSubjectStatus {
  const { clientId } = useEffectiveSubject();

  const query = useQuery({
    queryKey: researchSubjectQueryKey(clientId ?? ''),
    queryFn: () => api.coaching.clients.kind(clientId!),
    enabled: clientId != null,
  });

  const retry = useCallback(() => {
    void query.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `query.refetch` is TanStack Query's own stable reference for a given queryKey; re-deriving it on every query object change would defeat the point of memoizing `retry`.
  }, [query.refetch]);

  return useMemo(() => {
    if (clientId == null) {
      return { isResearch: false, isPending: false, isError: false, retry };
    }
    if (query.isError) {
      return { isResearch: false, isPending: false, isError: true, retry };
    }
    if (query.isPending) {
      return { isResearch: false, isPending: true, isError: false, retry };
    }
    return {
      isResearch: isResearchKind(query.data?.kind),
      isPending: false,
      isError: false,
      retry,
    };
  }, [clientId, query.isError, query.isPending, query.data, retry]);
}
