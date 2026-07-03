import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const matchesQueryKey = ['matches'] as const;

/** GET /api/matches — all matches for the signed-in user. */
export function useMatches() {
  const { user } = useAuth();
  return useQuery({
    queryKey: matchesQueryKey,
    queryFn: () => api.matches.list(),
    enabled: Boolean(user),
  });
}
