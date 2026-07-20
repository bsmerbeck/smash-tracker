import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CombineWithLookup, ScoutSource } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { onboardingProgressQueryKey } from '@/hooks/useOnboardingProgress';

export interface ScoutPlayerInput {
  query: string;
  /** V9-B Feature 4: which site to resolve a bare tag/slug/id against; a pasted parry.gg profile URL auto-detects server-side regardless of this. */
  source?: ScoutSource;
  /** V13: an additional lookup on the OTHER site to merge into one combined scout. */
  combineWith?: CombineWithLookup;
}

/**
 * POST /api/scout — runs on submit (not auto-fetched like the rest of the
 * app's queries), since it's a user-initiated lookup of a third-party
 * player's public tournament-site history rather than data tied to the
 * signed-in account. A `useMutation` gives the Scout page
 * `isPending`/`error`/`data` without needing a query key for the lookup
 * itself (the server already caches per player id/source, see
 * startgg/scout.ts and parrygg/scout.ts). Phase 13 (ONBD-04, D-04): a
 * successful lookup fires `scout_activated` server-side (13-04), so this
 * DOES invalidate `onboardingProgressQueryKey` on success.
 */
export function useScoutPlayer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScoutPlayerInput) => api.scout.lookup(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: onboardingProgressQueryKey });
    },
  });
}
