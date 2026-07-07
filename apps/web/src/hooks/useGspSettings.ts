import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertGspSettingsInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const gspSettingsQueryKey = ['gspSettings'] as const;

/**
 * GET /api/gsp-settings — the signed-in user's Elite Smash threshold (V10).
 * The API always returns a value (synthesizing `DEFAULT_ELITE_THRESHOLD`
 * when the user hasn't saved one yet), so callers never need to handle a
 * missing-settings case themselves.
 */
export function useGspSettings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: gspSettingsQueryKey,
    queryFn: () => api.gspSettings.get(),
    enabled: Boolean(user),
  });
}

/** PUT /api/gsp-settings. Invalidates the settings query on success. */
export function useUpdateGspSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertGspSettingsInput) => api.gspSettings.update(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gspSettingsQueryKey });
    },
  });
}
