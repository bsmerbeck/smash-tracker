import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';
import { coachingClientsQueryKey } from './useCoachingClients';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01/CTRL-02):
 * client-owner-facing hooks, wrapping `api.clientWorkspaces.*`
 * (`apps/web/src/lib/api.ts`). Like `useCoachingClients` (and unlike
 * `useMatches`/`usePlaylists`/etc, which are keyed by the active-subject
 * scoping helper and the `X-Active-Subject` header), this lists a
 * personal-account read of "which workspaces do I own" performed by the
 * signed-in client themselves — no active-subject scoping applies.
 */
export const clientWorkspacesQueryKey = ['client-workspaces'] as const;

/** GET /api/client-workspaces — the signed-in user's own owned (claimed) workspaces. */
export function useClientWorkspaces() {
  const { user } = useAuth();
  return useQuery({
    queryKey: clientWorkspacesQueryKey,
    queryFn: () => api.clientWorkspaces.list(),
    enabled: Boolean(user),
  });
}

/**
 * DELETE .../delegations/:delegateUid — the client revokes their claimed
 * workspace's delegated coach immediately. A stale "coach still has access"
 * row after revoke is a real UX-level information-disclosure risk (T-24-13),
 * so this invalidates `clientWorkspacesQueryKey` on success.
 */
export function useRevokeCoachDelegation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, delegateUid }: { tenantId: string; delegateUid: string }) =>
      api.clientWorkspaces.revokeDelegation(tenantId, delegateUid),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: clientWorkspacesQueryKey });
    },
  });
}

/**
 * Quick 260726-r6: `DELETE /api/coaching/clients/:tenantId` — the OWNER's
 * irreversible hard-delete of their own claimed workspace (reuses the same
 * cascade `useDeleteCoachingClient` triggers on the coach side, per
 * `apps/web/src/lib/api.ts`'s `clientWorkspaces.deleteWorkspace` doc
 * comment). Invalidates BOTH `clientWorkspacesQueryKey` (this owner's own
 * "which workspaces do I own" list) and `coachingClientsQueryKey` (the
 * delegated coach's Client Hub listing) — the same tenantId can be cached
 * under either identity depending on which role most recently queried it on
 * this device, and a stale "still exists" row in either cache after a
 * confirmed hard-delete is the same class of risk `useRevokeCoachDelegation`
 * guards against above.
 */
export function useDeleteOwnedWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) => api.clientWorkspaces.deleteWorkspace(tenantId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: clientWorkspacesQueryKey }),
        queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey }),
      ]);
    },
  });
}
