import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TierWord } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { tournamentEntriesQueryKey } from './useTournamentEntries';

/**
 * PATCH /api/tournaments/:entryKey/tier (TIER-04, D-15). `{ tier }` sets the
 * per-event override; `null` clears it. Invalidates exactly
 * `tournamentEntriesQueryKey` on success — the entry list is where the stored
 * override is read from, and `TournamentDetailPage` resolves the tier from it.
 *
 * `tournamentEntriesQueryKey` is deliberately bare and unwrapped by subject,
 * for the reason `useRulesetOverride` gives: `tournamentEntries/{uid}` is a
 * uid-keyed tree and Tournaments is own-account-only (38 D-04, 39.2 D-17), so
 * subject-wrapping the key would let a coach-workspace route address another
 * subject's entries. A test asserts the invalidated KEY, not merely that an
 * invalidation happened.
 */
export function useTierOverride(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tierOverride: { tier: TierWord } | null) =>
      api.tournaments.setTierOverride(entryKey, tierOverride),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tournamentEntriesQueryKey });
    },
  });
}
