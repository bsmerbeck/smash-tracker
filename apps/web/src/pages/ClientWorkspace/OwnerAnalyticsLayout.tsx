import { Outlet, useParams } from 'react-router';
import { AnalyticsSubNav } from '@/components/AnalyticsSubNav';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the owned
 * workspace's Analytics sub-nav — a small secondary nav (Dashboard / Fighter
 * Analysis / Matchups / Opponents) above an `<Outlet />` for whichever of
 * those EXACT SAME shared leaf components matched. Fork of the coach-side
 * analytics layout: same base-path-plus-accent shape, base path swapped to
 * `/workspace/:tenantId`, and neutral active-tab styling (no coach-brand
 * accent color) — this surface belongs to the owner, not a coach.
 *
 * Plan 38-02 (D-03/Q11.7): the nav itself is `AnalyticsSubNav`, shared with
 * `ClientAnalyticsLayout` — this layout keeps its own `useParams` read, base
 * path, and neutral accent class, and hands them to the shared component.
 */
export function OwnerAnalyticsLayout() {
  const { tenantId = '' } = useParams<{ tenantId: string }>();
  const base = `/workspace/${tenantId}`;

  return (
    <div className="flex flex-col gap-4">
      <AnalyticsSubNav base={base} activeClassName="border-primary text-primary" />
      <Outlet />
    </div>
  );
}
