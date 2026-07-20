import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateMatchInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useActiveSubject } from './useActiveSubject';
import { matchesQueryKey } from './useMatches';
import { opponentsQueryKey } from './useOpponents';
import { onboardingProgressQueryKey } from './useOnboardingProgress';

/**
 * POST /api/matches. Invalidates matches + opponents (a new match can
 * introduce a new opponent name). Phase 13 (ONBD-04, D-04): also
 * invalidates `onboardingProgressQueryKey` — a new personal match can cross
 * the `analytics_activated` (5 games) threshold server-side, and the pinned
 * `GuidedPathCard`/dashboard next-best-action must reflect that without a
 * manual refresh.
 */
export function useCreateMatch() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: (input: CreateMatchInput) => api.matches.create(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: matchesQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: opponentsQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: onboardingProgressQueryKey }),
      ]);
    },
  });
}
