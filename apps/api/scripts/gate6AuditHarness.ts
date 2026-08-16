/**
 * Owner/Codex hard gate #4 (B6): child-process harness for
 * `gate6AuditLifecycle.test.ts`. NOT a production entry point and never part
 * of the build output (`tsconfig.build.json` excludes `scripts/`).
 *
 * It composes the REAL audit core (`runGate6Audit`) with the REAL lifecycle
 * wrapper (`runWithLifecycle`) over fake dependencies: an in-memory
 * `FakeDatabase` or a deliberately unresponsive stand-in, plus an artificial
 * open handle standing in for the firebase-admin RTDB connection that kept the
 * enrichment operator alive 80+ minutes after death. No Firebase, no network,
 * no disk.
 *
 * THE DEFECT THIS PROVES CLOSED. Before B6 the audit had no per-request
 * deadline, no heartbeat and no watchdog, and `runWithLifecycle` only arms its
 * hard-exit backstop AFTER the run settles. A single hung RTDB read therefore
 * hung the entire gate indefinitely — with no output, no timeout, and nothing
 * to force the exit, because the backstop was waiting for a result that was
 * never coming. The `request-timeout` and `stall` modes below are the
 * regression proof: the child must reach a terminal result and exit on its own.
 *
 * Modes:
 * - `success`         a real audit against a seeded fake corpus -> exit 1
 *                     (the fixture is deliberately empty of the expected
 *                     counts, so the ORACLE fails; what matters here is that
 *                     it terminates promptly and cleanly).
 * - `request-timeout` every RTDB read hangs forever; the per-operation
 *                     deadline must fire -> exit 1.
 * - `stall`           every RTDB read hangs forever with a generous request
 *                     timeout; the no-progress watchdog must fire -> exit 1.
 * - `interrupt`       every RTDB read hangs forever with generous bounds; the
 *                     parent sends SIGINT after the ready marker -> exit 130.
 *
 * stdout markers (`audit-settled`, `cleanup-start`, `cleanup-complete`) let
 * the test distinguish a natural exit from a backstop-forced one, and
 * `HARNESS_READY_MARKER` is the child-ready synchronization point the
 * interruption test waits on instead of sleeping.
 */
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import { runGate6Audit } from './gate6AuditCore.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import { HARNESS_READY_MARKER } from './harnessReadyMarker.js';

const mode = process.argv[2] ?? 'success';
const hardExitMs = Number(process.argv[3] ?? '1500');

const UIDS = {
  hbox: 'gate6-harness-hbox-uid-01',
  mkleo: 'gate6-harness-mkleo-uid-1',
  sparg0: 'gate6-harness-sparg0-uid1',
  izaw: 'gate6-harness-izaw-uid-01',
};

// The artificial open handle: without lifecycle management this alone makes
// the process immortal, exactly like the leaked RTDB connection did.
const openHandle = setInterval(() => undefined, 1_000);

/** An RTDB whose every read never settles — the shape an unreachable database takes. */
function hangingDatabase(announce: boolean): Database {
  let announced = false;
  return {
    ref: () => ({
      key: null,
      get: () => {
        if (announce && !announced) {
          announced = true;
          console.log(HARNESS_READY_MARKER);
        }
        return new Promise(() => undefined);
      },
    }),
  } as unknown as Database;
}

interface HarnessPlan {
  database: Database;
  requestTimeoutMs: number;
  maxStallMs: number;
  heartbeatIntervalMs: number;
}

function planFor(): HarnessPlan {
  switch (mode) {
    case 'request-timeout':
      // Inverted bounds: the per-operation DEADLINE fires long before the
      // stall watchdog would.
      return {
        database: hangingDatabase(false),
        requestTimeoutMs: 600,
        maxStallMs: 120_000,
        heartbeatIntervalMs: 200,
      };
    case 'stall':
      // Deliberately far beyond the stall bound so the WATCHDOG is what fires.
      return {
        database: hangingDatabase(false),
        requestTimeoutMs: 120_000,
        maxStallMs: 700,
        heartbeatIntervalMs: 200,
      };
    case 'interrupt':
      return {
        database: hangingDatabase(true),
        requestTimeoutMs: 600_000,
        maxStallMs: 600_000,
        heartbeatIntervalMs: 60_000,
      };
    default:
      return {
        database: new FakeDatabase() as unknown as Database,
        requestTimeoutMs: 5_000,
        maxStallMs: 60_000,
        heartbeatIntervalMs: 30_000,
      };
  }
}

const plan = planFor();

void runWithLifecycle({
  hardExitMs,
  log: (line) => console.log(line),
  run: async (signal) => {
    const receipt = await runGate6Audit(plan.database, {
      uids: UIDS,
      nowMs: Date.now(),
      expectedDatabaseHost: 'gate6-harness-db.firebaseio.com',
      requestTimeoutMs: plan.requestTimeoutMs,
      maxStallMs: plan.maxStallMs,
      heartbeatIntervalMs: plan.heartbeatIntervalMs,
      log: (line) => console.log(line),
      signal,
    });
    const code = receipt.ok ? 0 : 1;
    console.log(`audit-settled ${code} findings=${receipt.findingCount}`);
    return code;
  },
  cleanup: async () => {
    console.log('cleanup-start');
    clearInterval(openHandle);
    console.log('cleanup-complete');
  },
});
