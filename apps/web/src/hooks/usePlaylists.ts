import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePlaylistInput, UpdatePlaylistInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/** TEN-04: subject-scoped so Personal/Client A/Client B playlists never share a cache entry. */
export function playlistsQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'playlists'] as const;
}

/** GET /api/playlists — the active subject's playlists. */
export function usePlaylists() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: playlistsQueryKey(subject),
    queryFn: () => api.playlists.list(),
    enabled: Boolean(user),
  });
}

/** POST /api/playlists. Invalidates the playlists query on success. */
export function useCreatePlaylist() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: (input: CreatePlaylistInput) => api.playlists.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: playlistsQueryKey(subject) });
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
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePlaylistInput }) =>
      api.playlists.update(id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: playlistsQueryKey(subject) });
    },
  });
}

/** DELETE /api/playlists/:id. Invalidates the playlists query on success. */
export function useDeletePlaylist() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: (id: string) => api.playlists.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: playlistsQueryKey(subject) });
    },
  });
}
