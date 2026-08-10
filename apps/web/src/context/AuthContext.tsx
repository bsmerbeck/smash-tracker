import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  updatePassword,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createGoogleAuthProvider, getFirebaseAuth } from '@/lib/firebase';
import { api } from '@/lib/api';
import { postCanonicalEvent } from '@/lib/canonicalEvents';
import * as shareReferral from '@/lib/shareReferral';
import { profileQueryKey } from '@/hooks/useProfile';

export interface AuthContextValue {
  user: FirebaseUser | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** Completes "login with start.gg": the API mints a Firebase custom token and the SPA signs in with it. */
  signInWithToken: (customToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
  /**
   * Profile > Security "change password" flow for accounts that already
   * have the `password` provider: re-authenticates with the current
   * password (Firebase requires a recent sign-in for this operation, see
   * `auth/requires-recent-login`) before setting the new one.
   */
  changePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  /**
   * Profile > Security "send password reset email" for accounts with an
   * email but no `password` provider (Google, start.gg): completing the
   * reset flow adds password sign-in alongside their existing method.
   */
  sendPasswordReset: (email: string) => Promise<void>;
  /**
   * Profile > Account "display name": the name attached to VOD share links
   * when the owner enables "Show your display name". `null` clears it.
   */
  updateDisplayName: (displayName: string | null) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Idempotent user provisioning: replaces the deleted Cloud Function's
 * `onCreate` auth trigger. Called after every successful sign-in/sign-up so
 * `users/{uid}` always exists before any other API call needs it. Errors are
 * swallowed (logged only) — provisioning failure shouldn't block the user
 * from being considered signed in on the client; subsequent API calls will
 * surface a clearer error if the profile is genuinely missing.
 *
 * Phase 7 (FUNNEL-02): also threads the localStorage referral stamp (set by
 * `ShareViewPage` on share-page mount) through as `referredByShareId`. The
 * stamped value is the share-page route TOKEN — the server resolves it to
 * the durable shareId before storing (and silently drops one it can't
 * resolve) — and the API's write-once/first-touch semantics mean sending it
 * on every sign-in is harmless for a returning user with existing
 * attribution. The stamp is
 * cleared after a successful provision so it's consumed exactly once; a call
 * made with no stamp present preserves the exact bodyless `upsertMe()` every
 * pre-Phase-7 caller sends.
 *
 * Returns whether `users/{uid}` was actually written: `true` once `upsertMe`
 * resolves, `false` from the catch. This boolean is what gates the
 * post-provision profile-query refresh in `provisionAndRefreshProfile` below —
 * `provisionUser` itself still never throws.
 */
async function provisionUser(): Promise<boolean> {
  try {
    const referredByShareId = shareReferral.read();
    if (referredByShareId) {
      await api.users.upsertMe({ referredByShareId });
      shareReferral.clear();
    } else {
      await api.users.upsertMe();
    }
    return true;
  } catch (error) {
    console.error('Failed to provision user profile after sign-in', error);
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  // `updateProfile` mutates the FirebaseUser object in place — the object
  // keeps its identity and `onAuthStateChanged` never fires — so consumers
  // holding `user` would render stale profile data. Bumping this version
  // invalidates the memoized context value, forcing consumers to re-read.
  const [profileVersion, setProfileVersion] = useState(0);
  const queryClient = useQueryClient();
  // FB-01: tracks the previously observed authenticated uid so every
  // uid transition (null->uidB, uidA->uidB, uidA->null) clears the whole
  // TanStack Query cache — otherwise a signed-out->signed-in-as-another-
  // account flow can render the previous account's cached VODs/notes/shares.
  const previousUidRef = useRef<string | null>(null);
  // Guards the very first onAuthStateChanged callback (app boot, restored
  // session or null) from wiping a freshly hydrated cache.
  const isFirstRunRef = useRef(true);
  // Holds the most recent FB-01 cancel/clear chain (or an already-resolved
  // promise before the first uid transition). `provisionAndRefreshProfile`
  // awaits this before invalidating the profile query: `queryClient.clear()`
  // removes every cached query, so if it landed AFTER our invalidation it
  // would remove the freshly-invalidated profile query, leaving the mounted
  // observer stuck on a destroyed query — the terminal `.catch` below keeps a
  // cancel/clear rejection from propagating into the sign-in call chain that
  // now awaits this ref.
  const cacheResetChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (nextUser) => {
      const nextUid = nextUser?.uid ?? null;
      if (!isFirstRunRef.current && previousUidRef.current !== nextUid) {
        // Cancel first so an in-flight response for the OLD uid cannot
        // settle into the cache after it's been cleared.
        cacheResetChainRef.current = queryClient
          .cancelQueries()
          .then(() => queryClient.clear())
          .catch(() => {});
      }
      isFirstRunRef.current = false;
      previousUidRef.current = nextUid;
      setUser(nextUser);
      setLoading(false);
    });
    return unsubscribe;
  }, [queryClient]);

