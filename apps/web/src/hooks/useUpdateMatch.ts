import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateMatchInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { matchesQueryKey } from './useMatches';
import { opponentsQueryKey } from './useOpponents';

/** PATCH /api/matches/:id. Invalidates matches + opponents (opponent name may have changed). */
export function useUpdateMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMatchInput }) =>
      api.matches.update(id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey }),
        queryClient.invalidateQueries({ queryKey: opponentsQueryKey }),
      ]);
    },
  });
}
