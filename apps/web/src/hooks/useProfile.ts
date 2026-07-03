import { useQuery } from '@tanstack/react-query';
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
