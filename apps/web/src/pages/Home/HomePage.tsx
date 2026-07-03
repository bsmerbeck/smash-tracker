import { Navigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { SignInCard } from './SignInCard';

/** Landing page. Hosts sign-in (legacy behavior — there is no separate /signin route). Redirects to /dashboard if already signed in. */
export function HomePage() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Smash Tracker</h1>
        <p className="text-muted-foreground">
          Track your Super Smash Bros. Ultimate matches, scout your matchups, and see how your
          roster performs over time.
        </p>
      </div>
      <SignInCard />
    </div>
  );
}
