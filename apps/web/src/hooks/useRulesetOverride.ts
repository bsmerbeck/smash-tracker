import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RulesetOverrideStored } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { tournamentEntriesQueryKey } from './useTournamentEntries';

/**
 * PATCH /api/tournaments/:entryKey/ruleset (EVID-04, D-10). Invalidates
 * exactly `tournamentEntriesQueryKey` on success — the entry list is where
 * the resolved override is read from (`RulesetOverrideSection` calls
 * `resolveRuleset(entry.rulesetOverride)`).
 *
 * `tournamentEntriesQueryKey` is deliberately bare and unwrapped by subject,
 * for the same reason `usePrepBrief`'s doc comment gives for its own
 * uid-keyed tree: this is a uid-keyed tree (`tournamentEntries/{uid}/...`),
 * and subject-wrapping it would let a coach-workspace route accidentally
 * address a different subject's tournament entries — D-18 keeps Tournaments
 * own-account-only this phase, and this hook's key shape is part of what
 * enforces that on the client.
 */
export function useRulesetOverride(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rulesetOverride: RulesetOverrideStored | null) =>
      api.tournaments.setRulesetOverride(entryKey, rulesetOverride),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tournamentEntriesQueryKey });
    },
  });
}
