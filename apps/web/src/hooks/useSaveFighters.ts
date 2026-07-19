import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FighterSelectionInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useActiveSubject } from './useActiveSubject';
import { fightersQueryKey } from './useFighters';
import { profileQueryKey } from './useProfile';

/**
 * PUT /api/users/me/fighters. Invalidates fighters (subject-scoped, TEN-04:
 * a coaching-mode save invalidates the client's fighters cache, not
 * personal) + profile (NOT subject-scoped — `profileQueryKey` is the coach's
 * own /users/me profile, which is genuinely personal and must never be
 * subject-scoped; a coaching-mode fighters save has no effect on it).
 */
export function useSaveFighters() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: (input: FighterSelectionInput) => api.users.saveFighters(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: fightersQueryKey(subject) }),
        queryClient.invalidateQueries({ queryKey: profileQueryKey }),
      ]);
    },
  });
}
