import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';
import { HomePage } from '@/pages/Home/HomePage';
import { CoachingModeGate } from '@/pages/Coaching/CoachingModeGate';
import { ActiveSubjectSync } from './ActiveSubjectSync';
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
// Phase 13 (Coach-Aware Intent Onboarding, ONBD-01/ONBD-02): the one-intent-
// question chooser HomePage's post-auth routing branch can send a new
// account to. ProtectedRoute-gated like every other authenticated route.
const WelcomePage = lazy(() =>
  import('@/pages/Welcome/WelcomePage').then((m) => ({ default: m.WelcomePage })),
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
// Phase 12 (Coach Reviews & Delivery, D-08/DLV-02): the anonymous no-account
// recipient page for a delivered coach review, `/r/:token`.
const ReviewDeliveryPage = lazy(() =>
  import('@/pages/Review/ReviewDeliveryPage').then((m) => ({ default: m.ReviewDeliveryPage })),
);
// Phase 11 (Coach Workspace Tenancy & Feature Parity): /coach + /coach/:clientId/*.
const ClientHubPage = lazy(() =>
  import('@/pages/Coaching/ClientHubPage').then((m) => ({ default: m.ClientHubPage })),
);
const ClientWorkspaceLayout = lazy(() =>
  import('@/pages/Coaching/ClientWorkspaceLayout').then((m) => ({
    default: m.ClientWorkspaceLayout,
  })),
);
// Phase 11 fix round 2 (D-02/D2, D-03/D3): the client workspace's own pages
// (Overview landing, Fighters, and the Analytics sub-nav grouping wrapper).
const ClientOverviewPage = lazy(() =>
  import('@/pages/Coaching/ClientOverviewPage').then((m) => ({ default: m.ClientOverviewPage })),
);
const ClientFightersPage = lazy(() =>
  import('@/pages/Coaching/ClientFightersPage').then((m) => ({ default: m.ClientFightersPage })),
);
const ClientAnalyticsLayout = lazy(() =>
  import('@/pages/Coaching/ClientAnalyticsLayout').then((m) => ({
    default: m.ClientAnalyticsLayout,
  })),
);
// Phase 12 (Coach Reviews & Delivery): the dedicated two-pane review
// composer (D-01), `/coach/:clientId/reviews/:reviewId`.
const ReviewComposerPage = lazy(() =>
  import('@/pages/Coaching/ReviewComposerPage').then((m) => ({ default: m.ReviewComposerPage })),
);
// Phase 12 (Coach Reviews & Delivery, D-05): the Reviews list, the 6th
// client-workspace nav item — `/coach/:clientId/reviews`.
const ReviewsListPage = lazy(() =>
  import('@/pages/Coaching/ReviewsListPage').then((m) => ({ default: m.ReviewsListPage })),
);
// Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
// SESS-01/02): the Sessions list (the 7th client-workspace nav item,
// `/coach/:clientId/sessions`) and the session composer
// (`/coach/:clientId/sessions/:sessionId`) — SIBLINGS to the reviews pair
// above, never a fork.
const SessionsListPage = lazy(() =>
  import('@/pages/Coaching/SessionsListPage').then((m) => ({ default: m.SessionsListPage })),
);
const SessionComposerPage = lazy(() =>
  import('@/pages/Coaching/SessionComposerPage').then((m) => ({
    default: m.SessionComposerPage,
  })),
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
      {/* Phase 11 TEN-04/TEN-07: keeps api.ts's X-Active-Subject header in
          sync with the route on every navigation, coaching or personal —
          see ActiveSubjectSync's own doc comment. */}
      <ActiveSubjectSync />
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
          {/* Phase 12 (Coach Reviews & Delivery, D-08/DLV-02): the anonymous
              no-account coach review delivery link — noindex (unlisted),
              no auth, revocable/expiring token. A SIBLING to /s/:token
              above, never a fork. */}
          <Route path="/r/:token" element={<ReviewDeliveryPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          {/* Phase 13 (Coach-Aware Intent Onboarding, ONBD-01/ONBD-02/D-01):
              route-visible so it survives reload/deep-link/Back — HomePage's
              post-auth routing branch sends a new account with no saved
              intent and an ambiguous (or absent) origin here; also
              re-enterable anytime via the dashboard next-best-action area
              or any guided path's switch-intent link. */}
          <Route
            path="/welcome"
            element={
              <ProtectedRoute>
                <WelcomePage />
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
          {/* Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-07): the
              Client Hub landing shell. Walkthrough fix round 1 (FB-3):
              coaching mode is opt-in — CoachingModeGate renders the
              friendly "enable it in Profile" state instead of the hub
              until the user turns the toggle on. */}
          <Route
            path="/coach"
            element={
              <ProtectedRoute>
                <CoachingModeGate>
                  <ClientHubPage />
                </CoachingModeGate>
              </ProtectedRoute>
            }
          />
          {/* A single ProtectedRoute gates the whole workspace layout — its
              nested children below are NOT individually wrapped, matching
              the plan's "one nested Route whose children are the existing
              pages" shape. ClientWorkspaceLayout renders <Outlet /> for
              whichever child matched. Phase 11 fix round 2 (D-02/D2): the
              index redirects to `overview` (NOT `vods` — the sync-disabled
              VOD page the owner rejected as a landing surface), `overview`
              and `fighters` are new client-workspace-only pages, and
              `dashboard`/`fighter-analysis`/`matchups` are grouped under
              `ClientAnalyticsLayout` (D-03/D3: one Analytics sidebar item,
              a small secondary sub-nav underneath). `vods`/`match-data` are
              the EXACT SAME lazy() components the personal routes above
              use — imported once, reused unmodified (PAR-01/02/03), never
              forked. GSP/integrations/reports are NOT feature-parity
              capabilities (CONTEXT.md); rather than rendering an
              "unavailable" stub, a deep link to any of them redirects
              cleanly (replace) to `overview` (D-05/D5) — no personal
              GSP/integrations/reports data, and no flash of a disabled
              page. Walkthrough fix round 1 (FB-3): CoachingModeGate wraps
              the whole workspace too, so a direct `/coach/:clientId/...`
              deep-link with coaching mode off gets the same friendly gate
              instead of a client's data. */}
          <Route
            path="/coach/:clientId"
            element={
              <ProtectedRoute>
                <CoachingModeGate>
                  <ClientWorkspaceLayout />
                </CoachingModeGate>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<ClientOverviewPage />} />
            <Route path="fighters" element={<ClientFightersPage />} />
            <Route path="vods" element={<VodManagerPage />} />
            <Route path="match-data" element={<MatchDataPage />} />
            <Route element={<ClientAnalyticsLayout />}>
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="fighter-analysis" element={<FighterAnalysisPage />} />
              <Route path="matchups" element={<MatchupsPage />} />
            </Route>
            {/* Phase 12 (Coach Reviews & Delivery, D-01/D-05): the Reviews list + the review composer. */}
            <Route path="reviews" element={<ReviewsListPage />} />
            <Route path="reviews/:reviewId" element={<ReviewComposerPage />} />
            {/* Phase 20 (Coaching Workflow, Training Sessions & VOD-less
                Reviews, SESS-01/02): the Sessions list + the session
                composer — a SIBLING pair to the reviews routes above. */}
            <Route path="sessions" element={<SessionsListPage />} />
            <Route path="sessions/:sessionId" element={<SessionComposerPage />} />
            <Route path="gsp" element={<Navigate to="../overview" replace />} />
            <Route path="integrations" element={<Navigate to="../overview" replace />} />
            <Route path="reports" element={<Navigate to="../overview" replace />} />
          </Route>
          {/* Public: receives the custom token from the "login with start.gg" flow. */}
          <Route path="/auth/startgg" element={<StartggAuthPage />} />
          <Route path="/not-found" element={<NotFoundPage />} />
          <Route path="*" element={<Navigate to="/not-found" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
