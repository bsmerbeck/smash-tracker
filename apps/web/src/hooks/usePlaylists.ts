import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePlaylistInput, UpdatePlaylistInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const playlistsQueryKey = ['playlists'] as const;

/** GET /api/playlists — the signed-in user's playlists. */
export function usePlaylists() {
  const { user } = useAuth();
  return useQuery({
    queryKey: playlistsQueryKey,
    queryFn: () => api.playlists.list(),
    enabled: Boolean(user),
  });
}

/** POST /api/playlists. Invalidates the playlists query on success. */
export function useCreatePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlaylistInput) => api.playlists.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: playlistsQueryKey });
    },
  });
}

/**
 * PATCH /api/playlists/:id. Serves BOTH rename and reorder — `input` may
 * carry `name`, `matchIds`, or both (see `updatePlaylistInputSchema`).
 * Invalidates the playlists query on success.
 */
export function useUpdatePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePlaylistInput }) =>
      api.playlists.update(id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: playlistsQueryKey });
    },
  });
}

/** DELETE /api/playlists/:id. Invalidates the playlists query on success. */
export function useDeletePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.playlists.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: playlistsQueryKey });
    },
  });
}
