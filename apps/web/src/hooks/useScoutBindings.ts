import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrepScoutBindingConfirmRequest } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';
import { prepBriefQueryKey } from './usePrepBrief';

export function prepBindingCandidatesQueryKey(entryKey: string, name: string) {
  return ['prepBindingCandidates', entryKey, name] as const;
}

/**
 * GET .../binding-candidates (Phase 27, RPT-01) — deliberately disabled by
 * default (`options.enabled` defaults to `false`): a brief can carry a
 * dozen curated opponents, and this candidate list is only useful while
 * that specific opponent's confirmation flow is open, so the caller opts
 * in per-opponent rather than every row fanning out a request on mount.
 */
export function usePrepBindingCandidates(
  entryKey: string | undefined,
  name: string | undefined,
  options?: { enabled?: boolean },
) {
  const { user } = useAuth();
  return useQuery({
    queryKey: prepBindingCandidatesQueryKey(entryKey ?? '', name ?? ''),
    queryFn: () => api.prep.bindingCandidates(entryKey as string, name as string),
    enabled: Boolean(user) && Boolean(entryKey) && Boolean(name) && (options?.enabled ?? false),
  });
}

/**
 * PUT .../binding (Phase 27, RPT-01) — confirms a curated opponent's scout
 * binding. Invalidates `prepBriefQueryKey(entryKey)` (the existing prep
 * mutation convention, `usePrepBrief.ts`) so the brief's `scoutBindings` map
 * — and therefore report-ready state — updates without a reload. No charge
 * and no model call happen server-side, so no billing query needs
 * invalidating here.
 */
export function useConfirmScoutBinding(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, input }: { name: string; input: PrepScoutBindingConfirmRequest }) =>
      api.prep.confirmBinding(entryKey, name, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}

/**
 * DELETE .../binding (Phase 27, RPT-01) — clears a curated opponent's scout
 * binding. Same invalidation as `useConfirmScoutBinding` above.
 */
export function useClearScoutBinding(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.prep.clearBinding(entryKey, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}
