import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';
import { HomePage } from '@/pages/Home/HomePage';
import { ProtectedRoute } from './ProtectedRoute';
import { RouteAnalytics } from './RouteAnalytics';
import { RouteTitles } from './RouteTitles';

/**
 * V12 SEO: every page except HomePage is lazy-loaded so the entry chunk stays
 * small (Core Web Vitals feed rankings, and the pre-split main bundle had
 * grown past 1.2 MB). HomePage stays eager: it's the prerendered landing +
 * sign-in surface, and a lazy flash there would show up in the first
 * impression search visitors get. Pages use named exports, hence the
 * `.then(m => ({ default: ... }))` shims.
 */
const DashboardPage = lazy(() =>
  import('@/pages/Dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const ChoosePrimaryPage = lazy(() =>
  import('@/pages/CharacterSelect/ChoosePrimaryPage').then((m) => ({
    default: m.ChoosePrimaryPage,
  })),
);
const ChooseSecondaryPage = lazy(() =>
  import('@/pages/CharacterSelect/ChooseSecondaryPage').then((m) => ({
    default: m.ChooseSecondaryPage,
  })),
);
const FighterAnalysisPage = lazy(() =>
  import('@/pages/FighterAnalysis/FighterAnalysisPage').then((m) => ({
    default: m.FighterAnalysisPage,
  })),
);
const MatchupsPage = lazy(() =>
  import('@/pages/Matchups/MatchupsPage').then((m) => ({ default: m.MatchupsPage })),
);
const OpponentsPage = lazy(() =>
  import('@/pages/Opponents/OpponentsPage').then((m) => ({ default: m.OpponentsPage })),
);
const ScoutPage = lazy(() =>
  import('@/pages/Scout/ScoutPage').then((m) => ({ default: m.ScoutPage })),
);
const ReportsPage = lazy(() =>
  import('@/pages/Reports/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const MatchDataPage = lazy(() =>
  import('@/pages/MatchData/MatchDataPage').then((m) => ({ default: m.MatchDataPage })),
);
const VodManagerPage = lazy(() =>
  import('@/pages/VodManager/VodManagerPage').then((m) => ({ default: m.VodManagerPage })),
);
const TrendsPage = lazy(() =>
  import('@/pages/Trends/TrendsPage').then((m) => ({ default: m.TrendsPage })),
);
const GspPage = lazy(() => import('@/pages/Gsp/GspPage').then((m) => ({ default: m.GspPage })));
const GroupsPage = lazy(() =>
  import('@/pages/Groups/GroupsPage').then((m) => ({ default: m.GroupsPage })),
);
const TournamentsPage = lazy(() =>
  import('@/pages/Tournaments/TournamentsPage').then((m) => ({
    default: m.TournamentsPage,
  })),
);
const TournamentDetailPage = lazy(() =>
  import('@/pages/Tournaments/TournamentDetailPage').then((m) => ({
    default: m.TournamentDetailPage,
  })),
);
const IntegrationsPage = lazy(() =>
  import('@/pages/Integrations/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })),
);
const ProfilePage = lazy(() =>
  import('@/pages/Profile/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const StartggAuthPage = lazy(() =>
  import('@/pages/StartggAuth/StartggAuthPage').then((m) => ({ default: m.StartggAuthPage })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/NotFound/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);
const FaqPage = lazy(() => import('@/pages/Faq/FaqPage').then((m) => ({ default: m.FaqPage })));
const GspCalculatorPage = lazy(() =>
  import('@/pages/GspCalculator/GspCalculatorPage').then((m) => ({
    default: m.GspCalculatorPage,
  })),
);
const ShareViewPage = lazy(() =>
  import('@/pages/Share/ShareViewPage').then((m) => ({ default: m.ShareViewPage })),
);

/** Minimal route-transition fallback — matches HomePage's `loading → null` behavior in spirit without layout shift once content lands. */
function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
      {t('chrome.loading')}
    </div>
  );
}

/**
 * Routes matching legacy paths. `/`, `/faq`, `/gsp-calculator`, and
 * `/not-found` are public (the latter three are prerendered/crawlable — see
 * scripts/prerender.mjs); every other route is wrapped in `ProtectedRoute`
 * (redirects unauthenticated users to `/`, which hosts sign-in — matching
 * legacy behavior). Unknown paths redirect to `/not-found`. `/s/:token`
 * (Phase 6) is also public — anonymous VOD review share links — but is
 * deliberately `noindex` (unlisted), not part of the prerendered/crawlable set.
 */
export function AppRouter() {
  return (
    <BrowserRouter>
      {/* Order matters: RouteTitles' effect runs before RouteAnalytics reads
          document.title (the async analytics init resolves after the whole
          effect flush), and page-level useSeo effects run before both. */}
      <RouteTitles />
      <RouteAnalytics />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {/* Public, crawlable (V12 SEO). */}
          <Route path="/faq" element={<FaqPage />} />
          <Route path="/gsp-calculator" element={<GspCalculatorPage />} />
          {/* Public, anonymous VOD review share links — noindex (unlisted, per
              CONTEXT.md), no auth. GET /s/:token also serves a server-rendered
              HTML shell with per-token OG meta for crawlers/unfurl bots
              (apps/api/src/routes/shareMeta.ts); this route is what a REAL
              browser boots into once the SPA takes over. */}
          <Route path="/s/:token" element={<ShareViewPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/choose-primary"
            element={
              <ProtectedRoute>
                <ChoosePrimaryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/choose-secondary"
            element={
              <ProtectedRoute>
                <ChooseSecondaryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/fighter-analysis"
            element={
              <ProtectedRoute>
                <FighterAnalysisPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/matchups"
            element={
              <ProtectedRoute>
                <MatchupsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/opponents"
            element={
              <ProtectedRoute>
                <OpponentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/scout"
            element={
              <ProtectedRoute>
                <ScoutPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <ReportsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/match-data"
            element={
              <ProtectedRoute>
                <MatchDataPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/vod"
            element={
              <ProtectedRoute>
                <VodManagerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/trends"
            element={
              <ProtectedRoute>
                <TrendsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/gsp"
            element={
              <ProtectedRoute>
                <GspPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/tournaments"
            element={
              <ProtectedRoute>
                <TournamentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/tournaments/:eventId"
            element={
              <ProtectedRoute>
                <TournamentDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/groups"
            element={
              <ProtectedRoute>
                <GroupsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/integrations"
            element={
              <ProtectedRoute>
                <IntegrationsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <ProfilePage />
              </ProtectedRoute>
            }
          />
          {/* Public: receives the custom token from the "login with start.gg" flow. */}
          <Route path="/auth/startgg" element={<StartggAuthPage />} />
          <Route path="/not-found" element={<NotFoundPage />} />
          <Route path="*" element={<Navigate to="/not-found" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
