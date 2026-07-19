import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertOpponentAliasInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/** TEN-04: subject-scoped so Personal/Client A/Client B alias maps never share a cache entry. */
export function opponentAliasesQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'opponentAliases'] as const;
}

/**
 * GET /api/opponents/aliases — the active subject's alias -> canonical map.
 * Feeds `useFilteredMatches`'s `applyOpponentAliases` choke point. Per the
 * locked design, when this is loading (or the user isn't authed yet) the
 * caller should treat it as an empty map rather than gating rendering — no
 * loading flicker on every page that shows opponent names.
 */
export function useOpponentAliases() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: opponentAliasesQueryKey(subject),
    queryFn: () => api.opponents.aliases.list(),
    enabled: Boolean(user),
  });
}

/** PUT /api/opponents/aliases/:alias. Invalidates the alias map + opponents list. */
export function useUpsertOpponentAlias() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: ({ alias, input }: { alias: string; input: UpsertOpponentAliasInput }) =>
      api.opponents.aliases.upsert(alias, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opponentAliasesQueryKey(subject) });
    },
  });
}

/** DELETE /api/opponents/aliases/:alias (un-merge). Invalidates the alias map. */
export function useDeleteOpponentAlias() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: (alias: string) => api.opponents.aliases.remove(alias),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opponentAliasesQueryKey(subject) });
    },
  });
}
