import { loadEnv } from '../../../apps/api/src/config/env.js';

const EXPECTED_DB_HOST = 'smash-tracker-f97b7.firebaseio.com';

// process.loadEnvFile() preserves already-exported variables. Check the two
// database-targeting values before reading apps/api/.env so an inherited dev or
// emulator target cannot shadow the reviewed file.
const inherited: string[] = [];
if (process.env.FIREBASE_DATABASE_URL !== undefined) inherited.push('FIREBASE_DATABASE_URL');
if (process.env.FIREBASE_DATABASE_EMULATOR_HOST !== undefined) {
  inherited.push('FIREBASE_DATABASE_EMULATOR_HOST');
}
if (inherited.length > 0) {
  console.error(
    `FATAL: inherited from this shell and would shadow apps/api/.env: ${inherited.join(', ')}`,
  );
  console.error(
    'FATAL: unset FIREBASE_DATABASE_URL and FIREBASE_DATABASE_EMULATOR_HOST in this shell, then retry.',
  );
  process.exit(1);
}

try {
  process.loadEnvFile('.env');
} catch (error) {
  console.error(`FATAL: could not read apps/api/.env — ${(error as Error).message}`);
  process.exit(1);
}

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  console.error(`FATAL: loadEnv() rejected the effective environment — ${(error as Error).message}`);
  process.exit(1);
}

let host: string;
try {
  host = new URL(env.FIREBASE_DATABASE_URL).host;
} catch {
  console.error('FATAL: effective FIREBASE_DATABASE_URL is not a parseable URL');
  process.exit(1);
}

let ok = true;
if (host === EXPECTED_DB_HOST) {
  console.log(`OK: effective database host ${host}`);
} else {
  console.error(`FATAL: effective database host ${host} (expected ${EXPECTED_DB_HOST})`);
  ok = false;
}

if (env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error(
    `FATAL: effective emulator host active (${env.FIREBASE_DATABASE_EMULATOR_HOST}) — operators would target the emulator`,
  );
  ok = false;
} else {
  console.log('OK: no effective emulator host');
}

console.log(
  ok
    ? 'API ENV PREFLIGHT PASSED — effective config targets production RTDB, no emulator, nothing inherited'
    : 'API ENV PREFLIGHT FAILED',
);
process.exit(ok ? 0 : 1);
