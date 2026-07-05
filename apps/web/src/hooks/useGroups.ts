import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const groupsQueryKey = ['groups'] as const;
export const groupLeaderboardQueryKey = (groupId: string) =>
  ['groups', groupId, 'leaderboard'] as const;

/** GET /api/groups — the signed-in user's groups. */
export function useGroups() {
  const { user } = useAuth();
  return useQuery({
    queryKey: groupsQueryKey,
    queryFn: () => api.groups.list(),
    enabled: Boolean(user),
  });
}

/** POST /api/groups — create a group. Invalidates the groups list. */
export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.groups.create(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: groupsQueryKey });
    },
  });
}

/** POST /api/groups/join — join a group by invite code. Invalidates the groups list. */
export function useJoinGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.groups.join(code),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: groupsQueryKey });
    },
  });
}

/** GET /api/groups/:id/leaderboard */
export function useGroupLeaderboard(groupId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: groupLeaderboardQueryKey(groupId ?? ''),
    queryFn: () => api.groups.leaderboard(groupId!),
    enabled: Boolean(user) && groupId != null,
  });
}

/** POST /api/groups/:id/leave. Invalidates the groups list. */
export function useLeaveGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.groups.leave(groupId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: groupsQueryKey });
    },
  });
}

/** DELETE /api/groups/:id — owner only. Invalidates the groups list. */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.groups.remove(groupId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: groupsQueryKey });
    },
  });
}
