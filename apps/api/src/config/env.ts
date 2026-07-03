import { z } from 'zod';

/**
 * Startup environment validation. Fails fast with a readable message if
 * required vars are missing/malformed rather than letting the app boot into
 * a broken state.
 *
 * - `FIREBASE_DATABASE_URL` is always required — it tells the Admin SDK
 *   which Realtime Database instance to talk to (works for both the real
 *   database and the RTDB emulator).
 * - Credentials come from `GOOGLE_APPLICATION_CREDENTIALS` (a path to a
 *   service account JSON file), which `applicationDefault()` reads
 *   automatically. It is not required here because local/emulator use is
 *   supported via `FIREBASE_DATABASE_EMULATOR_HOST`, which lets the Admin
 *   SDK connect without real credentials.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  FIREBASE_DATABASE_URL: z.string().min(1, 'FIREBASE_DATABASE_URL is required'),
  FIREBASE_DATABASE_EMULATOR_HOST: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
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
