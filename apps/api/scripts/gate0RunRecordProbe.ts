/**
 * GATE 0 FORENSICS — run-record evidence dump (READ-ONLY).
 * Prints the verbatim researchEnrichmentRuns record for hbox + mkleo so the
 * terminal states (completed / failed+reason) are preserved in planning
 * artifacts. Zero writes; prompt termination.
 */
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const env = loadEnv();
  const { app, database } = initFirebase(env);
  const targets: Record<string, string> = {
    hbox: 'B4AoA73kJ2dlk9B61POUsTUjM6w2',
    mkleo: 'eVJih9SgfJVk5oMPAQydPGbEBpU2',
  };
  try {
    for (const [label, uid] of Object.entries(targets)) {
      const snapshot = await database.ref(`researchEnrichmentRuns/${uid}`).get();
      console.log(`## ${label} (${uid})`);
      console.log(JSON.stringify(snapshot.val(), null, 2));
    }
  } finally {
    database.goOffline();
    await deleteApp(app);
  }
}

void main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
