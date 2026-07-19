import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/** TEN-04: subject-scoped so Personal/Client A/Client B fighter selections never share a cache entry. */
export function fightersQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'fighters'] as const;
}

/** GET /api/users/me/fighters — the active subject's primary/secondary selections. */
export function useFighters() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: fightersQueryKey(subject),
    queryFn: () => api.users.getFighters(),
    enabled: Boolean(user),
  });
}
