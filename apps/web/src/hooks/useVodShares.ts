import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkShareRequest } from '@smash-tracker/shared';
import { api, type CreateShareRequest } from '@/lib/api';
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
    mutationFn: (input: CreateShareRequest) => api.vodShares.create(input),
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
 * POST /api/vod-shares/bulk (FB-03) — batch revoke or delete. ONE mutation,
 * ONE list invalidation on success, regardless of how many shareIds are
 * included — this is what makes bulk actions a single round-trip instead of
 * N sequential per-row calls.
 */
export function useBulkVodShares() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkShareRequest) => api.vodShares.bulk(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vodSharesQueryKey });
    },
  });
}

/**
 * GET /api/vod-shares/:token — anonymous read of a redacted public share
 * snapshot. Deliberately has NO `enabled: Boolean(user)` gate (unlike
 * `useVodShares` above): this is a public read for signed-out visitors,
 * not a signed-in user's own data.
 *
 * Deliberately NO `retry` override: the app-wide default predicate
 * (`shouldRetryQuery` in queryClient.ts) already never retries a 4xx —
 * so a 404 (unknown/revoked token, identical body either way per the
 * API's no-oracle guarantee) still fails immediately to the unavailable
 * page — while network blips and 5xx keep the normal retry budget. A
 * blanket `retry: false` here previously made ShareViewPage tell a
 * recipient on a flaky connection that the share was permanently gone.
 */
export function usePublicVodShare(token: string) {
  return useQuery({
    queryKey: ['vod-shares', 'public', token] as const,
    queryFn: () => api.vodShares.getPublic(token),
  });
}
