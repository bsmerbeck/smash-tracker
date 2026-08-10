import { useSelfDataCoverage } from '@/hooks/useSelfDataCoverage';
import { DataCoveragePanelView } from './DataCoveragePanel';

/**
 * Phase 30.1 Plan 05 (WKSP-01A, review H5/C2-H2): the self-only, in-account
 * completeness surface — a thin wrapper over `useSelfDataCoverage` that
 * renders the SAME `DataCoveragePanelView` the admin-only research-tenant
 * `DataCoveragePanel` uses, so a logged-in account (demo or ordinary) sees
 * its OWN migrated completeness report (counts, gaps, date coverage,
 * per-player sections, as-of).
 *
 * Renders NOTHING while the query is pending, on error, or when the
 * account has no completed run (`coverage: null`) — this is the normal,
 * expected steady state for every ordinary account, not a failure to
 * surface. This self-hiding behavior is what makes it safe to mount
 * unconditionally on the shared dashboard (review C2-H2): every account
 * that never migrated research data simply sees nothing extra.
 */
export function SelfDataCoveragePanel() {
  const { isPending, isError, hasCompletedRun, data } = useSelfDataCoverage();

  if (isPending || isError || !hasCompletedRun) {
    return null;
  }

  return <DataCoveragePanelView data={data} hasCompletedRun={hasCompletedRun} />;
}