  /**
   * Provisions the signed-in user, then — only if that provision actually
   * wrote `users/{uid}` — refreshes the `['profile']` query so `useProfile`
   * stops parking on its earlier 404 (the client deliberately never retries a
   * 4xx, so nothing else would ever unstick it). A failed provision reports
   * no signal: invalidating on failure would just refetch into the same
   * still-missing profile, wasting a request for zero benefit. The cache
   * reset chain from the FB-01 effect above is awaited FIRST so a
   * still-in-flight `clear()` can never remove the query this just
   * invalidated.
   */
  const provisionAndRefreshProfile = useCallback(async () => {
    const provisioned = await provisionUser();
    if (!provisioned) {
      return;
    }
    await cacheResetChainRef.current;
    await queryClient.invalidateQueries({ queryKey: profileQueryKey });
  }, [queryClient]);

  // ONBD-01/D-03, RESEARCH.md Pattern 1/Pitfall 1: completes a
  // `signInWithRedirect` that just finished — runs once per app boot,
  // independent of `signInWithGoogle`'s own lifecycle (which returned
  // before reaching its own `provisionAndRefreshProfile()` call for the
  // redirect branch, since the browser navigated away). `getRedirectResult`
  // resolves with `null` (a no-op) on every ordinary page load that
  // ISN'T the tail end of a redirect, so this is safe to run
  // unconditionally on every boot. Mirrors `provisionUser`'s own
  // error-swallow discipline — a redirect-completion failure must never
  // block the rest of sign-in from working.
  useEffect(() => {
    getRedirectResult(getFirebaseAuth())
      .then((credential) => {
        if (credential) {
          void provisionAndRefreshProfile();
        }
      })
      .catch((error) => {
        console.error('Redirect sign-in failed', error);
      });
  }, [provisionAndRefreshProfile]);

  const value = useMemo<AuthContextValue>(() => {
    // Reading profileVersion here keeps it an honest dependency: its bump is
    // what refreshes this value (and every consumer) after an in-place
    // profile mutation.
    void profileVersion;
    return {
      user,
      loading,
      signInWithEmail: async (email, password) => {
        await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
        await provisionAndRefreshProfile();
      },
      signUpWithEmail: async (email, password) => {
        await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
        await provisionAndRefreshProfile();
      },
      signInWithGoogle: async () => {
        // MEAS-09: fired at the CTA activation, before the popup — this is
        // the acquisition-funnel signal for "a visitor tried to sign in",
        // distinct from `signup_completed` (server-only D event, fired only
        // on successful first-ever provisioning in users.ts).
        postCanonicalEvent('signup_cta_clicked');
        try {
          await signInWithPopup(getFirebaseAuth(), createGoogleAuthProvider());
          await provisionAndRefreshProfile();
        } catch (error) {
          if ((error as { code?: string }).code === 'auth/popup-blocked') {
            // ONBD-01/D-03, RESEARCH.md Pitfall 1: `signInWithRedirect`
            // navigates the browser AWAY immediately — nothing after this
            // line ever runs for THIS attempt (this component instance is
            // about to be torn down). The completion handshake
            // (`provisionAndRefreshProfile()` for the redirect branch)
            // happens in a SEPARATE lifecycle: the boot-time
            // `getRedirectResult` effect below, which survives the full-page
            // round trip. Only the genuine popup-blocked case redirects —
            // `auth/popup-closed-by-user` (a real user cancel) is untouched
            // and still re-thrown to SignInCard's existing FB-02
            // grace-timer/toast handling.
            await signInWithRedirect(getFirebaseAuth(), createGoogleAuthProvider());
            return;
          }
          throw error;
        }
      },
      signInWithToken: async (customToken) => {
        await signInWithCustomToken(getFirebaseAuth(), customToken);
        await provisionAndRefreshProfile();
      },
      signOut: async () => {
        await firebaseSignOut(getFirebaseAuth());
      },
      getIdToken: async () => {
        const current = getFirebaseAuth().currentUser;
        return current ? current.getIdToken() : null;
      },
      changePassword: async (currentPassword, nextPassword) => {
        const current = getFirebaseAuth().currentUser;
        if (!current?.email) {
          throw new Error('No signed-in email/password account.');
        }
        await reauthenticateWithCredential(
          current,
          EmailAuthProvider.credential(current.email, currentPassword),
        );
        await updatePassword(current, nextPassword);
      },
      sendPasswordReset: async (email) => {
        await sendPasswordResetEmail(getFirebaseAuth(), email);
      },
      updateDisplayName: async (displayName) => {
        const current = getFirebaseAuth().currentUser;
        if (!current) {
          throw new Error('No signed-in account.');
        }
        await updateProfile(current, { displayName });
        setProfileVersion((version) => version + 1);
      },
    };
  }, [user, loading, profileVersion, provisionAndRefreshProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
