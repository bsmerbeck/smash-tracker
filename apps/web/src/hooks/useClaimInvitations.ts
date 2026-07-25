import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { coachingClientsQueryKey } from './useCoachingClients';
import { useAuth } from './useAuth';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, ENTRY-02/CTRL-03):
 * coach-side claim-code issue/revoke/status hooks, wrapping `api.claims.*`
 * (`apps/web/src/lib/api.ts`) — shaped exactly like the corresponding hooks
 * in `useCoachingClients.ts`.
 *
 * `useIssueClaimInvitation`'s resolved value (`{ code, expiresAt }`) carries
 * the one-and-only copy of a raw claim code. TanStack Query mutations do NOT
 * cache their result (unlike queries) — that is exactly why issuance is
 * modelled as a mutation rather than a fetch-style hook: caching it would
 * park the credential in the client cache, which cache-inspection tooling
 * and devtools can all read back out.
 *
 * Both mutations invalidate `coachingClientsQueryKey` (imported from
 * `useCoachingClients.ts`) AND the per-client claim-status key in
 * `onSuccess`, because the Client Hub's CTRL-03 badge is derived from
 * `GET /api/coaching/clients` and a stale badge after issue/revoke is
 * exactly the information-disclosure risk called out in `24-RESEARCH.md`'s
 * Security Domain (T-24-12).
 */
export function claimInvitationStatusQueryKey(clientId: string) {
  return ['claim-invitation-status', clientId] as const;
}

/** GET .../claim-invitations — the outstanding-status-only read for one client's claim code. */
export function useClaimInvitationStatus(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: claimInvitationStatusQueryKey(clientId ?? ''),
    queryFn: () => api.claims.status(clientId as string),
    enabled: Boolean(user) && Boolean(clientId),
  });
}

/**
 * POST .../claim-invitations — mints a fresh claim code, superseding any
 * outstanding one. Resolves to `{ code, expiresAt }`; the caller must hold
 * `code` in component state only.
 */
export function useIssueClaimInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) => api.claims.issue(clientId),
    onSuccess: async (_data, clientId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey }),
        queryClient.invalidateQueries({ queryKey: claimInvitationStatusQueryKey(clientId) }),
      ]);
    },
  });
}

/** DELETE .../claim-invitations — standalone revoke; idempotent when nothing is outstanding. */
export function useRevokeClaimInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) => api.claims.revoke(clientId),
    onSuccess: async (_data, clientId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey }),
        queryClient.invalidateQueries({ queryKey: claimInvitationStatusQueryKey(clientId) }),
      ]);
    },
  });
}
