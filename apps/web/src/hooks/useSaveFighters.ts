import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FighterSelectionInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { fightersQueryKey } from './useFighters';
import { profileQueryKey } from './useProfile';

/** PUT /api/users/me/fighters. Invalidates fighters + profile (profile embeds the selection). */
export function useSaveFighters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FighterSelectionInput) => api.users.saveFighters(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: fightersQueryKey }),
        queryClient.invalidateQueries({ queryKey: profileQueryKey }),
      ]);
    },
  });
}
