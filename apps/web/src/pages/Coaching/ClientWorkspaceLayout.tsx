import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { useResearchSubject } from '@/hooks/useResearchSubject';
import { setActiveSubject } from '@/lib/subjectQueryKey';
import { ResearchSnapshotBanner } from './components/ResearchSnapshotBanner';

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
 *
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-02, D-03,
 * revised D-20): `<ResearchSnapshotBanner />` is mounted exactly once,
 * immediately above the outlet, HERE rather than per page — a page added
 * later cannot omit the label because it never opts into rendering it in
 * the first place. The outlet itself is withheld until `useResearchSubject`
 * resolves: while pending, the app's existing generic loading affordance
 * renders instead; on a failed kind lookup, a localized error affordance
 * with a retry control renders instead — no workspace surface can ever
 * render page content before its tenant kind is known, and a failed lookup
 * can never fall through to an unlabeled, ordinary-looking workspace or an
 * indefinite spinner. The chrome ABOVE this layout — the Topbar's client
 * chip and the Sidebar's client identity block, both rendered by
 * `MainLayout` outside and around this component's own subtree — is
 * handled separately (`Topbar.tsx`/`SidebarContent.tsx`) because this
 * layout structurally cannot reach it.
 */
export function ClientWorkspaceLayout() {
  const subject = useActiveSubject();
  const { isPending, isError, retry } = useResearchSubject();
  const { t } = useTranslation();

  useEffect(() => {
    setActiveSubject(subject);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `subject` is a fresh object every render (useActiveSubject has no memo); keying on its primitive fields avoids re-running this effect every render
  }, [subject.mode, subject.clientId]);

  return (
    <>
      <ResearchSnapshotBanner />
      {isPending && <div className="text-muted-foreground">{t('chrome.loading')}</div>}
      {isError && (
        <div
          data-testid="research-kind-load-error"
          className="flex flex-col items-center gap-3 rounded-lg border p-16 text-center"
        >
          <CircleAlert className="size-8 text-destructive" />
          <h2 className="text-lg font-semibold">{t('coaching.research.error.title')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t('coaching.research.error.body')}
          </p>
          <Button variant="outline" onClick={retry}>
            {t('coaching.research.error.retry')}
          </Button>
        </div>
      )}
      {!isPending && !isError && <Outlet />}
    </>
  );
}
