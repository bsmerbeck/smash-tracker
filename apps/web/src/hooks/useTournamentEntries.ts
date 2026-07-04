import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const tournamentEntriesQueryKey = ['tournaments'] as const;

/** GET /api/tournaments — the signed-in user's start.gg tournament registry. */
export function useTournamentEntries() {
  const { user } = useAuth();
  return useQuery({
    queryKey: tournamentEntriesQueryKey,
    queryFn: () => api.tournaments.list(),
    enabled: Boolean(user),
  });
}
