import { z } from 'zod';

/**
 * Startup environment validation. Fails fast with a readable message if
 * required vars are missing/malformed rather than letting the app boot into
 * a broken state.
 *
 * - `FIREBASE_DATABASE_URL` is always required — it tells the Admin SDK
 *   which Realtime Database instance to talk to (works for both the real
 *   database and the RTDB emulator).
 * - Credentials come from Application Default Credentials, which
 *   `applicationDefault()` resolves automatically: a service account JSON
 *   file when `GOOGLE_APPLICATION_CREDENTIALS` points at one (typical for
 *   local development), or the runtime service account's metadata-server
 *   credentials when running on Cloud Run/GCE/GKE (no env var needed there).
 *   `GOOGLE_APPLICATION_CREDENTIALS` is therefore never required here — it's
 *   also unnecessary for local/emulator use, which is supported via
 *   `FIREBASE_DATABASE_EMULATOR_HOST` and needs no real credentials at all.
 * - `PORT` defaults to 3001 but is read from `process.env.PORT` in
 *   production — Cloud Run injects `PORT` at runtime and the server must
 *   listen on it.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  FIREBASE_DATABASE_URL: z.string().min(1, 'FIREBASE_DATABASE_URL is required'),
  FIREBASE_DATABASE_EMULATOR_HOST: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Comma-separated list of allowed origins, e.g.
  // "https://smash-tracker-f97b7.web.app,https://smash-tracker-f97b7.firebaseapp.com".
  // Production traffic is same-origin via the Firebase Hosting rewrite, so
  // this mainly matters for local dev and as a belt-and-braces fallback.
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

/** Splits `CORS_ORIGIN` on commas into a trimmed list of allowed origins. */
export function parseCorsOrigins(corsOrigin: string): string[] {
  return corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
