import { useTranslation } from 'react-i18next';
import { useResearchSubject } from '@/hooks/useResearchSubject';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-02, D-03,
 * D-08): the ONE shared composition of the unverified-snapshot label —
 * every research-workspace surface renders THIS component, never a
 * duplicated copy of its markup. It takes no props and consumes
 * `useResearchSubject()` itself, so a page can never opt out by forgetting
 * to pass a prop.
 *
 * Mounted exactly once, at `ClientWorkspaceLayout` (`apps/web/src/pages/
 * Coaching/ClientWorkspaceLayout.tsx`), immediately above the gated
 * `<Outlet />` — every route nested under that layout renders through it,
 * so the label appears on every one of them without any page opting in.
 * `researchLabelIntegrity.test.ts` (Task 3) proves this file is imported
 * from nowhere else via a tree scan.
 *
 * Renders nothing for an ordinary workspace, while pending, on error, or
 * outside a workspace route — `ClientWorkspaceLayout` owns the
 * pending/error affordances separately (it withholds the entire outlet in
 * both cases), so this component's own job is narrow: show the label when,
 * and only when, the resolved subject IS a research tenant.
 *
 * `role="status"` matches the codebase's own precedent for a persistent,
 * assistive-technology-announced advisory notice (see
 * `apps/web/src/pages/ClientWorkspace/ClientOwnedWorkspaceGate.tsx` and
 * `apps/web/src/pages/Coaching/CoachingModeDisabled.tsx`).
 */
export function ResearchSnapshotBanner() {
  const { t } = useTranslation();
  const { isResearch } = useResearchSubject();

  if (!isResearch) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="research-snapshot-banner"
      className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
    >
      {t('coaching.research.banner')}
    </div>
  );
}
