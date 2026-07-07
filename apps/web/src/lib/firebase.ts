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
  /**
   * GA4 measurement id (G-XXXX). Optional: analytics is skipped entirely
   * when unset (local dev, tests), so unit tests never load
   * firebase/analytics and dev sessions don't pollute production stats.
   */
  measurementId: z.string().optional(),
});

export type FirebaseConfig = z.infer<typeof firebaseConfigSchema>;

function readFirebaseConfig(): FirebaseConfig {
  const result = firebaseConfigSchema.safeParse({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
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

// ---------------------------------------------------------------------------
// Analytics (GA4 via Firebase). The legacy CRA app reported analytics; the
// rewrite shipped without them, so the Firebase console showed 0 active
// users despite real traffic. Everything here is lazy + optional:
// firebase/analytics is dynamically imported only when a measurementId is
// configured AND the browser supports it (isSupported() is false in jsdom,
// some privacy modes, and non-browser contexts), so tests and dev builds
// never touch it.

type AnalyticsContext = {
  analytics: import('firebase/analytics').Analytics;
  mod: typeof import('firebase/analytics');
};

let analyticsInit: Promise<AnalyticsContext | null> | null = null;

function initAnalytics(): Promise<AnalyticsContext | null> {
  analyticsInit ??= (async () => {
    const config = readFirebaseConfig();
    if (!config.measurementId) {
      return null;
    }
    const mod = await import('firebase/analytics');
    if (!(await mod.isSupported().catch(() => false))) {
      return null;
    }
    // cookie_domain must be pinned to the exact host: the app lives on
    // *.web.app, and `web.app` is on the Public Suffix List, so gtag's
    // default 'auto' domain walk tries to set _ga cookies at the web.app
    // level — browsers reject those ("invalid domain" console errors on
    // every page in Firefox) before falling back. send_page_view is off
    // because MainLayout logs page_view itself on mount + every route
    // change (the signed-out landing page is deliberately uncounted).
    const analytics = mod.initializeAnalytics(getFirebaseApp(), {
      config: {
        cookie_domain: window.location.hostname,
        send_page_view: false,
      },
    });
    return { analytics, mod };
  })().catch(() => null);
  return analyticsInit;
}

/**
 * Records an SPA page view (GA4 auto-collects only the initial load; router
 * navigations must be logged manually). Fire-and-forget and never throws —
 * analytics must never break the app. No-op without a measurementId.
 */
export function logAnalyticsPageView(pagePath: string): void {
  void initAnalytics().then((ctx) => {
    if (ctx) {
      ctx.mod.logEvent(ctx.analytics, 'page_view', {
        page_path: pagePath,
        page_location: window.location.href,
      });
    }
  });
}
