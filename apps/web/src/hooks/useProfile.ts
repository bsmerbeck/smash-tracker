import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const profileQueryKey = ['profile'] as const;

/** GET /api/users/me — the signed-in user's profile (email + fighter selections). */
export function useProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: profileQueryKey,
    queryFn: () => api.users.getMe(),
    enabled: Boolean(user),
  });
}

/**
 * PUT /api/users/me — updates just `coachingModeEnabled` (Phase 11
 * walkthrough fix round 1, FB-3: the Profile > Account "Enable coaching
 * mode" toggle). NOT subject-scoped — this is always the coach's own
 * personal-account preference, mirroring `useProfile()`/`profileQueryKey`
 * itself, never `useActiveSubject()`/`subjectScope()`. Refetches the
 * profile on success so the Topbar's gate reflects the change immediately.
 */
export function useUpdateCoachingModeEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (coachingModeEnabled: boolean) => api.users.upsertMe({ coachingModeEnabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profileQueryKey });
    },
  });
}
