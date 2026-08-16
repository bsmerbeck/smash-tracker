import { useProfile } from './useProfile';

/**
 * Phase 30.3 (Gate 6, web demo-isolation worker): the SINGLE browser-side
 * read of "is the SIGNED-IN caller's own account one of the login-bearing
 * demo/research accounts." Backed by `GET /api/users/me`'s `isDemoAccount`
 * field (`webUserProfileSchema` in `@/lib/demoAccount.ts` — see that file's
 * doc comment for the exact gap this fills and the field name a parallel API
 * worker needs to add). Deliberately distinct from `useResearchSubject()`
 * (`@/hooks/useResearchSubject.ts`): that hook answers "is the ACTIVE
 * WORKSPACE a coach-managed research TENANT" (a property of whichever
 * client's data is being viewed), while this one answers "is MY OWN
 * account a demo account" (a property of the signed-in identity itself,
 * unrelated to which workspace is active) — the two are never
 * interchangeable, and a demo account's OWN dashboard/match-data/etc.
 * surfaces resolve as an ordinary personal workspace to
 * `useResearchSubject()`, which is exactly the gap this hook exists to
 * close.
 *
 * Returns a plain `boolean`, defaulting `false` while the profile is
 * pending, errored, or the field is absent (today, before the API sends
 * it) — never a false positive, and never a security boundary of its own:
 * the API independently refuses every demo-account write this hook's
 * consumers disable the affordance for. Consumers needing loading/error
 * nuance should read `useProfile()` directly instead.
 */
export function useIsDemoAccount(): boolean {
  const { data } = useProfile();
  return data?.isDemoAccount === true;
}
