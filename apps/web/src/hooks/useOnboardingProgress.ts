import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';
import { useProfile } from './useProfile';

/**
 * GET /api/onboarding/progress (Phase 13, ONBD-04/D-04) — the guided-path
 * checklist's server-derived done-states (`analytics`/`vod`/
 * `tournamentPrep`/`scout`). Personal-only, mirroring `useProfile`/
 * `profileQueryKey`: NEVER subject-scoped (a coach's own onboarding
 * checklist is their OWN player activation, never a managed client's — see
 * the route's own doc comment in `apps/api/src/routes/onboarding.ts`).
 *
 * Only enabled once a signed-in user has actually saved an intent — a
 * bare-new account with no `onboardingIntent` has nothing for
 * `GuidedPathCard`/the dashboard next-best-action area to render, so there
 * is no reason to fetch this yet.
 */
export const onboardingProgressQueryKey = ['onboarding', 'progress'] as const;

export function useOnboardingProgress() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  return useQuery({
    queryKey: onboardingProgressQueryKey,
    queryFn: () => api.onboarding.getProgress(),
    enabled: Boolean(user) && profile?.onboardingIntent != null,
  });
}
