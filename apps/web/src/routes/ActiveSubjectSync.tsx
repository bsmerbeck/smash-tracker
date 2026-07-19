import { useEffect } from 'react';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { setActiveSubject } from '@/lib/subjectQueryKey';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-04/TEN-07): keeps
 * the module-level active-subject store (`apps/web/src/lib/
 * subjectQueryKey.ts`) in sync with the route on EVERY navigation, mounted
 * once at the router root — mirrors `RouteTitles`/`RouteAnalytics`'s
 * existing "route-observer" pattern (a `null`-rendering component that only
 * runs a location-keyed effect).
 *
 * Without this, `ClientWorkspaceLayout`'s own `setActiveSubject` call would
 * be the ONLY place the header gets set — correct on entering the workspace,
 * but with nothing to reset it back to 'personal' the moment a coach
 * navigates OUT of `/coach/:clientId/*` (that layout unmounts before it can
 * observe its own exit). Left uncorrected, the `X-Active-Subject` header
 * would stay pinned to the last client, silently scoping the coach's own
 * PERSONAL reads/writes to that client's tenant — a direct TEN-04
 * violation. This component is the single source of truth for the header
 * across every route, coaching or personal.
 */
export function ActiveSubjectSync() {
  const subject = useActiveSubject();
  useEffect(() => {
    setActiveSubject(subject);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `subject` is a fresh object every render (useActiveSubject has no memo); keying on its primitive fields avoids re-running this effect every render
  }, [subject.mode, subject.clientId]);
  return null;
}
