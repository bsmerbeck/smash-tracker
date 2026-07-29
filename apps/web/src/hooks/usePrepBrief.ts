import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrepChecklistItemId } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * `prepBriefs/{uid}/{entryKey}` is keyed on the authenticated uid exactly
 * like `tournamentEntries` (`useTournamentEntries`'s bare `['tournaments']`
 * key) — there is no client/tenant dimension to scope by, so this key is
 * deliberately bare, unlike the subject-aware wrapping `useOpponentAliases`
 * applies to its own key. Adding that wrapping here would let a
 * coach-workspace route accidentally address a different subject's
 * prep-brief tree (RESEARCH Pitfall 5).
 */
export function prepBriefQueryKey(entryKey: string) {
  return ['prep', entryKey] as const;
}

/**
 * GET /api/prep/:entryKey — a pure read, safe to call on every render of an
 * entry's detail/prep page (D-12). Disabled while signed out or while
 * `entryKey` is unknown.
 */
export function usePrepBrief(entryKey: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: prepBriefQueryKey(entryKey ?? ''),
    queryFn: () => api.prep.get(entryKey!),
    enabled: Boolean(user) && Boolean(entryKey),
  });
}

/**
 * POST /api/prep/:entryKey/activate. Invalidates exactly `['prep', entryKey]`
 * — never the tournaments list, which does not change when a brief is
 * activated.
 */
export function useActivatePrepBrief(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.prep.activate(entryKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}

/**
 * POST /api/prep/:entryKey/open. The caller-supplied `openId` (one stable id
 * per logical page mount) is passed straight through to `api.prep.open` so
 * transport retries of the same logical open dedupe server-side (D-08).
 */
export function useReopenPrepBrief(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (openId: string) => api.prep.open(entryKey, { openId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}

/** PUT /api/prep/:entryKey/checklist/:itemId. */
export function useTogglePrepChecklistItem(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, checked }: { itemId: PrepChecklistItemId; checked: boolean }) =>
      api.prep.setChecklistItem(entryKey, itemId, { checked }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}

/** PUT /api/prep/:entryKey/opponents/:name. */
export function useAddLikelyOpponent(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.prep.addLikelyOpponent(entryKey, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}

/** DELETE /api/prep/:entryKey/opponents/:name. */
export function useRemoveLikelyOpponent(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.prep.removeLikelyOpponent(entryKey, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: prepBriefQueryKey(entryKey) });
    },
  });
}
