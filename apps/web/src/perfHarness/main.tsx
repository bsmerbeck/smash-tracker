import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import '@/i18n';
import '@/index.css';
import { createQueryClient } from '@/lib/queryClient';
import { AuthContext } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MatchupsPage } from '@/pages/Matchups/MatchupsPage';
import { fakeAuthContextValue } from './fakeAuthContextValue';

/**
 * DEV-ONLY perf measurement harness entry (Phase 36 Plan 06, SCL-01 Task
 * 3B) — mounts the REAL `MatchupsPage` (real components, real
 * `useFilteredMatches`/`useMatches`/shared-engine path, real providers:
 * QueryClient, i18n, router, AnalyticsFilter) with ONLY the auth layer
 * substituted by a fixed local fake value (`fakeAuthContextValue`) provided
 * directly to the exported `AuthContext` — the real `AuthProvider`
 * component (Firebase `onAuthStateChanged` wiring) is never rendered here,
 * so no Firebase sign-in, credential, or emulator is needed.
 *
 * `TooltipProvider` is included because it's a REAL, non-auth dependency of
 * `MatchupsPage`'s actual production usage — every authenticated page is
 * normally wrapped in it by `MainLayout.tsx`, which this harness otherwise
 * deliberately does not mount (it carries the whole app shell/nav, not
 * relevant to this measurement). Without it, a `Tooltip` used inside one of
 * MatchupsPage's real cards throws (Radix's context guard) and the page
 * never settles.
 *
 * Deliberately NOT wrapped in `<StrictMode>`: StrictMode double-invokes
 * renders/effects in development, which would double the very compute this
 * harness exists to time. Never reachable from the production build — see
 * `perfHarnessProductionIsolation.guard.test.ts`.
 *
 * `MemoryRouter` (not `BrowserRouter`): this is a single static perf page
 * with no real client-side navigation, so an in-memory history is enough to
 * satisfy every `useLocation()`-based subject hook (`useActiveSubject`,
 * `useOwnedWorkspaceSubject`) — both resolve to `mode: 'personal',
 * clientId: null` at `/matchups`, identical to what they'd resolve to from
 * the harness's real served path (`/perf-harness.html`, also outside
 * `/coach` and `/workspace`).
 */
const queryClient = createQueryClient();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <AuthContext.Provider value={fakeAuthContextValue}>
      <AnalyticsFilterProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/matchups']}>
            <div id="perf-harness-root">
              <MatchupsPage />
            </div>
          </MemoryRouter>
        </TooltipProvider>
      </AnalyticsFilterProvider>
    </AuthContext.Provider>
  </QueryClientProvider>,
);
