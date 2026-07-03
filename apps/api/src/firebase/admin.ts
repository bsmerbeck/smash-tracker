import { applicationDefault, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import type { Env } from '../config/env.js';

export interface FirebaseServices {
  app: App;
  auth: Auth;
  database: Database;
}

/**
 * Initializes the firebase-admin SDK from validated env.
 *
 * - Real usage: `GOOGLE_APPLICATION_CREDENTIALS` points at a service account
 *   JSON file; `applicationDefault()` picks it up automatically.
 * - Local/emulator usage: set `FIREBASE_DATABASE_EMULATOR_HOST` (e.g.
 *   `127.0.0.1:9000`) and the Admin SDK's Database client will talk to the
 *   emulator instead of production, without needing real credentials.
 *
 * `FIREBASE_DATABASE_URL` is always required so the SDK knows which
 * database instance to address in both cases.
 */
export function initFirebase(env: Env): FirebaseServices {
  const app = initializeApp({
    credential: applicationDefault(),
    databaseURL: env.FIREBASE_DATABASE_URL,
  });

  const auth = getAuth(app);
  const database = getDatabase(app);

  return { app, auth, database };
}
