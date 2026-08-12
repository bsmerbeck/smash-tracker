import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { retryableLazy } from '@/lib/retryableLazy';

/**
 * P1 2026-08-12: MainLayout is lazy so its subtree (GuidedPathCard,
 * useStartggAutoSync, and their hook chunks) stays out of the entry module
 * graph — those chunks stalling 26–103s on a cold CDN edge blanked login
 * for the whole stall. The suspension is caught by AppRouter's route-level
 * Suspense. The boundary must be the component (not useStartggAutoSync):
 * hooks cannot be dynamically imported inside render.
 *
 * The warm-up import below exists because the page element is MainLayout's
 * children PROP — React does not reconcile (and so never starts fetching)
 * the page chunk of a suspended parent, which would serialize
 * entry → MainLayout → page into three round trips. Kicking the fetch off
 * at module-eval time makes it concurrent with boot WITHOUT blocking it (a
 * dynamic import never gates the entry graph); by first authenticated
 * render the module is typically already resolved. Failures are swallowed:
 * the retryableLazy factory below re-imports with full retry handling.
 */
void import('@/layouts/MainLayout').catch(() => {});

const MainLayout = retryableLazy(() =>
  import('@/layouts/MainLayout').then((m) => ({ default: m.MainLayout })),
);

/**
 * Guards a route to signed-in users only. Legacy behavior: unauthenticated
 * users are sent to `/` (Home hosts sign-in there), not a dedicated
 * `/signin` route. While auth state is still resolving, renders nothing
 * (no flash of the sign-in redirect) rather than a spinner — auth resolution
 * from `onAuthStateChanged` is typically sub-100ms.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return <MainLayout>{children}</MainLayout>;
}
