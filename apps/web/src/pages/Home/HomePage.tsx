import { Navigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { SignInCard } from './SignInCard';
import { LandingContent } from './LandingContent';

/**
 * Landing page. Hosts sign-in (legacy behavior — there is no separate
 * /signin route). Redirects to /dashboard if already signed in.
 *
 * V11 SEO: this is the only route Google can index — everything past
 * sign-in is auth-gated — so the signed-out view carries real marketing
 * copy (LandingContent) below the fold instead of just the sign-in card.
 */
export function HomePage() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="flex flex-col items-center gap-12 px-4 py-12">
      <div className="flex w-full max-w-5xl flex-col items-center gap-8 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex max-w-md flex-col gap-3 text-center lg:text-left">
          <h1 className="text-3xl font-bold tracking-tight">Smash Tracker</h1>
          <p className="text-lg text-muted-foreground">
            Free analytics for competitive Super Smash Bros. Ultimate players.
          </p>
          <p className="text-muted-foreground">
            Track your matches, scout your matchups, and see how your roster performs over time —
            GSP and Elite Smash tracking, start.gg/parry.gg sync, matchup analytics, and opponent
            scouting, all free.
          </p>
        </div>
        <SignInCard />
      </div>
      <LandingContent />
    </div>
  );
}
