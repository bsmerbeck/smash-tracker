import type { ReactElement, ReactNode } from 'react';
import { Route } from 'react-router';
import { retryableLazy } from '@/lib/retryableLazy';

/**
 * Plan 38-02 (D-03): the single declaration of the four analytics-family
 * pages — Dashboard, Fighter Analysis, Matchups, Opponents — rendered
 * identically under all three subject families: personal (flat, nested under
 * a pathless `ProtectedRoute` layout route so the URLs stay byte-unchanged),
 * `/coach/:clientId/...` (nested under `ClientAnalyticsLayout`), and
 * `/workspace/:tenantId/...` (nested under `OwnerAnalyticsLayout`). Before
 * this file existed, `AppRouter.tsx` hand-duplicated the coach and workspace
 * route JSX for these pages — a route added to one block could silently miss
 * the other. `renderSubjectAnalyticsRoutes()` is called exactly ONCE per
 * family (three call sites total, in `AppRouter.tsx`) so every family always
 * renders the same route set in the same order.
 *
 * Tournaments, Trends and Scout are deliberately NOT part of this list (D-04):
 * their API routes are uid-only, and mounting them under a client or tenant
 * route would render the VIEWER's own data under someone else's subject path.
 * See the usage sites in `AppRouter.tsx` for the comment naming this decision.
 *
 * Built from the existing retryableLazy(...) factories — never an eager
 * default import — so the shared list cannot pull these pages into the entry
 * graph and regress the bundle-isolation guard. Each page's factory now lives
 * in exactly ONE place in the whole app: here (moved out of `AppRouter.tsx`,
 * which previously declared all four itself for its now-removed hand-written
 * route blocks).
 */
const DashboardPage = retryableLazy(() =>
  import('@/pages/Dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const FighterAnalysisPage = retryableLazy(() =>
  import('@/pages/FighterAnalysis/FighterAnalysisPage').then((m) => ({
    default: m.FighterAnalysisPage,
  })),
);
const MatchupsPage = retryableLazy(() =>
  import('@/pages/Matchups/MatchupsPage').then((m) => ({ default: m.MatchupsPage })),
);
const OpponentsPage = retryableLazy(() =>
  import('@/pages/Opponents/OpponentsPage').then((m) => ({ default: m.OpponentsPage })),
);

interface SubjectAnalyticsRouteDescriptor {
  /** Leaf path segment, no leading slash — composes under any parent route. */
  path: string;
  element: ReactNode;
}

const subjectAnalyticsRouteDescriptors: SubjectAnalyticsRouteDescriptor[] = [
  { path: 'dashboard', element: <DashboardPage /> },
  { path: 'fighter-analysis', element: <FighterAnalysisPage /> },
  { path: 'matchups', element: <MatchupsPage /> },
  { path: 'opponents', element: <OpponentsPage /> },
];

/**
 * Renders the shared descriptor list as `<Route>` children. Call this ONCE
 * per subject family — see the head comment above for why the call count is
 * asserted to be exactly three.
 */
export function renderSubjectAnalyticsRoutes(): ReactElement[] {
  return subjectAnalyticsRouteDescriptors.map((descriptor) => (
    <Route key={descriptor.path} path={descriptor.path} element={descriptor.element} />
  ));
}
