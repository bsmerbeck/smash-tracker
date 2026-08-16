import { useProfile } from './useProfile';

/**
 * Phase 30.3 (Gate 6, web demo-isolation worker): the SINGLE browser-side
 * read of "is the SIGNED-IN caller's own account one of the login-bearing
 * demo/research accounts." Backed by `GET /api/users/me`'s `isDemoAccount`
 * field, which the shared `userProfileSchema` declares as a REQUIRED boolean
 * and `api.users.getMe` parses with unmodified — see
 * `@/lib/demoAccount.test.ts` for the requiredness contract and the defect
 * (a browser-local `.nullish()` override) it locks against.
 * Deliberately distinct from `useResearchSubject()`
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
 * Returns a plain `boolean`, defaulting `false` only while the profile read
 * is PENDING or ERRORED — an unresolved profile renders no label, which is
 * temporary and acceptable. A SUCCESSFULLY parsed profile can never reach
 * this hook without a real server-derived value: an absent, null, or
 * non-boolean `isDemoAccount` fails the parse in `api.users.getMe` and
 * surfaces as the errored branch, never as a substituted `false`
 * (Phase 30.3 Gate 6 corrective, defect A1).
 * Never a false positive, and never a security boundary of its own:
 * the API independently refuses every demo-account write this hook's
 * consumers disable the affordance for. Consumers needing loading/error
 * nuance should read `useProfile()` directly instead.
 */
export function useIsDemoAccount(): boolean {
  const { data } = useProfile();
  return data?.isDemoAccount === true;
}
