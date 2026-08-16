/**
 * Phase 30.3 registry-operator hardening: child-process harness for
 * `deriveTournamentRegistryLifecycle.test.ts`. NOT a production entry point
 * and never part of the build output (`tsconfig.build.json` excludes
 * `scripts/`).
 *
 * It composes the REAL operator core (`runRegistryOperator`) with the REAL
 * lifecycle wrapper (`runWithLifecycle`) over fake dependencies: an
 * in-memory `FakeDatabase` or a deliberately broken stand-in, an in-memory
 * filesystem, and an artificial open handle standing in for the firebase-
 * admin RTDB connection that kept the enrichment operator alive 80+ minutes
 * after death. No Firebase, no network, no disk.
 *
 * Modes — one per row of the required termination matrix:
 * - `success`         a real dry-run against seeded fake data -> exit 0.
 * - `schema-failure`  apply against a manifest that fails validation -> exit 1.
 * - `network-failure` every RTDB read rejects (connection refused) -> exit 1.
 * - `stall`           every RTDB read hangs forever; the no-progress
 *                     watchdog must abort the run -> exit 1.
 * - `request-timeout` every RTDB read hangs forever; the per-operation
 *                     deadline must fire first -> exit 1.
 * - `interrupt`       every RTDB read hangs forever with generous bounds;
 *                     the parent sends SIGINT -> exit 130.
 * - `hang-cleanup`    a successful run whose cleanup NEVER releases the open
 *                     handle; the unref'd hard-exit backstop must force the
 *                     exit at `hardExitMs`.
 *
 * stdout markers (`operator-settled`, `cleanup-start`, `cleanup-complete`)
 * let the test distinguish a natural exit from a backstop-forced one.
 */
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import type { ResearchSourceSetRecord } from '@smash-tracker/shared';
import { runRegistryOperator, type RegistryOperatorDeps } from './deriveTournamentRegistryCore.js';
import { runWithLifecycle } from './enrichLifecycle.js';

const mode = process.argv[2] ?? 'success';
const hardExitMs = Number(process.argv[3] ?? '1500');

const UIDS = {
  hbox: 'harness-hbox-uid-00000001',
  mkleo: 'harness-mkleo-uid-0000001',
  sparg0: 'harness-sparg0-uid-000001',
  izaw: 'harness-izaw-uid-00000001',
};

// The artificial open handle: without lifecycle management this alone makes
// the process immortal, exactly like the leaked RTDB connection did.
const openHandle = setInterval(() => undefined, 1_000);

function makeRecord(providerSetId: string, eventId: string): ResearchSourceSetRecord {
  return {
    providerSetId,
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    apiIds: { setId: providerSetId, eventId },
    ingestionRunId: 'harness-run',
    fetchedAtMs: 1_754_000_000_000,
    lastObservedAtMs: 1_754_000_000_000,
    completedAt: 1_700_000_000,
    event: {
      eventId,
      name: 'Ultimate Singles',
      slug: `tournament/major-${eventId}/event/ultimate-singles`,
      tournamentName: `Major ${eventId}`,
      tournamentSlug: `tournament/major-${eventId}`,
      numEntrants: 128,
    },
    subjectEntrantId: 'e-subject',
    entrants: [{ entrantId: 'e-subject', name: 'Subject', seedNum: 5, placement: 3 }],
  };
}

function seededDatabase(): Database {
  const database = new FakeDatabase();
  database.seed(`researchSource/${UIDS.hbox}/sets/s1`, makeRecord('s1', '100'));
  database.seed(`researchSource/${UIDS.hbox}/sets/s2`, makeRecord('s2', '200'));
  return database as unknown as Database;
}

/** A database whose every read fails or hangs — the two shapes an unreachable RTDB takes. */
function brokenDatabase(kind: 'reject' | 'hang'): Database {
  const makeRef = (): unknown => ({
    key: null,
    get: () =>
      kind === 'reject'
        ? Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9000'))
        : new Promise(() => undefined),
    transaction: () =>
      kind === 'reject'
        ? Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9000'))
        : new Promise(() => undefined),
  });
  return { ref: () => makeRef() } as unknown as Database;
}

function baseArgs(command: string): string[] {
  return [
    command,
    '--account',
    'hbox',
    '--hbox-uid',
    UIDS.hbox,
    '--mkleo-uid',
    UIDS.mkleo,
    '--sparg0-uid',
    UIDS.sparg0,
    '--izaw-uid',
    UIDS.izaw,
    '--receipt-dir',
    '/harness-receipts',
  ];
}

interface HarnessPlan {
  database: Database;
  argv: string[];
  files: Map<string, string>;
}

function planFor(): HarnessPlan {
  const files = new Map<string, string>();
  switch (mode) {
    case 'schema-failure':
      // Structurally invalid manifest: fails the strict zod parse before any
      // database work happens.
      files.set('/harness/manifest.json', JSON.stringify({ formatVersion: 1, nonsense: true }));
      return {
        database: seededDatabase(),
        argv: [...baseArgs('apply'), '--manifest-in', '/harness/manifest.json'],
        files,
      };
    case 'network-failure':
      return {
        database: brokenDatabase('reject'),
        argv: [...baseArgs('dry-run'), '--manifest-out', '/harness/out.json'],
        files,
      };
    case 'stall':
      return {
        database: brokenDatabase('hang'),
        argv: [
          ...baseArgs('dry-run'),
          '--manifest-out',
          '/harness/out.json',
          '--max-stall-ms',
          '700',
          '--heartbeat-ms',
          '200',
          // Deliberately far beyond the stall bound so the WATCHDOG is what fires.
          '--request-timeout-ms',
          '120000',
        ],
        files,
      };
    case 'request-timeout':
      return {
        database: brokenDatabase('hang'),
        argv: [
          ...baseArgs('dry-run'),
          '--manifest-out',
          '/harness/out.json',
          // Inverted bounds: the per-operation DEADLINE fires long before the
          // stall watchdog would.
          '--max-stall-ms',
          '120000',
          '--request-timeout-ms',
          '600',
        ],
        files,
      };
    case 'interrupt':
      return {
        database: brokenDatabase('hang'),
        argv: [
          ...baseArgs('dry-run'),
          '--manifest-out',
          '/harness/out.json',
          '--max-stall-ms',
          '600000',
          '--request-timeout-ms',
          '600000',
        ],
        files,
      };
    default:
      return {
        database: seededDatabase(),
        argv: [...baseArgs('dry-run'), '--manifest-out', '/harness/out.json'],
        files,
      };
  }
}

const plan = planFor();

void runWithLifecycle({
  hardExitMs,
  log: (line) => console.log(line),
  run: async (signal) => {
    const deps: RegistryOperatorDeps = {
      database: plan.database,
      databaseHost: 'harness-db.firebaseio.com',
      now: () => Date.now(),
      log: (line) => console.log(line),
      table: (rows) => console.log(`[table] ${JSON.stringify(rows)}`),
      readFileText: async (path) => {
        const content = plan.files.get(path);
        if (content === undefined) {
          throw new Error(`ENOENT: no such file '${path}'`);
        }
        return content;
      },
      writeFileText: async (path) => {
        console.log(`wrote ${path}`);
      },
      signal,
    };
    const code = await runRegistryOperator(plan.argv, deps);
    console.log(`operator-settled ${code}`);
    return code;
  },
  cleanup: async () => {
    console.log('cleanup-start');
    if (mode !== 'hang-cleanup') {
      clearInterval(openHandle);
    }
    console.log('cleanup-complete');
  },
});
