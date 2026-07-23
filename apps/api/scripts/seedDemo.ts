import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { runSeedDemo } from './seed/personalDataset.js';
import { wipeDemo } from './seed/manifest.js';

/**
 * Phase 14 (SEED-01): the `pnpm --filter @smash-tracker/api seed:demo --
 * --uid <uid> [--wipe]` CLI entrypoint. Thin I/O shell over the tested
 * `runSeedDemo`/`wipeDemo` (see `scripts/seed/seedDemo.test.ts`) — this file
 * is not unit-tested directly, only typecheck + lint + the orchestrator's
 * own FakeDatabase suite cover it.
 *
 * Import surface is limited to `../src/config/env.js`,
 * `../src/firebase/admin.js`, `./seed/personalDataset.js`, `./seed/manifest.js`,
 * and `firebase-admin/app` (for teardown) — no import from `../src/events`,
 * `routes`, `jobs`, `coaching`, `billing`, or `onboarding` (SEED-06).
 */

interface CliArgs {
  uid: string;
  wipe: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let uid: string | undefined;
  let wipe = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--uid') {
      uid = argv[i + 1];
      i += 1;
    } else if (arg === '--wipe') {
      wipe = true;
    }
  }

  if (uid === undefined || uid.length === 0) {
    console.error('--uid <uid> is required');
    process.exit(1);
  }

  return { uid, wipe };
}

async function main(): Promise<void> {
  const { uid, wipe } = parseArgs(process.argv.slice(2));

  let env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
    return;
  }

  const firebase = initFirebase(env);

  // T-14-01: log the resolved target before any write so the operator can
  // visually confirm the destination (database host + uid) — no default uid
  // exists, and this is the last chance to Ctrl-C before writes begin.
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;
  console.log(
    `${wipe ? 'Wiping' : 'Seeding'} demo data for uid "${uid}" against database host "${databaseHost}"`,
  );

  try {
    if (wipe) {
      await wipeDemo(firebase.database, uid);
      console.log(`Wiped demo data for uid "${uid}"`);
    } else {
      await runSeedDemo(firebase.database, { uid, now: Date.now() });
      console.log(`Seeded demo data for uid "${uid}"`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // T-14-04: the Admin SDK keeps the event loop alive otherwise — tear it
    // down explicitly on every path (success AND error) so the process
    // always exits. (`App` has no instance `.delete()` in firebase-admin
    // 14.x — teardown is the top-level `deleteApp(app)` function.)
    await deleteApp(firebase.app);
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

void main();
