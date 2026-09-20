import type { AuthContextValue } from '@/context/AuthContext';

/**
 * Derived from `AuthContextValue['user']` (never a direct `firebase/auth`
 * import — this harness's own isolation guard asserts NO Firebase import
 * appears anywhere under `apps/web/src/guardHarness/`, a stricter bar than
 * the shipped perf harness's `fakeAuthContextValue.ts`, which does import
 * `firebase/auth`'s `User` type directly for the same annotation).
 */
type HarnessUser = NonNullable<AuthContextValue['user']>;

/**
 * DEV-ONLY layout-oracle harness (Phase 39.1 Plan 09). NEVER reachable from
 * the production build — see `guardHarnessProductionBuild.guard.test.ts`,
 * which greps the built output for this fixed uid and fails the guard if it
 * is ever found there.
 *
 * A fixed fake uid, never a real account — its own marker string, distinct
 * from the shipped perf harness's `PERF_HARNESS_UID`
 * (`apps/web/src/perfHarness/fakeAuthContextValue.ts`, which this file
 * copies its shape from), so this harness's isolation guard has a marker
 * that could never collide with the perf harness's own isolation proof.
 * `lib/api.ts`'s `getAuthHeader()` reads `getFirebaseAuth().currentUser`
 * directly (NOT this context value), so substituting this value does not
 * send a forged Authorization header anywhere — it only satisfies the
 * `Boolean(user)` gates the data hooks check before firing. The real
 * `AuthProvider` (the `onAuthStateChanged` wiring) is never rendered by this
 * harness — this value is provided directly to the raw exported
 * `AuthContext.Provider`.
 */
export const GUARD_HARNESS_UID = 'guard-layout-harness-user';

function notAvailableInHarness(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} is not available in the guard-layout harness`));
}

export const fakeGuardAuthContextValue: AuthContextValue = {
  user: { uid: GUARD_HARNESS_UID } as unknown as HarnessUser,
  loading: false,
  signInWithEmail: notAvailableInHarness('signInWithEmail'),
  signUpWithEmail: notAvailableInHarness('signUpWithEmail'),
  signInWithGoogle: notAvailableInHarness('signInWithGoogle'),
  signInWithToken: notAvailableInHarness('signInWithToken'),
  signOut: notAvailableInHarness('signOut'),
  getIdToken: async () => 'guard-layout-harness-fake-token',
  changePassword: notAvailableInHarness('changePassword'),
  sendPasswordReset: notAvailableInHarness('sendPasswordReset'),
  updateDisplayName: notAvailableInHarness('updateDisplayName'),
};
