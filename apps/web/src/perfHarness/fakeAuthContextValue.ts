import type { User as FirebaseUser } from 'firebase/auth';
import type { AuthContextValue } from '@/context/AuthContext';

/**
 * DEV-ONLY perf measurement harness (Phase 36 Plan 06, SCL-01 Task 3B).
 * NEVER reachable from the production build — see
 * `perfHarnessProductionIsolation.guard.test.ts`, which greps the built
 * output for this fixed uid and fails the guard if it is ever found there.
 *
 * A fixed fake uid, never a real account. `lib/api.ts`'s `getAuthHeader()`
 * reads `getFirebaseAuth().currentUser` directly (NOT this context value),
 * so substituting this value does not send a forged Authorization header
 * anywhere — it only satisfies the `Boolean(user)` gates the data hooks
 * (`useMatches`/`useFighters`/`useOpponentAliases`) check before firing.
 * `AuthContext.tsx`'s own component (`AuthProvider`, the real
 * `onAuthStateChanged` wiring) is never rendered by the harness — this
 * value is provided directly to the raw exported `AuthContext.Provider`.
 */
export const PERF_HARNESS_UID = 'perf-harness-user';

function notAvailableInHarness(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} is not available in the SCL-01 perf harness`));
}

export const fakeAuthContextValue: AuthContextValue = {
  user: { uid: PERF_HARNESS_UID } as unknown as FirebaseUser,
  loading: false,
  signInWithEmail: notAvailableInHarness('signInWithEmail'),
  signUpWithEmail: notAvailableInHarness('signUpWithEmail'),
  signInWithGoogle: notAvailableInHarness('signInWithGoogle'),
  signInWithToken: notAvailableInHarness('signInWithToken'),
  signOut: notAvailableInHarness('signOut'),
  getIdToken: async () => 'perf-harness-fake-token',
  changePassword: notAvailableInHarness('changePassword'),
  sendPasswordReset: notAvailableInHarness('sendPasswordReset'),
  updateDisplayName: notAvailableInHarness('updateDisplayName'),
};
