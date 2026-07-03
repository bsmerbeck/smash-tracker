import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { matchesQueryKey } from './useMatches';

/** DELETE /api/matches/:id. Invalidates matches. */
export function useDeleteMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.matches.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: matchesQueryKey });
    },
  });
}
