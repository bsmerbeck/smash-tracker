import { useLocation } from 'react-router';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01/CTRL-02): the
 * client-owned workspace family's own route-derived subject. This is a
 * deliberate SIBLING of the coach side's own subject hook (owner binding
 * decision, Area 4.1 of `24-CONTEXT.md`), never an extension of it — that
 * hook is hard-coded to the `/coach` prefix and a `clientId` route param,
 * and unifying the two subject-resolution mechanisms is explicitly deferred
 * until the client-owned workflow is proven stable. Derived purely from the
 * route (`useLocation`) — no context, no module state — the same
 * reload/Back/deep-link-safe discipline the coach hook follows.
 *
 * Phase 29 Plan 12 (RTEN-04, T-29-12): parses `tenantId` from
 * `location.pathname` directly rather than `useParams()`, mirroring
 * `useActiveSubject.ts`'s own fix and for the identical reason — this
 * hook's router-root consumers (via `useEffectiveSubject`, consumed by
 * `RouteAnalytics`/`ResearchTelemetrySuppression`) sit outside the matched
 * `<Route>`'s `RouteContext`, where `useParams()` always resolves empty.
 */
export interface OwnedWorkspaceSubject {
  tenantId: string | null;
}

const WORKSPACE_TENANT_ID_PATTERN = /^\/workspace\/([^/]+)/;

export function useOwnedWorkspaceSubject(): OwnedWorkspaceSubject {
  const location = useLocation();
  const match = WORKSPACE_TENANT_ID_PATTERN.exec(location.pathname);
  return {
    tenantId: match ? decodeURIComponent(match[1]!) : null,
  };
}
