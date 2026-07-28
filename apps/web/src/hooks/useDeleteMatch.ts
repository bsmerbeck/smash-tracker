import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEffectiveSubject } from './useEffectiveSubject';
import { matchesQueryKey } from './useMatches';
import { vodSharesQueryKey } from './useVodShares';

/**
 * DELETE /api/matches/:id. Invalidates matches.
 *
 * FB-05: also invalidates `vodSharesQueryKey` — the server cascade-revokes
 * any share links attached to this match's VOD (Plan 03), so the owner's My
 * Shares list must refetch too, without a manual page refresh.
 *
 * Quick 260726-r8: uses `useEffectiveSubject()`, not `useActiveSubject()` —
 * see `useCreateMatch`'s doc comment for the claimed-workspace rationale.
 * (Not in the original bug-report hook list, but same defect — found during
 * this quick's audit.)
 */
export function useDeleteMatch() {
  const queryClient = useQueryClient();
  const subject = useEffectiveSubject();
  return useMutation({
    mutationFn: (id: string) => api.matches.remove(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: vodSharesQueryKey }),
      ]);
    },
  });
}
