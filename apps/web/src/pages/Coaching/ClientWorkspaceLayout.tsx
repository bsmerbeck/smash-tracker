import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { setActiveSubject } from '@/lib/subjectQueryKey';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-07): the
 * `/coach/:clientId` layout route. Renders `<Outlet />` for the nested
 * pages — Overview/Fighters (fix round 2) plus the SAME Dashboard/
 * FighterAnalysis/Matchups/MatchData/VodManager components the personal
 * `/dashboard` etc. routes use, imported unchanged (PAR-01/02/03). The
 * GSP/integrations/reports routes are non-parity capabilities (PAR-04) that
 * redirect straight to `overview` rather than rendering any stub. The
 * Topbar (not this component) renders the client-name chip/accent border:
 * both independently derive `{ mode, clientId }` from the route via
 * `useActiveSubject()`, so no prop drilling is needed here.
 *
 * `setActiveSubject` is called here so `api.ts`'s `X-Active-Subject` header
 * is correct from this layout's very first render. The GLOBAL mechanism that
 * keeps the header correct across every navigation — including back OUT of
 * the workspace to a personal route — is `ActiveSubjectSync`
 * (apps/web/src/routes/ActiveSubjectSync.tsx), mounted once at the router
 * root: this layout unmounts the instant a coach leaves `/coach/:clientId/*`,
 * so it can never observe (or correct) that transition itself.
 */
export function ClientWorkspaceLayout() {
  const subject = useActiveSubject();

  useEffect(() => {
    setActiveSubject(subject);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `subject` is a fresh object every render (useActiveSubject has no memo); keying on its primitive fields avoids re-running this effect every render
  }, [subject.mode, subject.clientId]);

  return <Outlet />;
}
