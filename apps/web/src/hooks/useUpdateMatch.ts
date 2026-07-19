import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateMatchInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useActiveSubject } from './useActiveSubject';
import { matchesQueryKey } from './useMatches';
import { opponentsQueryKey } from './useOpponents';
import { vodSharesQueryKey } from './useVodShares';

/**
 * PATCH /api/matches/:id. Invalidates matches + opponents (opponent name may
 * have changed). FB-05: also invalidates `vodSharesQueryKey` — an edit that
 * removes the VOD URL cascade-revokes the match's active review shares
 * server-side, and My Shares must reflect that without a manual refresh.
 * `vodSharesQueryKey` is NOT subject-scoped: VOD shares are hidden entirely
 * in Coaching mode this phase (CONTEXT.md), so it stays a flat personal key.
 */
export function useUpdateMatch() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMatchInput }) =>
      api.matches.update(id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: opponentsQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: vodSharesQueryKey }),
      ]);
    },
  });
}
