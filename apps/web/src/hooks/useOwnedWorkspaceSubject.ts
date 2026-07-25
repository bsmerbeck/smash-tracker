import { useLocation, useParams } from 'react-router';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01/CTRL-02): the
 * client-owned workspace family's own route-derived subject. This is a
 * deliberate SIBLING of the coach side's own subject hook (owner binding
 * decision, Area 4.1 of `24-CONTEXT.md`), never an extension of it — that
 * hook is hard-coded to the `/coach` prefix and a `clientId` route param,
 * and unifying the two subject-resolution mechanisms is explicitly deferred
 * until the client-owned workflow is proven stable. Derived purely from the
 * route (`useLocation`/`useParams`) — no context, no module state — the same
 * reload/Back/deep-link-safe discipline the coach hook follows.
 */
export interface OwnedWorkspaceSubject {
  tenantId: string | null;
}

export function useOwnedWorkspaceSubject(): OwnedWorkspaceSubject {
  const location = useLocation();
  const { tenantId } = useParams<{ tenantId?: string }>();
  const isOwnedWorkspaceRoute = location.pathname.startsWith('/workspace/');
  return {
    tenantId: isOwnedWorkspaceRoute && tenantId ? tenantId : null,
  };
}
