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

export function useDeleteVodShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.vodShares.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vodSharesQueryKey });
    },
  });
}

/**
 * GET /api/vod-shares/:token — anonymous read of a redacted public share
 * snapshot. Deliberately has NO `enabled: Boolean(user)` gate (unlike
 * `useVodShares` above): this is a public read for signed-out visitors,
 * not a signed-in user's own data. `retry: false` matches the app-wide
 * no-retry-on-4xx convention — a 404 here means the token is unknown or
 * revoked (identical body either way, per the API's no-oracle guarantee)
 * and retrying would never succeed.
 */
export function usePublicVodShare(token: string) {
  return useQuery({
    queryKey: ['vod-shares', 'public', token] as const,
    queryFn: () => api.vodShares.getPublic(token),
    retry: false,
  });
}
