import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { matchesQueryKey } from './useMatches';
import { vodSharesQueryKey } from './useVodShares';

/**
 * DELETE /api/matches/:id. Invalidates matches.
 *
 * FB-05: also invalidates `vodSharesQueryKey` — the server cascade-revokes
 * any share links attached to this match's VOD (Plan 03), so the owner's My
 * Shares list must refetch too, without a manual page refresh.
 */
export function useDeleteMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.matches.remove(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey }),
        queryClient.invalidateQueries({ queryKey: vodSharesQueryKey }),
      ]);
    },
  });
}
