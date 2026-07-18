import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updatePassword,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createGoogleAuthProvider, getFirebaseAuth } from '@/lib/firebase';
import { api } from '@/lib/api';
import { postCanonicalEvent } from '@/lib/canonicalEvents';
import * as shareReferral from '@/lib/shareReferral';

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
 */
async function provisionUser(): Promise<void> {
  try {
    const referredByShareId = shareReferral.read();
    if (referredByShareId) {
      await api.users.upsertMe({ referredByShareId });
      shareReferral.clear();
    } else {
      await api.users.upsertMe();
    }
  } catch (error) {
    console.error('Failed to provision user profile after sign-in', error);
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

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (nextUser) => {
      const nextUid = nextUser?.uid ?? null;
      if (!isFirstRunRef.current && previousUidRef.current !== nextUid) {
        // Cancel first so an in-flight response for the OLD uid cannot
        // settle into the cache after it's been cleared.
        void queryClient.cancelQueries().then(() => queryClient.clear());
      }
      isFirstRunRef.current = false;
      previousUidRef.current = nextUid;
      setUser(nextUser);
      setLoading(false);
    });
    return unsubscribe;
  }, [queryClient]);

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
        await provisionUser();
      },
      signUpWithEmail: async (email, password) => {
        await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
        await provisionUser();
      },
      signInWithGoogle: async () => {
        // MEAS-09: fired at the CTA activation, before the popup — this is
        // the acquisition-funnel signal for "a visitor tried to sign in",
        // distinct from `signup_completed` (server-only D event, fired only
        // on successful first-ever provisioning in users.ts).
        postCanonicalEvent('signup_cta_clicked');
        await signInWithPopup(getFirebaseAuth(), createGoogleAuthProvider());
        await provisionUser();
      },
      signInWithToken: async (customToken) => {
        await signInWithCustomToken(getFirebaseAuth(), customToken);
        await provisionUser();
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
  }, [user, loading, profileVersion]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
