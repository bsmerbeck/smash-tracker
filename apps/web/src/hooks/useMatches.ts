import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/**
 * TEN-04: prefixed by the active subject's scope so Personal, Client A, and
 * Client B occupy distinct cache namespaces. Exported as a function (not a
 * flat constant) because mutation hooks in OTHER files (`useCreateMatch`,
 * `useUpdateMatch`, `useDeleteMatch`, `useVodNotes`) invalidate this exact
 * key and must invalidate the SAME subject-scoped entry the active session is
 * actually reading, not a stale flat literal.
 */
export function matchesQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'matches'] as const;
}

/** GET /api/matches — all matches for the active subject. */
export function useMatches() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: matchesQueryKey(subject),
    queryFn: () => api.matches.list(),
    enabled: Boolean(user),
  });
}
