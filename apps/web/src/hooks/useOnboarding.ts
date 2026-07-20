import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import type { OnboardingOriginKind, StoredOrigin } from '@/lib/onboardingOrigin';
import { profileQueryKey } from './useProfile';

/**
 * PUT /api/users/me — saves the `/welcome` chooser's selection (or the
 * origin-driven skip outcome computed by `resolveOnboardingRoute` below).
 * Mirrors `useUpdateCoachingModeEnabled`'s exact shape (Phase 13, ONBD-02):
 * same mutation/invalidate convention, just carrying the two new fields.
 */
export function useSaveOnboardingIntent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { onboardingIntent: OnboardingIntent; onboardingAsked: boolean }) =>
      api.users.upsertMe(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profileQueryKey });
    },
  });
}

/**
 * Maps a saved/selected onboarding intent to its guided-path route (D-04):
 * each intent lands on the REAL feature page, never a separate wizard.
 * Reuses existing `AppRouter` paths — no new routes beyond `/welcome`
 * itself. `track_improvement` lands on Fighter Analysis (D-04's "fighter
 * setup/analytics" feature area) — the closest existing page to "log
 * matches and watch your trends" without introducing a new landing surface.
 */
export function intentDestination(intent: OnboardingIntent): string {
  switch (intent) {
    case 'review_vod':
      return '/vod';
    case 'track_improvement':
      return '/fighter-analysis';
    case 'prepare':
      return '/tournaments';
    case 'scout':
      return '/scout';
    case 'coach_clients':
      return '/coach';
  }
}

/**
 * Maps an origin stamp's `kind` to its associated onboarding intent (D-02).
 * `vodShare` and `recap` are the two UNAMBIGUOUS origins — the mapped intent
 * is auto-saved and the user is routed straight into the guided path,
 * skipping the question. `coachReview` is the one AMBIGUOUS origin — the
 * SAME mapped intent (`review_vod`, per the approved mockup's ambiguous-ask
 * variant) is instead passed to `/welcome` as the PRE-SELECTED suggestion,
 * never auto-saved (a review recipient might want something else entirely).
 */
export function originIntentHint(kind: OnboardingOriginKind): OnboardingIntent {
  switch (kind) {
    case 'vodShare':
    case 'coachReview':
      return 'review_vod';
    case 'recap':
      return 'prepare';
  }
}

/** The two origin kinds whose intent is unambiguous enough to skip the question entirely (D-02 locked list). */
export function isUnambiguousOrigin(kind: OnboardingOriginKind): boolean {
  return kind === 'vodShare' || kind === 'recap';
}

export interface OnboardingRoutingDecision {
  /** Route to `<Navigate replace>` to. */
  to: string;
  /** Router state to carry along — only set for the ambiguous-origin ask (the pre-selected option). */
  state?: { preselect: OnboardingIntent };
  /**
   * Present only for the unambiguous-origin skip case: the caller should
   * fire-and-forget `useSaveOnboardingIntent().mutate({ onboardingIntent:
   * autoSaveIntent, onboardingAsked: false })` alongside navigating.
   */
  autoSaveIntent?: OnboardingIntent;
}

/**
 * Pure decision function for HomePage's post-auth routing branch
 * (ONBD-01/D-01/D-02) — kept out of the component so HomePage itself stays
 * a thin render + one fire-and-forget effect. Order of precedence:
 *
 * 1. A saved intent always wins — route to its guided path (a completed
 *    intent is treated as "done"; no re-asking).
 * 2. A RETURNING account (not brand-new) with no saved intent lands on
 *    `/dashboard` regardless of any origin stamp — the "new account" gate
 *    applies to every `/welcome`-bound outcome, not just the plain
 *    chooser, so an established user is never surprised by an
 *    origin-driven detour away from their normal landing.
 * 3. A NEW account with an unambiguous origin skips the question — the
 *    mapped intent is auto-saved (`onboardingAsked: false`) and the user
 *    lands straight in the guided path.
 * 4. A NEW account with an ambiguous origin is asked, with the
 *    origin-matched option pre-selected.
 * 5. A NEW account with no origin and no saved intent gets the plain
 *    chooser.
 */
export function resolveOnboardingRoute(input: {
  onboardingIntent: OnboardingIntent | null;
  isNewAccount: boolean;
  origin: StoredOrigin | null;
}): OnboardingRoutingDecision {
  const { onboardingIntent, isNewAccount, origin } = input;

  if (onboardingIntent) {
    return { to: intentDestination(onboardingIntent) };
  }

  if (!isNewAccount) {
    return { to: '/dashboard' };
  }

  if (origin) {
    const hint = originIntentHint(origin.kind);
    if (isUnambiguousOrigin(origin.kind)) {
      return { to: intentDestination(hint), autoSaveIntent: hint };
    }
    return { to: '/welcome', state: { preselect: hint } };
  }

  return { to: '/welcome' };
}
