import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { z } from 'zod';

/**
 * Firebase Web SDK config, sourced from Vite env vars. Auth only — the web
 * client never touches Realtime Database directly; all data access goes
 * through the Fastify API (see src/lib/api.ts).
 *
 * Validation is lazy (deferred to first access via `getFirebaseApp`/`getFirebaseAuth`)
 * rather than at module load time, so importing this module never throws.
 * That matters for the test environment: Vitest doesn't load `.env` files by
 * default, and unit tests mock `firebase/auth` at the module boundary anyway
 * (see src/test/setup.ts), so they never need real env vars to be present.
 */
const firebaseConfigSchema = z.object({
  apiKey: z.string().min(1, 'VITE_FIREBASE_API_KEY is required'),
  authDomain: z.string().min(1, 'VITE_FIREBASE_AUTH_DOMAIN is required'),
  projectId: z.string().min(1, 'VITE_FIREBASE_PROJECT_ID is required'),
  appId: z.string().min(1, 'VITE_FIREBASE_APP_ID is required'),
});

export type FirebaseConfig = z.infer<typeof firebaseConfigSchema>;

function readFirebaseConfig(): FirebaseConfig {
  const result = firebaseConfigSchema.safeParse({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });

  if (!result.success) {
    throw new Error(
      `Invalid Firebase web config: ${result.error.issues.map((issue) => issue.message).join(', ')}. Copy apps/web/.env.example to apps/web/.env and fill in real values.`,
    );
  }

  return result.data;
}

let cachedApp: FirebaseApp | undefined;
let cachedAuth: Auth | undefined;

/** Lazily initializes (once) and returns the Firebase app instance. */
export function getFirebaseApp(): FirebaseApp {
  cachedApp ??= initializeApp(readFirebaseConfig());
  return cachedApp;
}

/** Lazily initializes (once) and returns the Firebase Auth instance. */
export function getFirebaseAuth(): Auth {
  cachedAuth ??= getAuth(getFirebaseApp());
  return cachedAuth;
}

export function createGoogleAuthProvider(): GoogleAuthProvider {
  return new GoogleAuthProvider();
}
