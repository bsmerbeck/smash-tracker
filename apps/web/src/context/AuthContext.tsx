import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createGoogleAuthProvider, getFirebaseAuth } from '@/lib/firebase';
import { api } from '@/lib/api';

export interface AuthContextValue {
  user: FirebaseUser | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Idempotent user provisioning: replaces the deleted Cloud Function's
 * `onCreate` auth trigger. Called after every successful sign-in/sign-up so
 * `users/{uid}` always exists before any other API call needs it. Errors are
 * swallowed (logged only) — provisioning failure shouldn't block the user
 * from being considered signed in on the client; subsequent API calls will
 * surface a clearer error if the profile is genuinely missing.
 */
async function provisionUser(): Promise<void> {
  try {
    await api.users.upsertMe();
  } catch (error) {
    console.error('Failed to provision user profile after sign-in', error);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
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
        await signInWithPopup(getFirebaseAuth(), createGoogleAuthProvider());
        await provisionUser();
      },
      signOut: async () => {
        await firebaseSignOut(getFirebaseAuth());
      },
      getIdToken: async () => {
        const current = getFirebaseAuth().currentUser;
        return current ? current.getIdToken() : null;
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
