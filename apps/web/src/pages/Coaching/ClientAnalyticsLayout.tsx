import { Outlet, useParams } from 'react-router';
import { AnalyticsSubNav } from '@/components/AnalyticsSubNav';

/**
 * Phase 11 fix round 2 (D-03/D3): the "one Analytics sidebar item, grouped
 * surface" — a small secondary sub-nav (Dashboard / Fighter Analysis /
 * Matchups / Opponents) rendered above an `<Outlet />` for whichever of
 * those EXACT SAME personal-route components (imported unchanged,
 * PAR-01/02/03) matched. `useParams` reads `clientId` directly (rather than
 * `useActiveSubject`) since this layout only ever renders inside
 * `/coach/:clientId/*`.
 *
 * Plan 38-02 (D-03/Q11.7): the nav itself is `AnalyticsSubNav`, shared with
 * `OwnerAnalyticsLayout` — this layout keeps its own `useParams` read, base
 * path, and coach accent class, and hands them to the shared component.
 */
export function ClientAnalyticsLayout() {
  const { clientId = '' } = useParams<{ clientId: string }>();
  const base = `/coach/${clientId}`;

  return (
    <div className="flex flex-col gap-4">
      <AnalyticsSubNav base={base} activeClassName="border-coaching-accent text-coaching-accent" />
      <Outlet />
    </div>
  );
}
