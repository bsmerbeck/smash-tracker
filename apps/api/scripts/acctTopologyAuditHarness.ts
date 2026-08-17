/**
 * Codex hard gate at `fb9a3930` (P1, prompt termination): child-process harness
 * for `acctTopologyAuditLifecycle.test.ts`. NOT a production entry point and
 * never part of the build output (`tsconfig.build.json` excludes `scripts/`).
 *
 * It composes the REAL audit core (`auditAcctTopology`) with the REAL lifecycle
 * wrapper (`runWithLifecycle`) over fake dependencies: an in-memory
 * `FakeDatabase` or a deliberately unresponsive stand-in, plus an artificial
 * open handle standing in for the firebase-admin RTDB connection. No Firebase,
 * no network, no disk.
 *
 * THE DEFECT THIS PROVES CLOSED. The first revision of this operator issued
 * sequential `.get()` calls with no request deadline, no heartbeat, no watchdog,
 * no signal handling and no hard-exit backstop, and called `goOffline()` only
 * after every read resolved. One stalled read therefore hung it forever — the
 * same failure class that left `enrichDemoAccounts.ts` looking alive for 80+
 * minutes after death.
 *
 * Modes:
 * - `success`         a real audit against a seeded fake corpus with all four
 *                     source tenants archived -> exit 0.
 * - `finding`         one source tenant left active -> exit 1 (terminates
 *                     promptly on the failure path too).
 * - `request-timeout` every read hangs; the per-read deadline must fire -> 1.
 * - `stall`           every read hangs with a generous request timeout; the
 *                     no-progress watchdog must fire -> 1.
 * - `interrupt`       every read hangs with generous bounds; the parent sends
 *                     SIGINT after the ready marker -> exit 130.
 * - `throw`           the first read rejects -> exit 1, cleanup still runs.
 *
 * stdout markers (`audit-settled`, `cleanup-start`, `cleanup-complete`) let the
 * test distinguish a natural exit from a backstop-forced one, and
 * `HARNESS_READY_MARKER` is the child-ready synchronization point the
 * interruption test waits on instead of sleeping.
 */
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import { HARNESS_READY_MARKER } from './harnessReadyMarker.js';
import {
  auditAcctTopology,
  type AcctTopologySourceTenant,
  type AcctTopologySubject,
} from './acctTopologyAuditCore.js';

const mode = process.argv[2] ?? 'success';
const hardExitMs = Number(process.argv[3] ?? '1500');

const COACH_UID = 'harness-coach-uid-000001';
const OTHER_TENANT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const SOURCES: AcctTopologySourceTenant[] = [
  {
    sourceId: 's1111111-1111-4111-8111-111111111111',
    destUid: 'harness-hbox-uid-00001',
    label: 'Hungrybox',
  },
  {
    sourceId: 's2222222-2222-4222-8222-222222222222',
    destUid: 'harness-mkleo-uid-0001',
    label: 'MkLeo',
  },
  {
    sourceId: 's3333333-3333-4333-8333-333333333333',
    destUid: 'harness-sparg0-uid-001',
    label: 'Sparg0',
  },
  {
    sourceId: 's4444444-4444-4444-8444-444444444444',
    destUid: 'harness-izaw-uid-00001',
    label: 'IzAw',
  },
];

const SUBJECTS: AcctTopologySubject[] = SOURCES.map((s) => ({
  label: s.label.toLowerCase(),
  uid: s.destUid,
}));

// The artificial open handle: without lifecycle management this alone makes the
// process immortal, exactly like the leaked RTDB connection did.
const openHandle = setInterval(() => undefined, 1_000);

/** A seeded fake corpus. `activeSourceCount` sources are left visible. */
function seededDatabase(activeSourceCount: number): Database {
  const database = new FakeDatabase();
  database.seed(`coachClients/${COACH_UID}/${OTHER_TENANT}`, {
    label: 'A real client',
    createdAt: 1,
    archivedAt: null,
  });
  SOURCES.forEach((source, index) => {
    const archivedAt = index < activeSourceCount ? null : 1_700_000_000_000;
    database.seed(`coachClients/${COACH_UID}/${source.sourceId}`, {
      label: source.label,
      createdAt: 1,
      archivedAt,
    });
    database.seed(`clientTenants/${source.sourceId}`, {
      createdAt: 1,
      archivedAt,
      kind: 'research',
    });
  });
  return database as unknown as Database;
}

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

/** An RTDB whose first read rejects. */
function throwingDatabase(): Database {
  return {
    ref: () => ({
      key: null,
      get: () => Promise.reject(new Error('harness: simulated read failure')),
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
    case 'finding':
      return {
        database: seededDatabase(1),
        requestTimeoutMs: 5_000,
        maxStallMs: 120_000,
        heartbeatIntervalMs: 60_000,
      };
    case 'throw':
      return {
        database: throwingDatabase(),
        requestTimeoutMs: 5_000,
        maxStallMs: 120_000,
        heartbeatIntervalMs: 60_000,
      };
    case 'request-timeout':
      // Inverted bounds: the per-read DEADLINE fires long before the watchdog.
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
        maxStallMs: 900,
        heartbeatIntervalMs: 200,
      };
    case 'interrupt':
      // Both bounds generous: only the SIGNAL can end this run.
      return {
        database: hangingDatabase(true),
        requestTimeoutMs: 120_000,
        maxStallMs: 120_000,
        heartbeatIntervalMs: 200,
      };
    default:
      return {
        database: seededDatabase(0),
        requestTimeoutMs: 5_000,
        maxStallMs: 120_000,
        heartbeatIntervalMs: 60_000,
      };
  }
}

const plan = planFor();

void runWithLifecycle({
  hardExitMs,
  run: async (signal) => {
    const result = await auditAcctTopology(plan.database, {
      coachUid: COACH_UID,
      subjects: SUBJECTS,
      sourceTenants: SOURCES,
      requestTimeoutMs: plan.requestTimeoutMs,
      maxStallMs: plan.maxStallMs,
      heartbeatIntervalMs: plan.heartbeatIntervalMs,
      signal,
    });
    console.log(`audit-settled findings=${result.findings.length} ok=${result.ok}`);
    return result.ok ? 0 : 1;
  },
  cleanup: async () => {
    console.log('cleanup-start');
    clearInterval(openHandle);
    await Promise.resolve();
    console.log('cleanup-complete');
  },
}).then((exitCode) => {
  process.exit(exitCode);
});
