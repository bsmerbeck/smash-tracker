import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateClientRequest } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-05): the compact
 * Client Hub listing — `GET /api/coaching/clients`. Deliberately NOT
 * subject-scoped (no `subjectScope()` prefix, unlike `useMatches`/
 * `usePlaylists`/etc): this lists WHICH clients a coach manages, which is
 * itself a personal-account read performed by the coach, not a client-scoped
 * read of any one client's data (mirrors `apps/api/src/routes/
 * coachingTenants.ts`'s own `request.uid`-direct routes, never
 * `request.subjectId`).
 */
export const coachingClientsQueryKey = ['coaching-clients'] as const;

/**
 * GET /api/coaching/clients — the signed-in coach's clients.
 *
 * Defaults to non-archived only (matching every existing caller). Pass
 * `{ includeArchived: true }` for the Client Hub's archived-clients toggle
 * (TEN-06 restore path) — this uses a distinct query key
 * (`[...coachingClientsQueryKey, 'all']`) so the two views cache
 * independently; both are still invalidated together by any mutation below
 * since TanStack Query's default `invalidateQueries` matches by key prefix.
 * Pass `{ enabled: false }` to skip the fetch entirely until needed (e.g.
 * only fetching the archived view once the coach actually toggles it on).
 */
export function useCoachingClients(options: { includeArchived?: boolean; enabled?: boolean } = {}) {
  const { user } = useAuth();
  const includeArchived = options.includeArchived ?? false;
  const enabled = (options.enabled ?? true) && Boolean(user);
  return useQuery({
    queryKey: includeArchived ? [...coachingClientsQueryKey, 'all'] : coachingClientsQueryKey,
    queryFn: () => api.coaching.clients.list(includeArchived),
    enabled,
  });
}

/**
 * POST /api/coaching/clients. Surfaces the server's 409 (duplicate,
 * case-insensitive label) via `ApiError` for the caller to re-prompt —
 * mirrors the v1.1 coach-display-name-uniqueness discipline. Invalidates the
 * Client Hub listing on success.
 */
export function useCreateCoachingClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateClientRequest) => api.coaching.clients.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey });
    },
  });
}

/**
 * PATCH /api/coaching/clients/:id/archive — soft archive by default, or
 * restore with `archived: false`. Invalidates the Client Hub listing on
 * success.
 */
export function useArchiveCoachingClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, archived = true }: { clientId: string; archived?: boolean }) =>
      api.coaching.clients.archive(clientId, archived),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey });
    },
  });
}

/**
 * DELETE /api/coaching/clients/:id — irreversible hard-delete cascade.
 * Invalidates the Client Hub listing on success.
 */
export function useDeleteCoachingClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) => api.coaching.clients.remove(clientId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey });
    },
  });
}
