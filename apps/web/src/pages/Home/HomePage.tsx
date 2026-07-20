import { useEffect } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { useSeo } from '@/hooks/useSeo';
import { useProfile } from '@/hooks/useProfile';
import { resolveOnboardingRoute, useSaveOnboardingIntent } from '@/hooks/useOnboarding';
import * as onboardingOrigin from '@/lib/onboardingOrigin';
import { SignInCard } from './SignInCard';
import { LandingContent } from './LandingContent';

/**
 * Landing page. Hosts sign-in (legacy behavior — there is no separate
 * /signin route).
 *
 * ONBD-01/D-01/D-02 (Phase 13): a signed-in visitor is no longer
 * unconditionally sent to `/dashboard` — `resolveOnboardingRoute` (see
 * `useOnboarding.ts`) decides between the saved-intent destination, the
 * plain dashboard (returning accounts, or a new account with no origin
 * context isn't forced through /welcome twice), the unambiguous-origin
 * guided-path skip, or the ambiguous-origin `/welcome` ask with a
 * pre-selected option. The origin stamp is read here but NOT cleared — the
 * guided-path card (13-07) still needs its `returnPath` for the "back to
 * <artifact>" link/chip.
 *
 * V11 SEO: this is the only route Google can index — everything past
 * sign-in is auth-gated — so the signed-out view carries real marketing
 * copy (LandingContent) below the fold instead of just the sign-in card.
 *
 * V12 SEO: title/description here match index.html's static tags verbatim —
 * `useSeo` is a no-op against the prerendered snapshot of `/` but keeps this
 * page's head in sync with the other public routes going forward.
 */
export function HomePage() {
  useSeo({
    title: 'grandfinals.gg — Free Super Smash Bros. Ultimate Analytics & GSP Tracker',
    description:
      'Free Super Smash Bros. Ultimate analytics: GSP & Elite Smash tracking, start.gg/parry.gg sync, matchup stats, stage mastery, and AI scouting reports.',
    canonicalPath: '/',
  });

  const { user, loading } = useAuth();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const saveIntent = useSaveOnboardingIntent();

  // Firebase's own "is this a brand-new sign-in" heuristic: a returning
  // account's `lastSignInTime` differs from its `creationTime` on every
  // subsequent sign-in, while a just-provisioned account's first
  // `onAuthStateChanged` callback carries identical timestamps.
  const isNewAccount = user != null && user.metadata.creationTime === user.metadata.lastSignInTime;
  const origin = user ? onboardingOrigin.read() : null;
  const decision =
    user && !profileLoading && profile
      ? resolveOnboardingRoute({
          onboardingIntent: profile.onboardingIntent,
          isNewAccount,
          origin,
        })
      : null;

  useEffect(() => {
    if (decision?.autoSaveIntent) {
      saveIntent.mutate({ onboardingIntent: decision.autoSaveIntent, onboardingAsked: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.autoSaveIntent]);

  if (loading) {
    return null;
  }

  if (user) {
    if (profileLoading || !profile || !decision) {
      return null;
    }
    return <Navigate to={decision.to} state={decision.state} replace />;
  }

  return (
    <div className="flex flex-col items-center gap-12 px-4 py-12">
      <div className="flex w-full max-w-5xl flex-col items-center gap-8 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex max-w-md flex-col gap-3 text-center lg:text-left">
          <h1 className="text-3xl font-bold tracking-tight">grandfinals.gg</h1>
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
