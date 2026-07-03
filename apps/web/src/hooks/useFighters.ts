import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const fightersQueryKey = ['fighters'] as const;

/** GET /api/users/me/fighters — the signed-in user's primary/secondary selections. */
export function useFighters() {
  const { user } = useAuth();
  return useQuery({
    queryKey: fightersQueryKey,
    queryFn: () => api.users.getFighters(),
    enabled: Boolean(user),
  });
}
