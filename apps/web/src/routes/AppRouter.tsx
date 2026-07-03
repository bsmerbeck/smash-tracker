import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { HomePage } from '@/pages/Home/HomePage';
import { DashboardPage } from '@/pages/Dashboard/DashboardPage';
import { ChoosePrimaryPage } from '@/pages/CharacterSelect/ChoosePrimaryPage';
import { ChooseSecondaryPage } from '@/pages/CharacterSelect/ChooseSecondaryPage';
import { MatchupsPage } from '@/pages/Matchups/MatchupsPage';
import { MatchDataPage } from '@/pages/MatchData/MatchDataPage';
import { FighterAnalysisPage } from '@/pages/FighterAnalysis/FighterAnalysisPage';
import { IntegrationsPage } from '@/pages/Integrations/IntegrationsPage';
import { StartggAuthPage } from '@/pages/StartggAuth/StartggAuthPage';
import { NotFoundPage } from '@/pages/NotFound/NotFoundPage';
import { ProtectedRoute } from './ProtectedRoute';

/**
 * Routes matching legacy paths. `/` and `/not-found` are public; every other
 * route is wrapped in `ProtectedRoute` (redirects unauthenticated users to
 * `/`, which hosts sign-in — matching legacy behavior). Unknown paths
 * redirect to `/not-found`.
 */
export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
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
          path="/match-data"
          element={
            <ProtectedRoute>
              <MatchDataPage />
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
        {/* Public: receives the custom token from the "login with start.gg" flow. */}
        <Route path="/auth/startgg" element={<StartggAuthPage />} />
        <Route path="/not-found" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
