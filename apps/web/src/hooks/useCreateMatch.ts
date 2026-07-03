import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateMatchInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { matchesQueryKey } from './useMatches';
import { opponentsQueryKey } from './useOpponents';

/** POST /api/matches. Invalidates matches + opponents (a new match can introduce a new opponent name). */
export function useCreateMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMatchInput) => api.matches.create(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey }),
        queryClient.invalidateQueries({ queryKey: opponentsQueryKey }),
      ]);
    },
  });
}
