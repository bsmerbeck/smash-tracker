import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/**
 * TEN-04: GET /api/opponents is one of the resolveSubject-covered routes
 * (Plan 11-02) — its cache key must be subject-scoped for the same reason
 * `matchesQueryKey` is, so a coaching-mode create/update never invalidates
 * (or reads) the coach's personal opponent list.
 */
export function opponentsQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'opponents'] as const;
}

/** GET /api/opponents — known opponent names for the active subject. */
export function useOpponents() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: opponentsQueryKey(subject),
    queryFn: () => api.opponents.list(),
    enabled: Boolean(user),
  });
}
