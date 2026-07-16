import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateShareInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const vodSharesQueryKey = ['vod-shares'] as const;

/** GET /api/vod-shares — the signed-in user's share links (active + revoked). */
export function useVodShares() {
  const { user } = useAuth();
  return useQuery({
    queryKey: vodSharesQueryKey,
    queryFn: () => api.vodShares.list(),
    enabled: Boolean(user),
  });
}

/** POST /api/vod-shares. Invalidates the vod-shares query on success. */
export function useCreateVodShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateShareInput) => api.vodShares.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vodSharesQueryKey });
    },
  });
}

/** POST /api/vod-shares/:id/revoke. Invalidates the vod-shares query on success. */
export function useRevokeVodShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.vodShares.revoke(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vodSharesQueryKey });
    },
  });
}
