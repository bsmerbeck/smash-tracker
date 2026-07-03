import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const opponentsQueryKey = ['opponents'] as const;

/** GET /api/opponents — known opponent names for the signed-in user. */
export function useOpponents() {
  const { user } = useAuth();
  return useQuery({
    queryKey: opponentsQueryKey,
    queryFn: () => api.opponents.list(),
    enabled: Boolean(user),
  });
}
