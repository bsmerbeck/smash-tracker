import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResearchEnrichmentReviewQueueResponse } from '@smash-tracker/shared';
import { api, ApiError } from '@/lib/api';
import { useEffectiveSubject } from './useEffectiveSubject';
import { useResearchSubject } from './useResearchSubject';
import { dataCoverageQueryKey } from './useDataCoverage';

/**
 * Phase 30.2 Plan 11 (ENR-06): the ONE browser-side source of truth for the
 * admin review queue — every ambiguous/conflicting/unmatched Liquipedia
 * observation `research/enrichment/store.ts`'s `listEnrichmentReviewQueue`
 * selects by attachment ABSENCE, never by the observation's own stored
 * `matchingStatus`. Modeled member-for-member on `useDataCoverage`: the
 * active tenant comes from `useEffectiveSubject()` (not `useActiveSubject()`
 * alone), the query is enabled only on a resolved, research-kind subject,
 * and a 404 (the research family's uniform "not for you" rejection) maps to
 * `isForbidden: true` / `isError: false` — a normal, silent outcome, never
 * an error to display.
 */
export interface EnrichmentReviewStatus {
  isResearch: boolean;
  isPending: boolean;
  isError: boolean;
  isForbidden: boolean;
  data: ResearchEnrichmentReviewQueueResponse | null;
  retry: () => void;
}

export function enrichmentReviewQueryKey(clientId: string) {
  return ['enrichment-review', clientId] as const;
}

export function useEnrichmentReview(): EnrichmentReviewStatus {
  const { clientId } = useEffectiveSubject();
  const { isResearch } = useResearchSubject();
  const enabled = clientId != null && isResearch;

  const query = useQuery({
    queryKey: enrichmentReviewQueryKey(clientId ?? ''),
    queryFn: () => api.research.enrichmentReview(clientId!),
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
        data: null,
        retry,
      };
    }
    if (query.isPending) {
      return { isResearch, isPending: true, isError: false, isForbidden: false, data: null, retry };
    }
    if (query.isError) {
      const isForbidden = query.error instanceof ApiError && query.error.status === 404;
      return {
        isResearch,
        isPending: false,
        isError: !isForbidden,
        isForbidden,
        data: null,
        retry,
      };
    }
    return {
      isResearch,
      isPending: false,
      isError: false,
      isForbidden: false,
      data: query.data ?? null,
      retry,
    };
  }, [enabled, isResearch, query.isPending, query.isError, query.error, query.data, retry]);
}

/**
 * `POST .../enrichment/review/:observationId/confirm` — the admin's chosen
 * candidate. Invalidates BOTH the review queue (the confirmed observation
 * disappears — `store.ts`'s attachment-absence selection means it can never
 * reappear once attached) and the coverage query (the enrichment counts the
 * confirmation moves between cohorts) on success.
 */
export function useConfirmEnrichmentCandidate() {
  const { clientId } = useEffectiveSubject();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      observationId,
      targetSetId,
    }: {
      observationId: string;
      targetSetId: string;
    }) => {
      if (clientId == null) {
        return Promise.reject(new Error('no active research tenant'));
      }
      return api.research.confirmEnrichmentCandidate(clientId, observationId, targetSetId);
    },
    onSuccess: () => {
      if (clientId == null) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: enrichmentReviewQueryKey(clientId) });
      void queryClient.invalidateQueries({ queryKey: dataCoverageQueryKey(clientId) });
    },
  });
}
