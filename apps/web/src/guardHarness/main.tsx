import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import '@/i18n';
import '@/index.css';
import { createQueryClient } from '@/lib/queryClient';
import { AuthContext } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { fakeGuardAuthContextValue } from './fakeGuardAuthContextValue';
import { GUARD_HARNESS_ROUTES, findGuardHarnessRoute } from './guardHarnessRoutes';

/**
 * DEV-ONLY layout-oracle harness entry (Phase 39.1 Plan 09, UIX-01/UIX-06,
 * review finding C1-H4). Reads the route `id` from the URL's `id` query
 * param, looks it up in `GUARD_HARNESS_ROUTES`, and mounts that entry's
 * `element` inside a `MemoryRouter` whose `initialEntries` is the entry's
 * `initialEntry` and whose `Routes` declares the entry's `path` — so every
 * `useLocation()`-based subject hook resolves exactly as it does at the
 * entry's real path.
 *
 * Modelled file-for-file on the shipped perf harness
 * (`apps/web/src/perfHarness/main.tsx`, NOT edited by this plan): the same
 * real, non-auth providers — `QueryClientProvider` from the app's own
 * query-client factory, i18n, `AnalyticsFilterProvider` and
 * `TooltipProvider` — wrap the mounted page, with `AuthContext` given
 * `fakeGuardAuthContextValue` directly, so the real `AuthProvider` component
 * (Firebase `onAuthStateChanged` wiring) is never rendered here and no
 * Firebase sign-in, credential, or emulator is needed.
 *
 * Deliberately NOT wrapped in `<StrictMode>`, for the same reason the perf
 * harness documents: StrictMode double-invokes renders/effects in
 * development, which would double the very layout this harness exists to
 * measure. `MainLayout` is deliberately NOT mounted either — this harness
 * measures one page's own layout, not the app shell around it. Never
 * reachable from the production build — see
 * `guardHarnessProductionBuild.guard.test.ts`.
 */
const params = new URLSearchParams(window.location.search);
const routeId = params.get('id');
const route = findGuardHarnessRoute(routeId);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

if (!route) {
  rootElement.textContent = `guard-layout harness: unknown route id "${routeId ?? ''}" (known ids: ${GUARD_HARNESS_ROUTES.map((r) => r.id).join(', ')})`;
} else {
  const queryClient = createQueryClient();

  createRoot(rootElement).render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={fakeGuardAuthContextValue}>
        <AnalyticsFilterProvider>
          <TooltipProvider>
            <MemoryRouter initialEntries={[route.initialEntry]}>
              <Routes>
                <Route path={route.path} element={route.element} />
              </Routes>
            </MemoryRouter>
          </TooltipProvider>
        </AnalyticsFilterProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
