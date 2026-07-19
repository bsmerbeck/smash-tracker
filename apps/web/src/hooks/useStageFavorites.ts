import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { StageFavorites, UpsertStageFavoritesInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/** TEN-04: subject-scoped so Personal/Client A/Client B favorited stages never share a cache entry. */
export function stageFavoritesQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'stageFavorites'] as const;
}

/**
 * GET /api/stage-favorites — the active subject's favorited stages, pinned
 * to the top of every stage picker. The API always returns a value (an empty
 * list when nothing's been favorited yet), so callers never need to handle a
 * missing-favorites case themselves.
 */
export function useStageFavorites() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: stageFavoritesQueryKey(subject),
    queryFn: () => api.stageFavorites.get(),
    enabled: Boolean(user),
  });
}

/**
 * PUT /api/stage-favorites — replaces the whole list, applied optimistically.
 * The optimism matters for the in-picker heart toggles: the heart (and the
 * pinned Favorites group) must move on tap, not after the PUT round-trip,
 * and each rapid successive toggle must read the already-updated cache
 * instead of a stale list — with a whole-list PUT, a stale read would drop
 * the previous toggle. Rolls back on error; refetches server truth either way.
 */
export function useUpdateStageFavorites() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  const queryKey = stageFavoritesQueryKey(subject);
  return useMutation({
    mutationFn: (input: UpsertStageFavoritesInput) => api.stageFavorites.update(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<StageFavorites>(queryKey);
      queryClient.setQueryData<StageFavorites>(queryKey, {
        stageIds: input.stageIds,
        // Placeholder until the settle-time refetch brings the server stamp.
        updatedAt: Date.now(),
      });
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Favorite/unfavorite a single stage — what the heart buttons inside stage
 * pickers call. No-ops until the favorites query has loaded: toggling against
 * an unloaded list would PUT a near-empty replacement over the saved one.
 */
export function useToggleStageFavorite() {
  const { t } = useTranslation();
  const { data: favorites } = useStageFavorites();
  const update = useUpdateStageFavorites();
  return (stageId: number) => {
    if (!favorites) return;
    const next = favorites.stageIds.includes(stageId)
      ? favorites.stageIds.filter((id) => id !== stageId)
      : [...favorites.stageIds, stageId];
    update.mutate(
      { stageIds: next },
      { onError: () => toast.error(t('matchForm.favoriteSaveFailed')) },
    );
  };
}
