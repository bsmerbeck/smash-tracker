import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateMatchInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useEffectiveSubject } from './useEffectiveSubject';
import { matchesQueryKey } from './useMatches';
import { opponentsQueryKey } from './useOpponents';
import { vodSharesQueryKey } from './useVodShares';
import { onboardingProgressQueryKey } from './useOnboardingProgress';

/**
 * PATCH /api/matches/:id. Invalidates matches + opponents (opponent name may
 * have changed). FB-05: also invalidates `vodSharesQueryKey` — an edit that
 * removes the VOD URL cascade-revokes the match's active review shares
 * server-side, and My Shares must reflect that without a manual refresh.
 * `vodSharesQueryKey` is NOT subject-scoped: VOD shares are hidden entirely
 * in Coaching mode this phase (CONTEXT.md), so it stays a flat personal key.
 * Phase 13 (ONBD-04, D-04): also invalidates `onboardingProgressQueryKey` —
 * attaching a `vodUrl` can cross the `vod_activated` threshold server-side.
 *
 * Quick 260726-r8: uses `useEffectiveSubject()`, not `useActiveSubject()` —
 * see `useCreateMatch`'s doc comment for the claimed-workspace rationale.
 */
export function useUpdateMatch() {
  const queryClient = useQueryClient();
  const subject = useEffectiveSubject();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMatchInput }) =>
      api.matches.update(id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: opponentsQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: vodSharesQueryKey }),
        queryClient.invalidateQueries({ queryKey: onboardingProgressQueryKey }),
      ]);
    },
  });
}
