import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useOwnedWorkspaceSubject } from '@/hooks/useOwnedWorkspaceSubject';
import { setActiveSubject } from '@/lib/subjectQueryKey';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the
 * `/workspace/:tenantId` layout route. Renders `<Outlet />` for the nested
 * pages — the module-level active-subject store and the `X-Active-Subject`
 * header derivation (`apps/web/src/lib/subjectQueryKey.ts`) are genuinely
 * role-blind and ARE shared with the coach side; only the coach's own
 * route-matching subject hook (hard-coded to the `/coach` prefix) is not —
 * this layout uses its own sibling `useOwnedWorkspaceSubject()` instead,
 * never the coach hook.
 *
 * **The effect's cleanup is load-bearing, not tidiness.** Because this route
 * family lives outside `/coach`, `useOwnedWorkspaceSubject()` — and
 * therefore the coach's own subject hook, which `ActiveSubjectSync` reads —
 * reports `mode: 'personal'` / `clientId: null` both INSIDE and OUTSIDE this
 * family.
 * `ActiveSubjectSync` only re-syncs the header when those values change, so
 * it never observes entering or leaving `/workspace/:tenantId/*`. Without an
 * explicit reset here, leaving the family for a personal route would leave
 * the `X-Active-Subject` header pinned to `client:{tenantId}`, silently
 * scoping the owner's own personal reads/writes to the claimed tenant — the
 * same TEN-04 class of bug `ActiveSubjectSync` exists to prevent for the
 * coach side. This layout is the only component that can observe its own
 * unmount, so the cleanup here is the sole place this can be corrected.
 */
export function ClientOwnedWorkspaceLayout() {
  const { tenantId } = useOwnedWorkspaceSubject();

  useEffect(() => {
    setActiveSubject({ mode: 'personal', clientId: tenantId });
    return () => {
      setActiveSubject({ mode: 'personal', clientId: null });
    };
  }, [tenantId]);

  return <Outlet />;
}
