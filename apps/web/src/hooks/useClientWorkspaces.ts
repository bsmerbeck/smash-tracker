import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

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
