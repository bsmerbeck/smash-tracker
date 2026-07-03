import { vi } from 'vitest';
import type { User as FirebaseUser } from 'firebase/auth';

/**
 * Shared `firebase/auth` mock used by component tests. Import and call
 * `vi.mock('firebase/auth', () => mockFirebaseAuthModule)` (hoisted mocks
 * can't close over outer variables, so this lives in its own module and the
 * mock functions are exported directly for assertions/control).
 *
 * Usage in a test file:
 * ```ts
 * vi.mock('firebase/auth', () => import('@/test/mockAuth').then((m) => m.firebaseAuthMockModule));
 * ```
 * or, more simply, call `setMockUser(...)` / `triggerAuthStateChanged(...)`
 * after mocking with `vi.mock('firebase/auth')` + `vi.mocked`.
 */
let currentUser: FirebaseUser | null = null;
let authStateListener: ((user: FirebaseUser | null) => void) | null = null;

/**
 * Mock `Auth` instance. Real Firebase keeps `auth.currentUser` in sync
 * internally; `src/lib/api.ts` reads `getFirebaseAuth().currentUser`
 * directly (not through AuthContext), so the mock needs the same property —
 * a live getter backed by `currentUser` below, not a snapshot copy.
 */
const mockAuthInstance = {
  get currentUser() {
    return currentUser;
  },
};

export const onAuthStateChanged = vi.fn(
  (_auth: unknown, callback: (user: FirebaseUser | null) => void) => {
    authStateListener = callback;
    callback(currentUser);
    return () => {
      authStateListener = null;
    };
  },
);

export const signInWithEmailAndPassword = vi.fn();
export const createUserWithEmailAndPassword = vi.fn();
export const signInWithPopup = vi.fn();
export const signOut = vi.fn();
export const getAuth = vi.fn(() => mockAuthInstance);

export class GoogleAuthProvider {}

/** Sets the mocked signed-in user and notifies any subscribed `onAuthStateChanged` listener. */
export function setMockUser(user: FirebaseUser | null) {
  currentUser = user;
  authStateListener?.(user);
}

export function resetAuthMock() {
  currentUser = null;
  authStateListener = null;
  onAuthStateChanged.mockClear();
  signInWithEmailAndPassword.mockReset();
  createUserWithEmailAndPassword.mockReset();
  signInWithPopup.mockReset();
  signOut.mockReset();
}

export function makeMockUser(overrides: Partial<FirebaseUser> = {}): FirebaseUser {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    getIdToken: vi.fn().mockResolvedValue('mock-id-token'),
    ...overrides,
  } as unknown as FirebaseUser;
}

/**
 * Mock for `@/lib/firebase` (the module boundary `AuthContext` and `api.ts`
 * both import through). Returns the same `mockAuthInstance` used by the
 * `firebase/auth` function mocks above, so `getFirebaseAuth().currentUser`
 * stays consistent with whatever `setMockUser` last set.
 */
export function firebaseLibMock() {
  return {
    getFirebaseAuth: vi.fn(() => mockAuthInstance),
    getFirebaseApp: vi.fn(() => ({})),
    createGoogleAuthProvider: vi.fn(() => new GoogleAuthProvider()),
  };
}
