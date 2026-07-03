import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { MainLayout } from '@/layouts/MainLayout';

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
