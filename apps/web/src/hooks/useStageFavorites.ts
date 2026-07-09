import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertStageFavoritesInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const stageFavoritesQueryKey = ['stageFavorites'] as const;

/**
 * GET /api/stage-favorites — the signed-in user's favorited stages, pinned
 * to the top of every stage picker. The API always returns a value (an empty
 * list when nothing's been favorited yet), so callers never need to handle a
 * missing-favorites case themselves.
 */
export function useStageFavorites() {
  const { user } = useAuth();
  return useQuery({
    queryKey: stageFavoritesQueryKey,
    queryFn: () => api.stageFavorites.get(),
    enabled: Boolean(user),
  });
}

/** PUT /api/stage-favorites — replaces the whole list. Invalidates the favorites query on success. */
export function useUpdateStageFavorites() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertStageFavoritesInput) => api.stageFavorites.update(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: stageFavoritesQueryKey });
    },
  });
}
