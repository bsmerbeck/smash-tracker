import { Suspense, useEffect } from 'react';
import { Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { useSeo } from '@/hooks/useSeo';
import { useProfile } from '@/hooks/useProfile';
import { resolveOnboardingRoute, useSaveOnboardingIntent } from '@/hooks/useOnboarding';
import * as onboardingOrigin from '@/lib/onboardingOrigin';
import { retryableLazy } from '@/lib/retryableLazy';
import { LandingContent } from './LandingContent';

/**
 * P1 2026-08-12: SignInCard is lazy because it is the only non-lazy importer
 * of react-hook-form + @hookform/resolvers (the form-* chunk) — a boot-path
 * chunk that stalled 60s on a cold CDN edge and blanked the whole landing.
 * It gets its OWN Suspense below (not AppRouter's route boundary, which
 * would swap the entire landing — LandingContent included — for the route
 * fallback while the chunk loads). Prerender still captures the fully
 * rendered card: scripts/prerender.mjs waits for networkidle2 before
 * snapshotting.
 */
// Warm the chunk from boot (non-blocking) so the card is usually ready by
// first paint; failures are swallowed — the retryableLazy factory re-imports
// with full retry handling.
void import('./SignInCard').catch(() => {});

const SignInCard = retryableLazy(() =>
  import('./SignInCard').then((m) => ({ default: m.SignInCard })),
);

/**
 * Card-shaped placeholder pinned to the real SignInCard's rendered frame
 * (measured 462×384px in sign-in mode) so the swap causes no layout shift
 * of LandingContent below it — `/` is the only Google-indexed route, so a
 * shift here lands directly in CrUX CLS.
 */
function SignInCardFallback() {
  return <div aria-hidden className="min-h-[462px] w-full max-w-sm rounded-xl border bg-card" />;
}

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

  const { t } = useTranslation();
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
      // Not `null`: the profile normally arrives within one refetch now
      // that AuthContext invalidates the profile query after a successful
      // provision, but a genuinely failed provision (or an API outage)
      // would otherwise leave a signed-in user staring at the dark body
      // with no signal at all.
      return (
        <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
          {t('chrome.loading')}
        </div>
      );
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
        <Suspense fallback={<SignInCardFallback />}>
          <SignInCard />
        </Suspense>
      </div>
      <LandingContent />
    </div>
  );
}
