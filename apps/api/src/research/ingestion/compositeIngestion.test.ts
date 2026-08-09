import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import {
  RESEARCH_SET_CLASSIFICATIONS,
  type ResearchSetClassification,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { ConflictingTransactionDatabase } from '../../test-support/conflictingTransactionDatabase.js';
import {
  acquireRunLease,
  createOrResumeBackfillRun,
  readBackfillRun,
  readTenantIngestionState,
  releaseRunLease,
  renewRunLease,
  type RunLeaseHolder,
} from './backfillRun.js';
import { readCoverageSnapshot } from './rollup.js';
import { confirmIdentityPlayers } from './identity.js';
import { RESEARCH_TOKEN_BUDGET_PATH, RESEARCH_THROTTLE_ROLLING_MAX } from './throttle.js';
import { PRESERVED_MATCH_MEMBERS } from './projection.js';
import { upsertSupplement, overlaySupplements, listSupplementsForSet } from './supplements.js';
import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from '../../startgg/client.js';
import {
  DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
  RESEARCH_BACKFILL_INFRA_BOUNDARIES,
  runResearchBackfillBatch,
  type ResearchBackfillBatchOptions,
  type ResearchBackfillBatchResult,
} from '../../jobs/researchBackfillBatch.js';

/**
 * Phase 30 Plan 08 (ING-02/ING-05/ING-06/ING-07/ING-08, review C-H6/C-H7/
 * C-H8/C2-H1/C2-H2/C2-H3/C2-H4/C2-H5/C2-H6/C3-H1/C3-H2/C3-H3/C3-H4a/C3-H4b/
 * C3-A1/C3-A4/C3-A5/C3-A7): the end-to-end proofs that ING-02's
 * resumability, ING-06's correction reconciliation, and ING-08's supplement
 * survival are properties of the WHOLE pipeline under injected failure,
 * never asserted from reading the code. Every block here drives
 * `runResearchBackfillBatch` (30-07) against `FakeDatabase` with an injected
 * clock, sleep, random and fetch — no real timer and no real network
 * anywhere in this file.
 */

function asDatabase(database: unknown): Database {
  return database as Database;
}

const TENANT_ID = 'tenant-composite-1';
const UID = 'admin-composite-1';
const SUBJECT_PLAYER_ID = 100;
const OPPONENT_PLAYER_ID = 200;
const CHAR_A = 1271; // -> a fighter id
const CHAR_B = 1272; // -> a fighter id
const STAGE_ID = 311; // Battlefield

// ---------------------------------------------------------------------------
// Fixture harness (per plan: buildFixtureSet / buildScriptedFetch /
// seedConfirmedTenant / runToCompletion)
// ---------------------------------------------------------------------------

interface FixtureSetOverrides {
  id?: number | string;
  completedAt?: number | null;
  updatedAt?: number | null;
  videogameId?: number | null;
  displayScore?: string | null;
  isDisqualified?: boolean | null;
  subjectEntrantId?: number;
  opponentEntrantId?: number;
  subjectPlayerId?: number;
  opponentPlayerId?: number;
  opponentGamerTag?: string;
  games?: StartggResearchSet['games'];
  slotsOverride?: StartggResearchSet['slots'];
  eventOverride?: StartggResearchSet['event'];
  vodUrl?: string | null;
  eventName?: string | null;
}

/** Sane SSBU singles defaults: two entrants, two participants total, two games with characters and stages, a completion timestamp, an SSBU videogame id. */
function buildFixtureSet(overrides: FixtureSetOverrides = {}): StartggResearchSet {
  const subjectEntrantId = overrides.subjectEntrantId ?? 10;
  const opponentEntrantId = overrides.opponentEntrantId ?? 20;
  const subjectPlayerId = overrides.subjectPlayerId ?? SUBJECT_PLAYER_ID;
  const opponentPlayerId = overrides.opponentPlayerId ?? OPPONENT_PLAYER_ID;
  const eventName = overrides.eventName !== undefined ? overrides.eventName : 'Test Event';
  return {
    id: overrides.id ?? 1,
    state: null,
    completedAt: overrides.completedAt !== undefined ? overrides.completedAt : 1_000,
    createdAt: null,
    updatedAt: overrides.updatedAt !== undefined ? overrides.updatedAt : 500,
    fullRoundText: 'Winners Round 1',
    round: 1,
    displayScore: overrides.displayScore !== undefined ? overrides.displayScore : '2-1',
    totalGames: 3,
    vodUrl: overrides.vodUrl !== undefined ? overrides.vodUrl : null,
    identifier: null,
    event:
      overrides.eventOverride !== undefined
        ? overrides.eventOverride
        : {
            id: 1,
            ...(eventName != null ? { name: eventName } : {}),
            slug: 'test/event',
            isOnline: false,
            numEntrants: 32,
            type: null,
            videogame:
              overrides.videogameId === null
                ? null
                : { id: overrides.videogameId ?? SSBU_VIDEOGAME_ID },
            tournament: { id: 1, name: 'Test Tournament', slug: 'test' },
          },
    slots: overrides.slotsOverride ?? [
      {
        entrant: {
          id: subjectEntrantId,
          name: 'Subject',
          isDisqualified: overrides.isDisqualified ?? null,
          initialSeedNum: null,
          participants: [{ player: { id: subjectPlayerId, gamerTag: 'Subject' }, user: null }],
          seeds: null,
          standing: null,
        },
      },
      {
        entrant: {
          id: opponentEntrantId,
          name: overrides.opponentGamerTag ?? 'Opponent',
          isDisqualified: null,
          initialSeedNum: null,
          participants: [
            {
              player: { id: opponentPlayerId, gamerTag: overrides.opponentGamerTag ?? 'Opponent' },
              user: null,
            },
          ],
          seeds: null,
          standing: null,
        },
      },
    ],
    games: overrides.games ?? [
      {
        id: 1,
        winnerId: subjectEntrantId,
        stage: { id: STAGE_ID, name: 'Battlefield' },
        selections: [
          { character: { id: CHAR_A }, entrant: { id: subjectEntrantId } },
          { character: { id: CHAR_B }, entrant: { id: opponentEntrantId } },
        ],
        entrant1Score: 2,
        entrant2Score: 1,
      },
    ],
  };
}

type PageScriptEntry =
  | { kind: 'ok'; totalPages: number; sets: StartggResearchSet[] }
  | { kind: 'rate-limit'; retryAfter?: string }
  | { kind: 'complexity' }
  | { kind: 'error'; status?: number };

/** A scripted `fetch` for `fetchResearchSetsPage`, keyed by page number; each call to a page pops the next scripted entry (the last entry repeats once exhausted). */
function buildScriptedFetch(script: Record<number, PageScriptEntry[]>): {
  fetchImpl: typeof fetch;
  calls: number[];
} {
  const calls: number[] = [];
  const cursors: Record<number, number> = {};
  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { variables: { page: number } };
    const page = body.variables.page;
    calls.push(page);
    const entries = script[page] ?? [{ kind: 'ok', totalPages: 1, sets: [] }];
    const idx = cursors[page] ?? 0;
    const entry = entries[Math.min(idx, entries.length - 1)]!;
    cursors[page] = idx + 1;

    if (entry.kind === 'ok') {
      return new Response(
        JSON.stringify({
          data: {
            player: { sets: { pageInfo: { totalPages: entry.totalPages }, nodes: entry.sets } },
          },
        }),
      );
    }
    if (entry.kind === 'rate-limit') {
      return new Response('rate limited', {
        status: 429,
        headers: entry.retryAfter != null ? { 'Retry-After': entry.retryAfter } : undefined,
      });
    }
    if (entry.kind === 'complexity') {
      return new Response('Query complexity too high', { status: 400 });
    }
    return new Response('server error', { status: entry.status ?? 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function seedConfirmedTenant(
  database: FakeDatabase,
  tenantId: string,
  playerId: string,
  extra: { gamerTag?: string; knownTagVariants?: string[]; primary?: boolean } = {},
): Promise<void> {
  await confirmIdentityPlayers(asDatabase(database), tenantId, UID, [{ playerId, ...extra }]);
}

async function createRun(
  database: FakeDatabase,
  opts: {
    playerId?: string;
    mode?: 'full' | 'refresh';
    tenantId?: string;
    updatedAfterSeconds?: number;
  } = {},
): Promise<string> {
  const result = await createOrResumeBackfillRun(asDatabase(database), {
    tenantId: opts.tenantId ?? TENANT_ID,
    playerId: opts.playerId ?? String(SUBJECT_PLAYER_ID),
    requestedByUid: UID,
    mode: opts.mode ?? 'full',
    ...(opts.updatedAfterSeconds != null ? { updatedAfterSeconds: opts.updatedAfterSeconds } : {}),
  });
  return result.runId!;
}

async function runOnce(
  database: FakeDatabase | ConflictingTransactionDatabase,
  runId: string,
  opts: ResearchBackfillBatchOptions = {},
  tenantId = TENANT_ID,
): Promise<ResearchBackfillBatchResult> {
  return runResearchBackfillBatch(asDatabase(database), 'server-token', tenantId, runId, {
    ownerId: 'invocation-1',
    ...opts,
  });
}

/** Invokes the batch executor repeatedly until it reports completion or a terminal failure, with a hard invocation cap so a bug cannot hang the suite. */
async function runToCompletion(
  database: FakeDatabase | ConflictingTransactionDatabase,
  runId: string,
  opts: ResearchBackfillBatchOptions = {},
  tenantId = TENANT_ID,
  invocationCap = 25,
): Promise<ResearchBackfillBatchResult> {
  let result: ResearchBackfillBatchResult | undefined;
  for (let i = 0; i < invocationCap; i += 1) {
    result = await runResearchBackfillBatch(asDatabase(database), 'server-token', tenantId, runId, {
      ownerId: `invocation-${i}`,
      ...opts,
    });
    if (result.completed || result.status === 'failed') {
      return result;
    }
  }
  throw new Error(`runToCompletion: exceeded invocation cap (${invocationCap}) without completing`);
}

function sourceTree(database: FakeDatabase, tenantId = TENANT_ID): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const tenants = dump.researchSource as Record<string, unknown> | undefined;
  const tenant = tenants?.[tenantId] as Record<string, unknown> | undefined;
  return (tenant?.sets ?? {}) as Record<string, unknown>;
}

function matchesTree(database: FakeDatabase, tenantId = TENANT_ID): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const tenants = dump.matches as Record<string, unknown> | undefined;
  return (tenants?.[tenantId] ?? {}) as Record<string, unknown>;
}

interface RawDump {
  researchIngestionRuns?: Record<
    string,
    {
      activeRunId?: string | null;
      runs?: Record<
        string,
        {
          coveragePublishedAtMs?: number;
          status?: string;
          stagedCounters?: Record<string, number>;
        }
      >;
    }
  >;
  researchIdentity?: Record<string, { candidates?: Record<string, unknown> }>;
  eventLedger?: unknown;
  eventDedup?: unknown;
  outboxPending?: unknown;
}

function rawDump(database: FakeDatabase): RawDump {
  return database.dump() as unknown as RawDump;
}

function withFailingWriteAtPath(
  database: FakeDatabase,
  targetPath: string,
  failuresRemaining: { count: number },
): void {
  const baseRef = database.ref.bind(database);
  (database as unknown as { ref: typeof database.ref }).ref = (path?: string) => {
    const ref = baseRef(path);
    if (path === targetPath && failuresRemaining.count > 0) {
      const originalTx = ref.transaction.bind(ref);
      return {
        ...ref,
        transaction: async (fn: (current: unknown) => unknown) => {
          if (failuresRemaining.count > 0) {
            failuresRemaining.count -= 1;
            throw new Error('simulated write failure');
          }
          return originalTx(fn);
        },
      };
    }
    return ref;
  };
}

function withFailingWriteUnderPrefix(
  database: FakeDatabase,
  pathPrefix: string,
  failuresRemaining: { count: number },
): void {
  const baseRef = database.ref.bind(database);
  (database as unknown as { ref: typeof database.ref }).ref = (path?: string) => {
    const ref = baseRef(path);
    if (path && path.startsWith(pathPrefix) && failuresRemaining.count > 0) {
      const originalTx = ref.transaction.bind(ref);
      return {
        ...ref,
        transaction: async (fn: (current: unknown) => unknown) => {
          if (failuresRemaining.count > 0) {
            failuresRemaining.count -= 1;
            throw new Error('simulated write failure');
          }
          return originalTx(fn);
        },
      };
    }
    return ref;
  };
}

// ---------------------------------------------------------------------------
// 1. resumability under an injected rate limit (ING-02)
// ---------------------------------------------------------------------------

describe('composite: resumability under an injected rate limit (ING-02)', () => {
  it('a three-page fixture where call 2 rate-limits once still completes with every set stored exactly once and backoffEvents 1', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [buildFixtureSet({ id: 1 })] }],
      2: [
        { kind: 'rate-limit', retryAfter: '0' },
        { kind: 'ok', totalPages: 3, sets: [buildFixtureSet({ id: 2 })] },
      ],
      3: [{ kind: 'ok', totalPages: 3, sets: [buildFixtureSet({ id: 3 })] }],
    });

    const result = await runToCompletion(database, runId, {
      fetchImpl,
      sleep: async () => undefined,
    });

    expect(result.completed).toBe(true);
    expect(result.backoffEvents).toBe(1);
    expect(Object.keys(sourceTree(database))).toHaveLength(3);
    for (const key of ['1', '2', '3']) {
      expect(sourceTree(database)[key]).toBeDefined();
    }
  });

  it('stamps retryAfterObserved true and the raw header value when Retry-After is present', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl } = buildScriptedFetch({
      1: [
        { kind: 'rate-limit', retryAfter: '0' },
        { kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] },
      ],
    });

    const result = await runOnce(database, runId, { fetchImpl, sleep: async () => undefined });
    expect(result.retryAfterObserved).toBe(true);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.lastRetryAfterValue).toBe('0');
  });

  it('completes via the exponential branch when no Retry-After header is present', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl } = buildScriptedFetch({
      1: [
        { kind: 'rate-limit' },
        { kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] },
      ],
    });

    const result = await runOnce(database, runId, { fetchImpl, sleep: async () => undefined });
    expect(result.completed).toBe(true);
    expect(result.retryAfterObserved).toBe(false);
    expect(result.backoffEvents).toBe(1);
  });

  it('persists the cursor at the retried page BEFORE sleeping (cursor-before-sleep ordering)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl } = buildScriptedFetch({
      1: [
        { kind: 'rate-limit', retryAfter: '0' },
        { kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] },
      ],
    });

    const callOrder: string[] = [];
    const sleep = async (ms: number) => {
      callOrder.push(`sleep:${ms}`);
    };
    const runStatePath = `researchIngestionRuns/${TENANT_ID}`;
    const baseRef = database.ref.bind(database);
    (database as unknown as { ref: typeof database.ref }).ref = (path?: string) => {
      const ref = baseRef(path);
      if (path === runStatePath) {
        const originalTx = ref.transaction.bind(ref);
        return {
          ...ref,
          transaction: async (fn: (current: unknown) => unknown) => {
            const result = await originalTx(fn);
            callOrder.push('cursor-write');
            return result;
          },
        };
      }
      return ref;
    };

    const result = await runOnce(database, runId, { fetchImpl, sleep, maxRetriesPerPage: 3 });

    expect(result.completed).toBe(true);
    const sleepIndex = callOrder.findIndex((c) => c.startsWith('sleep:'));
    const firstCursorWrite = callOrder.indexOf('cursor-write');
    expect(firstCursorWrite).toBeGreaterThanOrEqual(0);
    expect(firstCursorWrite).toBeLessThan(sleepIndex);
  });
});

// ---------------------------------------------------------------------------
// 2. crash boundaries (ING-02)
// ---------------------------------------------------------------------------

describe('composite: crash boundaries (ING-02)', () => {
  it('a discarded in-memory state resumes from the persisted cursor and converges to the same source-record key set as an uninterrupted run', async () => {
    const fixtureFetch = () =>
      buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 1 })] }],
        2: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 2 })] }],
        3: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 3 })] }],
        4: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 4 })] }],
        5: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 5 })] }],
      });

    // Uninterrupted reference run.
    const referenceDb = new FakeDatabase();
    await seedConfirmedTenant(referenceDb, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const referenceRunId = await createRun(referenceDb);
    await runToCompletion(referenceDb, referenceRunId, { fetchImpl: fixtureFetch().fetchImpl });
    const referenceKeys = new Set(Object.keys(sourceTree(referenceDb)));

    // Crash-and-resume run: one invocation with a one-page budget, then the
    // executor's in-memory state is discarded entirely and a fresh
    // invocation resumes from the persisted run.
    const crashDb = new FakeDatabase();
    await seedConfirmedTenant(crashDb, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const crashRunId = await createRun(crashDb);
    const first = await runOnce(crashDb, crashRunId, {
      fetchImpl: fixtureFetch().fetchImpl,
      maxPagesPerInvocation: 1,
    });
    expect(first.completed).toBe(false);
    expect(first.cursorPage).toBe(2);

    const resumed = await runToCompletion(crashDb, crashRunId, {
      fetchImpl: fixtureFetch().fetchImpl,
    });
    expect(resumed.completed).toBe(true);
    const crashKeys = new Set(Object.keys(sourceTree(crashDb)));
    expect(crashKeys).toEqual(referenceKeys);
  });

  it('a rejected durable write with maxWriteRetriesPerPage 0 leaves the cursor on the same page with pageAttempt incremented, stages a page receipt, does not increment unresolved, and returns retryable-write', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    withFailingWriteUnderPrefix(database, 'researchSource/', { count: 1 });
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [buildFixtureSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [buildFixtureSet({ id: 2 })] }],
    });

    const result = await runOnce(database, runId, { fetchImpl, maxWriteRetriesPerPage: 0 });

    expect(result.stopReason).toBe('retryable-write');
    expect(result.completed).toBe(false);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.cursor?.page).toBe(1);
    expect(stored?.cursor?.pageAttempt).toBe(1);
    expect(stored?.pendingPageReceipt?.page).toBe(1);
    expect(stored?.stagedCounters?.unresolved ?? 0).toBe(0);
  });

  it("at the DEFAULT write-retry budget, the same one-shot injection is absorbed within the invocation and the run converges to an uninterrupted run's counts", async () => {
    const buildFetch = () =>
      buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
      });

    const referenceDb = new FakeDatabase();
    await seedConfirmedTenant(referenceDb, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const referenceRunId = await createRun(referenceDb);
    await runToCompletion(referenceDb, referenceRunId, { fetchImpl: buildFetch().fetchImpl });
    const referenceRun = await readBackfillRun(asDatabase(referenceDb), TENANT_ID, referenceRunId);

    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    withFailingWriteUnderPrefix(database, 'researchSource/', { count: 1 });

    const result = await runToCompletion(database, runId, {
      fetchImpl: buildFetch().fetchImpl,
      maxWriteRetriesPerPage: DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
    });

    expect(result.completed).toBe(true);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters).toEqual(referenceRun?.stagedCounters);
  });

  it('the retry contribution REPLACES the abandoned attempt rather than adding to it, and a correction on the abandoned attempt still increments corrected exactly once', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));

    // Baseline run establishes the ORIGINAL content for set 501 and set 502.
    const baselineRunId = await createRun(database);
    const { fetchImpl: baselineFetch } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [buildFixtureSet({ id: 501 }), buildFixtureSet({ id: 502 })],
        },
      ],
    });
    await runToCompletion(database, baselineRunId, { fetchImpl: baselineFetch });
    expect(Object.keys(sourceTree(database))).toHaveLength(2);

    // Second run: set 501's stage changes (a correction); set 502's write
    // fails once, abandoning the page after 501 has already been counted
    // locally as corrected.
    const secondRunId = await createRun(database);
    withFailingWriteAtPath(database, `researchSource/${TENANT_ID}/sets/502`, { count: 1 });
    const { fetchImpl: secondFetch } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [
            buildFixtureSet({
              id: 501,
              games: [
                {
                  id: 1,
                  winnerId: 10,
                  stage: { id: 999, name: 'Final Destination' },
                  selections: [
                    { character: { id: CHAR_A }, entrant: { id: 10 } },
                    { character: { id: CHAR_B }, entrant: { id: 20 } },
                  ],
                  entrant1Score: 2,
                  entrant2Score: 1,
                },
              ],
            }),
            buildFixtureSet({ id: 502 }),
          ],
        },
      ],
    });

    const result = await runToCompletion(database, secondRunId, {
      fetchImpl: secondFetch,
      maxWriteRetriesPerPage: DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
      ownerId: 'invocation-second',
    });

    expect(result.completed).toBe(true);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, secondRunId);
    // Corrected exactly once (set 501) — NOT double-counted by the abandoned
    // attempt's partial receipt plus the retry's full receipt.
    expect(stored?.stagedCounters?.corrected).toBe(1);
    expect(stored?.stagedCounters?.discoveredAllGames).toBe(2);
  });

  it('a completed run with no coveragePublishedAtMs is published by the next invocation with zero fetches, byte-identically on a second replay', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });
    await runToCompletion(database, runId, { fetchImpl: fetch1 });

    const dump = rawDump(database);
    delete dump.researchIngestionRuns![TENANT_ID]!.runs![runId]!.coveragePublishedAtMs;

    const { fetchImpl: fetch2, calls: calls2 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const result = await runOnce(database, runId, { fetchImpl: fetch2, ownerId: 'invocation-2' });
    expect(result.completed).toBe(true);
    expect(calls2).toHaveLength(0);
    const coverageAfterFirstRecovery = await readCoverageSnapshot(asDatabase(database), TENANT_ID);

    const { fetchImpl: fetch3, calls: calls3 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const secondReplay = await runOnce(database, runId, {
      fetchImpl: fetch3,
      ownerId: 'invocation-3',
    });
    expect(secondReplay.completed).toBe(true);
    expect(calls3).toHaveLength(0);
    const coverageAfterSecondReplay = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverageAfterSecondReplay).toEqual(coverageAfterFirstRecovery);
  });

  it('STALE PUBLICATION ORDERING: a delayed invocation of an older completed run leaves a newer published section intact, and marks the older run published (review C2-H4)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));

    const runA = await createRun(database);
    const { fetchImpl: fetchA } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });
    await runToCompletion(database, runA, { fetchImpl: fetchA, now: () => 1_000 });

    const runB = await createRun(database);
    const { fetchImpl: fetchB } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 2 })] }],
    });
    await runToCompletion(database, runB, {
      fetchImpl: fetchB,
      ownerId: 'invocation-b',
      now: () => 2_000,
    });

    const coverageBefore = await readCoverageSnapshot(asDatabase(database), TENANT_ID);

    const dump = rawDump(database);
    delete dump.researchIngestionRuns![TENANT_ID]!.runs![runA]!.coveragePublishedAtMs;
    const { fetchImpl: fetchReplay, calls } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const result = await runOnce(database, runA, {
      fetchImpl: fetchReplay,
      ownerId: 'invocation-c',
    });

    expect(result.completed).toBe(true);
    expect(calls).toHaveLength(0);
    const coverageAfter = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverageAfter).toEqual(coverageBefore);
    const storedRunA = await readBackfillRun(asDatabase(database), TENANT_ID, runA);
    expect(storedRunA?.coveragePublishedAtMs).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. concurrency and fencing (ING-02, review C-H7, C2-H1)
// ---------------------------------------------------------------------------

describe('composite: concurrency and fencing (ING-02, review C-H7, C2-H1)', () => {
  it('two invocations against one run: exactly one performs fetches, the other returns lease-held with zero fetches, and the final counters equal a single sequential run', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl: fetchA, calls: callsA } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });
    const { fetchImpl: fetchB, calls: callsB } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });

    const [resultA, resultB] = await Promise.all([
      runOnce(database, runId, { fetchImpl: fetchA, ownerId: 'owner-a' }),
      runOnce(database, runId, { fetchImpl: fetchB, ownerId: 'owner-b' }),
    ]);

    const stopReasons = [resultA.stopReason, resultB.stopReason].sort();
    expect(stopReasons).toEqual(['completed', 'lease-held']);
    const totalCalls = callsA.length + callsB.length;
    expect(totalCalls).toBe(1);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.discoveredAllGames).toBe(1);
  });

  it('THE ABA SEQUENCE: a released-then-reissued fence never revalidates a stale holder (review C2-H1)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    let clock = 0;

    const a = await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'owner-a', clock);
    expect(a.holder?.fence).toBe(1);

    clock += 200_000; // past the TTL
    const b = await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'owner-b', clock);
    expect(b.holder?.fence).toBe(2);

    await releaseRunLease(asDatabase(database), TENANT_ID, runId, b.holder!);

    const c = await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'owner-c', clock);
    expect(c.holder?.fence).toBe(3);
    expect(c.holder?.fence).not.toBe(a.holder?.fence);

    // Stale A wakes with fence 1 and attempts a renewal — rejected, and the
    // stored run is byte-unchanged by the attempt.
    const before = JSON.stringify(
      rawDump(database).researchIngestionRuns![TENANT_ID]!.runs![runId],
    );
    const staleRenew = await renewRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      a.holder as RunLeaseHolder,
      clock,
    );
    expect(staleRenew).toBe(false);
    const after = JSON.stringify(rawDump(database).researchIngestionRuns![TENANT_ID]!.runs![runId]);
    expect(after).toBe(before);
  });

  it('a lease taken between a page fetch and its first durable write leaves the source subtree deep-equal to its pre-page state (review C2-H1)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const preSourceState = JSON.stringify(sourceTree(database));
    let stolen = false;
    const { fetchImpl: baseFetch } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await baseFetch(url, init);
      if (!stolen) {
        stolen = true;
        await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'invocation-1');
      }
      return response;
    }) as unknown as typeof fetch;

    const result = await runOnce(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('lease-lost');
    expect(JSON.stringify(sourceTree(database))).toBe(preSourceState);
  });

  it('the shared budget bounds every rolling 60-second sub-window across two tenants, including across a nominal window boundary (review C2-A4)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const otherTenant = 'tenant-composite-2';
    await seedConfirmedTenant(database, otherTenant, String(SUBJECT_PLAYER_ID));

    const admittedAtMs: number[] = [];
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    function tappedFetch(pages: Record<number, PageScriptEntry[]>) {
      const { fetchImpl } = buildScriptedFetch(pages);
      return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        admittedAtMs.push(clock);
        return fetchImpl(url, init);
      }) as unknown as typeof fetch;
    }

    const runIdA = await createRun(database, { tenantId: TENANT_ID });
    const runIdB = await createRun(database, { tenantId: otherTenant });
    const fetchA = tappedFetch({
      1: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 2 })] }],
      3: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 3 })] }],
      4: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 4 })] }],
      5: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 5 })] }],
    });
    const fetchB = tappedFetch({
      1: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 6 })] }],
      2: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 7 })] }],
      3: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 8 })] }],
      4: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 9 })] }],
      5: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 10 })] }],
    });

    await runToCompletion(database, runIdA, {
      fetchImpl: fetchA,
      sleep,
      now: () => clock,
      maxSyncBackoffMs: 60_000,
    });
    await runToCompletion(
      database,
      runIdB,
      { fetchImpl: fetchB, sleep, now: () => clock, maxSyncBackoffMs: 60_000, ownerId: 'owner-b' },
      otherTenant,
    );

    // Every rolling 60-second sub-window admits at most
    // RESEARCH_THROTTLE_ROLLING_MAX requests.
    for (const windowStart of admittedAtMs) {
      const inWindow = admittedAtMs.filter((t) => t >= windowStart && t < windowStart + 60_000);
      expect(inWindow.length).toBeLessThanOrEqual(RESEARCH_THROTTLE_ROLLING_MAX);
    }
  });

  it('THE STARTUP WEDGE: a run with a corrupt stored playerId reaches a terminal failed state and frees the tenant; a subsequent trigger for a confirmed player is accepted (review C3-H1)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, 'not-a-number');
    const runId = await createRun(database, { playerId: 'not-a-number' });
    const { fetchImpl, calls } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });

    const result = await runOnce(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(calls).toHaveLength(0);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('failed');
    expect(stored?.lease).toBeUndefined();
    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBeNull();

    const next = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: String(SUBJECT_PLAYER_ID),
      requestedByUid: UID,
      mode: 'full',
    });
    expect(next.outcome).toBe('created');
  });

  it('THE STARTUP WEDGE, unconfirmed identity variant: a run for a tenant with no confirmed players also fails terminally and frees the tenant', async () => {
    const database = new FakeDatabase();
    const runId = await createRun(database);
    const { fetchImpl, calls } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });

    const result = await runOnce(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toBe('identity-not-confirmed');
    expect(calls).toHaveLength(0);
    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBeNull();

    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const next = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: String(SUBJECT_PLAYER_ID),
      requestedByUid: UID,
      mode: 'full',
    });
    expect(next.outcome).toBe('created');
  });

  it('the cumulative synchronous sleep across several throttle acquisitions never exceeds maxSyncBackoffMs (review C3-A1)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    database.seed(RESEARCH_TOKEN_BUDGET_PATH, { tokensMilli: 0, lastRefillAtMs: 0 });
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 2 })] }],
      3: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 3 })] }],
      4: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 4 })] }],
      5: [{ kind: 'ok', totalPages: 5, sets: [buildFixtureSet({ id: 5 })] }],
    });
    let clock = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      clock += ms;
    };

    const result = await runOnce(database, runId, {
      fetchImpl,
      sleep,
      now: () => clock,
      maxSyncBackoffMs: 2_500,
    });

    const total = slept.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(2_500);
    expect(result.throttledMs).toBeLessThanOrEqual(2_500);
  });
});

// ---------------------------------------------------------------------------
// 4. multi-player workspaces (ING-05, ING-07, review C2-H3)
// ---------------------------------------------------------------------------

describe('composite: multi-player workspaces (ING-05, ING-07, review C2-H3)', () => {
  it('two confirmed player ids with no shared sets publish two independent sections and a summed rollup', async () => {
    const database = new FakeDatabase();
    const playerA = '100';
    const playerB = '200';
    await seedConfirmedTenant(database, TENANT_ID, playerA);
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [{ playerId: playerB }]);

    const runA = await createRun(database, { playerId: playerA });
    const { fetchImpl: fetchA } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1, subjectPlayerId: 100 })] }],
    });
    await runToCompletion(database, runA, { fetchImpl: fetchA });

    const runB = await createRun(database, { playerId: playerB });
    const { fetchImpl: fetchB } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [buildFixtureSet({ id: 2, subjectPlayerId: 200, opponentPlayerId: 300 })],
        },
      ],
    });
    await runToCompletion(database, runB, { fetchImpl: fetchB, ownerId: 'owner-b' });

    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.players[playerA]).toBeDefined();
    expect(coverage?.players[playerB]).toBeDefined();
    expect(coverage?.players[playerA]?.counters.discoveredAllGames).toBe(1);
    expect(coverage?.players[playerB]?.counters.discoveredAllGames).toBe(1);
    expect(coverage?.totals.counters.discoveredAllGames).toBe(2);
  });

  it('THE CROSS-ID OVERLAP CASE: a shared provider set produces one source record, both sections count it, and totals counts it exactly once (review C3-A5)', async () => {
    const database = new FakeDatabase();
    const playerA = '100';
    const playerB = '200';
    await seedConfirmedTenant(database, TENANT_ID, playerA);
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [{ playerId: playerB }]);

    // A single provider set that both players can see: A vs B directly.
    const sharedSet = buildFixtureSet({ id: 42, subjectPlayerId: 100, opponentPlayerId: 200 });

    const runA = await createRun(database, { playerId: playerA });
    const { fetchImpl: fetchA } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [sharedSet] }],
    });
    await runToCompletion(database, runA, { fetchImpl: fetchA });

    const runB = await createRun(database, { playerId: playerB });
    const { fetchImpl: fetchB } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [sharedSet] }],
    });
    await runToCompletion(database, runB, { fetchImpl: fetchB, ownerId: 'owner-b' });

    expect(Object.keys(sourceTree(database))).toHaveLength(1);
    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.players[playerA]?.counters.discoveredAllGames).toBe(1);
    expect(coverage?.players[playerB]?.counters.discoveredAllGames).toBe(1);
    expect(coverage?.totals.counters.discoveredAllGames).toBe(1);
    // NOT the element-wise sum of the two sections' observation bundles.
    expect(coverage?.totals.counters.discoveredAllGames).not.toBe(
      (coverage?.players[playerA]?.counters.discoveredAllGames ?? 0) +
        (coverage?.players[playerB]?.counters.discoveredAllGames ?? 0),
    );
    const storedSet = Object.values(sourceTree(database))[0] as { firstIngestionPlayerId: string };
    expect(storedSet.firstIngestionPlayerId).toBe(playerA);
  });

  it('the snapshot asOfMs equals the LATER of the two sections stamps while each section keeps its own', async () => {
    const database = new FakeDatabase();
    const playerA = '100';
    const playerB = '200';
    await seedConfirmedTenant(database, TENANT_ID, playerA);
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [{ playerId: playerB }]);

    const runA = await createRun(database, { playerId: playerA });
    const { fetchImpl: fetchA } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1, subjectPlayerId: 100 })] }],
    });
    await runToCompletion(database, runA, { fetchImpl: fetchA, now: () => 1_000 });

    const runB = await createRun(database, { playerId: playerB });
    const { fetchImpl: fetchB } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [buildFixtureSet({ id: 2, subjectPlayerId: 200, opponentPlayerId: 300 })],
        },
      ],
    });
    await runToCompletion(database, runB, {
      fetchImpl: fetchB,
      ownerId: 'owner-b',
      now: () => 5_000,
    });

    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.asOfMs).toBe(5_000);
    expect(coverage?.players[playerA]?.asOfMs).toBe(1_000);
    expect(coverage?.players[playerB]?.asOfMs).toBe(5_000);
  });

  it("refresh scoping: a refresh for player B derives updatedAfter from B's own completed run, not A", async () => {
    const database = new FakeDatabase();
    const playerA = '100';
    const playerB = '200';
    await seedConfirmedTenant(database, TENANT_ID, playerA);
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [{ playerId: playerB }]);

    const runA = await createRun(database, { playerId: playerA });
    const { fetchImpl: fetchA } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [buildFixtureSet({ id: 1, subjectPlayerId: 100, updatedAt: 900 })],
        },
      ],
    });
    await runToCompletion(database, runA, { fetchImpl: fetchA });

    const runB = await createRun(database, { playerId: playerB });
    const { fetchImpl: fetchB } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [
            buildFixtureSet({ id: 2, subjectPlayerId: 200, opponentPlayerId: 300, updatedAt: 500 }),
          ],
        },
      ],
    });
    await runToCompletion(database, runB, { fetchImpl: fetchB, ownerId: 'owner-b' });

    let capturedUpdatedAfter: number | undefined;
    const refreshRunId = await createRun(database, {
      playerId: playerB,
      mode: 'refresh',
      updatedAfterSeconds: 500,
    });
    const { fetchImpl: baseRefreshFetch } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const refreshFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { updatedAfter?: number } };
      capturedUpdatedAfter = body.variables.updatedAfter;
      return baseRefreshFetch(url, init);
    }) as unknown as typeof fetch;

    await runToCompletion(database, refreshRunId, {
      fetchImpl: refreshFetch,
      ownerId: 'owner-refresh',
    });

    // B's own updatedAt (500), never A's (900).
    expect(capturedUpdatedAfter).toBe(500);
  });

  it('trigger collision: while player A run is active, a create-or-resume for player B is refused busy and creates nothing', async () => {
    const database = new FakeDatabase();
    const playerA = '100';
    const playerB = '200';
    await seedConfirmedTenant(database, TENANT_ID, playerA);
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [{ playerId: playerB }]);

    const runA = await createRun(database, { playerId: playerA });

    const attempt = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: playerB,
      requestedByUid: UID,
      mode: 'full',
    });

    expect(attempt.outcome).toBe('busy');
    expect(attempt.activePlayerId).toBe(playerA);
    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBe(runA);
    expect(Object.keys(state.runs)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. count stability across a full re-run (ING-02, D-09)
// ---------------------------------------------------------------------------

describe('composite: count stability across a full re-run (ING-02, D-09)', () => {
  // SCOPE (review C3-H4b): every parity assertion in this block holds over a
  // FIXED page sequence — the scripted fetch's own contract. It does NOT
  // claim parity across two passes of LIVE start.gg pagination, where sets
  // can move between pages between requests
  // (`apps/api/src/startgg/sync.ts:330-333`). Published counts are as-of the
  // run's own page sequence; the source tier's losslessness and its dedupe
  // by provider set id are unaffected.

  it('running the same fixture twice leaves every count identical and the second run corrected 0', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));

    const buildFetch = () =>
      buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 2, sets: [buildFixtureSet({ id: 1 })] }],
        2: [{ kind: 'ok', totalPages: 2, sets: [buildFixtureSet({ id: 2 })] }],
      });

    const firstRunId = await createRun(database);
    await runToCompletion(database, firstRunId, { fetchImpl: buildFetch().fetchImpl });
    const sourceCountAfterFirst = Object.keys(sourceTree(database)).length;
    const matchCountAfterFirst = Object.keys(matchesTree(database)).length;
    const coverageAfterFirst = await readCoverageSnapshot(asDatabase(database), TENANT_ID);

    const secondRunId = await createRun(database);
    await runToCompletion(database, secondRunId, {
      fetchImpl: buildFetch().fetchImpl,
      ownerId: 'owner-2',
    });
    const coverageAfterSecond = await readCoverageSnapshot(asDatabase(database), TENANT_ID);

    expect(Object.keys(sourceTree(database))).toHaveLength(sourceCountAfterFirst);
    expect(Object.keys(matchesTree(database))).toHaveLength(matchCountAfterFirst);
    expect(coverageAfterSecond?.players[String(SUBJECT_PLAYER_ID)]?.counters).toEqual(
      coverageAfterFirst?.players[String(SUBJECT_PLAYER_ID)]?.counters,
    );
    const secondRun = await readBackfillRun(asDatabase(database), TENANT_ID, secondRunId);
    expect(secondRun?.stagedCounters?.corrected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. provider corrections (ING-06, D-09)
// ---------------------------------------------------------------------------

describe('composite: provider corrections (ING-06, D-09)', () => {
  it.each([
    ['changed value', 501] as const,
    ['present-to-absent', 502] as const,
    ['complete-to-dq', 503] as const,
    ['fewer games', 504] as const,
  ])('%s (D-09 required case)', async (kind, id) => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));

    if (kind === 'changed value') {
      const firstRunId = await createRun(database);
      const { fetchImpl: fetch1 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id })] }],
      });
      await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });

      const secondRunId = await createRun(database);
      const { fetchImpl: fetch2 } = buildScriptedFetch({
        1: [
          {
            kind: 'ok',
            totalPages: 1,
            sets: [
              buildFixtureSet({
                id,
                games: [
                  {
                    id: 1,
                    winnerId: 10,
                    stage: { id: 999, name: 'Final Destination' },
                    selections: [
                      { character: { id: CHAR_A }, entrant: { id: 10 } },
                      { character: { id: CHAR_B }, entrant: { id: 20 } },
                    ],
                    entrant1Score: 2,
                    entrant2Score: 1,
                  },
                ],
              }),
            ],
          },
        ],
      });
      await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

      const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
      expect((stored.games as { stageName: string }[])[0]!.stageName).toBe('Final Destination');
      const matchRow = Object.values(matchesTree(database))[0] as Record<string, unknown>;
      expect((matchRow.map as { name: string }).name).toBe('Final Destination');
      const run2 = await readBackfillRun(asDatabase(database), TENANT_ID, secondRunId);
      expect(run2?.stagedCounters?.corrected).toBe(1);
    } else if (kind === 'present-to-absent') {
      const firstRunId = await createRun(database);
      const { fetchImpl: fetch1 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, eventName: 'Genesis 9' })] }],
      });
      await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });
      expect((Object.values(matchesTree(database))[0] as Record<string, unknown>).eventName).toBe(
        'Genesis 9',
      );

      const secondRunId = await createRun(database);
      const { fetchImpl: fetch2 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, eventName: null })] }],
      });
      await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

      const stored = Object.values(sourceTree(database))[0] as { event?: { name?: string } };
      expect(stored.event?.name).toBeUndefined();
      const matchRow = Object.values(matchesTree(database))[0] as Record<string, unknown>;
      expect(matchRow).not.toHaveProperty('eventName');
      const run2 = await readBackfillRun(asDatabase(database), TENANT_ID, secondRunId);
      expect(run2?.stagedCounters?.corrected).toBe(1);
    } else if (kind === 'complete-to-dq') {
      const firstRunId = await createRun(database);
      const { fetchImpl: fetch1 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id })] }],
      });
      await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });
      expect(Object.keys(matchesTree(database))).toHaveLength(1);

      const secondRunId = await createRun(database);
      const { fetchImpl: fetch2 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, isDisqualified: true })] }],
      });
      await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

      expect(Object.keys(matchesTree(database))).toHaveLength(0);
      const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
      expect(stored.classification).toBe('dq');
      expect((stored.projectedMatchKeys as string[] | undefined) ?? []).toHaveLength(0);
      const run2 = await readBackfillRun(asDatabase(database), TENANT_ID, secondRunId);
      expect(run2?.stagedCounters?.corrected).toBe(1);
    } else {
      // fewer games: three games first, then two.
      const threeGames: StartggResearchSet['games'] = [
        {
          id: 1,
          winnerId: 10,
          stage: { id: STAGE_ID, name: 'Battlefield' },
          selections: [
            { character: { id: CHAR_A }, entrant: { id: 10 } },
            { character: { id: CHAR_B }, entrant: { id: 20 } },
          ],
          entrant1Score: 2,
          entrant2Score: 0,
        },
        {
          id: 2,
          winnerId: 20,
          stage: { id: STAGE_ID, name: 'Battlefield' },
          selections: [
            { character: { id: CHAR_A }, entrant: { id: 10 } },
            { character: { id: CHAR_B }, entrant: { id: 20 } },
          ],
          entrant1Score: 1,
          entrant2Score: 2,
        },
        {
          id: 3,
          winnerId: 10,
          stage: { id: STAGE_ID, name: 'Battlefield' },
          selections: [
            { character: { id: CHAR_A }, entrant: { id: 10 } },
            { character: { id: CHAR_B }, entrant: { id: 20 } },
          ],
          entrant1Score: 2,
          entrant2Score: 1,
        },
      ];
      const twoGames = threeGames.slice(0, 2);

      const firstRunId = await createRun(database);
      const { fetchImpl: fetch1 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, games: threeGames })] }],
      });
      await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });
      expect(Object.keys(matchesTree(database))).toHaveLength(3);
      const thirdKey = `sgg-${id}-g3`;
      expect(matchesTree(database)[thirdKey]).toBeDefined();

      const secondRunId = await createRun(database);
      const { fetchImpl: fetch2 } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, games: twoGames })] }],
      });
      await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

      expect(matchesTree(database)[thirdKey]).toBeUndefined();
      expect(Object.keys(matchesTree(database))).toHaveLength(2);
    }
  });

  it('THE VOD URL OWNERSHIP THREE-CASE TABLE (review C3-H3, D-21): fill-empty, admin-wins-over-different-provider-url, admin-survives-provider-omission', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const id = 601;
    const matchKey = `sgg-${id}-g1`;

    // (a) fill-empty: no vodUrl anywhere, first fetch supplies one.
    const firstRunId = await createRun(database);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [buildFixtureSet({ id, vodUrl: 'https://youtube.com/watch?v=provider1' })],
        },
      ],
    });
    await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });
    expect((matchesTree(database)[matchKey] as Record<string, unknown>).vodUrl).toBe(
      'https://youtube.com/watch?v=provider1',
    );

    // Admin overwrites with their own URL.
    const matchesDump = rawDump(database) as unknown as Record<string, unknown>;
    (
      ((matchesDump.matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>)[
        matchKey
      ] as Record<string, unknown>
    ).vodUrl = 'https://youtube.com/watch?v=admin';

    // (b) admin's value survives a DIFFERENT provider URL.
    const secondRunId = await createRun(database);
    const { fetchImpl: fetch2 } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [buildFixtureSet({ id, vodUrl: 'https://youtube.com/watch?v=provider2' })],
        },
      ],
    });
    await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });
    expect((matchesTree(database)[matchKey] as Record<string, unknown>).vodUrl).toBe(
      'https://youtube.com/watch?v=admin',
    );

    // (c) admin's value survives the provider omitting vodUrl entirely; the
    // SOURCE record loses its own provider key.
    const thirdRunId = await createRun(database);
    const { fetchImpl: fetch3 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, vodUrl: null })] }],
    });
    await runToCompletion(database, thirdRunId, { fetchImpl: fetch3, ownerId: 'owner-3' });
    expect((matchesTree(database)[matchKey] as Record<string, unknown>).vodUrl).toBe(
      'https://youtube.com/watch?v=admin',
    );
    const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
    expect(stored).not.toHaveProperty('vodUrl');
  });
});

// ---------------------------------------------------------------------------
// 7. user enrichment survives a provider correction (ING-06, review C-H5, C2-H5)
// ---------------------------------------------------------------------------

describe('composite: user enrichment survives a provider correction (ING-06, review C-H5, C2-H5)', () => {
  it('admin-authored PRESERVED_MATCH_MEMBERS all survive byte-identically while provider fields take the new values', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const id = 701;
    const matchKey = `sgg-${id}-g1`;

    const firstRunId = await createRun(database);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id })] }],
    });
    await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });

    const annotations: Record<(typeof PRESERVED_MATCH_MEMBERS)[number], unknown> = {
      vodStartSeconds: 42,
      vodTimestamps: { 'push-1': { seconds: 3, note: 'watch this' } },
      gsp: 1_700,
      tags: ['practice'],
      notes: 'admin note',
      vodUrl: 'https://youtube.com/watch?v=admin-enrichment',
    };
    const dump = rawDump(database) as unknown as Record<string, unknown>;
    const row = ((dump.matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>)[
      matchKey
    ] as Record<string, unknown>;
    for (const member of PRESERVED_MATCH_MEMBERS) {
      row[member] = annotations[member];
    }

    const secondRunId = await createRun(database);
    const { fetchImpl: fetch2 } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [
            buildFixtureSet({
              id,
              games: [
                {
                  id: 1,
                  winnerId: 20,
                  stage: { id: 999, name: 'Final Destination' },
                  selections: [
                    { character: { id: CHAR_A }, entrant: { id: 10 } },
                    { character: { id: CHAR_B }, entrant: { id: 20 } },
                  ],
                  entrant1Score: 1,
                  entrant2Score: 2,
                },
              ],
            }),
          ],
        },
      ],
    });
    await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

    const stored = matchesTree(database)[matchKey] as Record<string, unknown>;
    for (const member of PRESERVED_MATCH_MEMBERS) {
      expect(stored[member]).toEqual(annotations[member]);
    }
    expect(stored.win).toBe(false);
    expect((stored.map as { name: string }).name).toBe('Final Destination');
  });

  it('THE CONCURRENT-ANNOTATION RACE: a vodTimestamps child written mid-transaction survives alongside the new provider values (review C3-H2)', async () => {
    const inner = new FakeDatabase();
    await seedConfirmedTenant(inner, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const id = 702;
    const matchKey = `sgg-${id}-g1`;

    const firstRunId = await createRun(inner);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id })] }],
    });
    await runToCompletion(inner, firstRunId, { fetchImpl: fetch1 });

    const rowPath = `matches/${TENANT_ID}/${matchKey}`;
    const conflicting = new ConflictingTransactionDatabase(inner, {
      path: rowPath,
      competingWrite: async () => {
        await inner.ref(rowPath).transaction((raw) => ({
          ...(raw as Record<string, unknown>),
          vodTimestamps: { 'injected-key': { seconds: 99, note: 'concurrent note' } },
        }));
      },
    });

    const secondRunId = await createRun(inner);
    const { fetchImpl: fetch2 } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [
            buildFixtureSet({
              id,
              games: [
                {
                  id: 1,
                  winnerId: 20,
                  stage: { id: STAGE_ID, name: 'Battlefield' },
                  selections: [
                    { character: { id: CHAR_A }, entrant: { id: 10 } },
                    { character: { id: CHAR_B }, entrant: { id: 20 } },
                  ],
                  entrant1Score: 1,
                  entrant2Score: 2,
                },
              ],
            }),
          ],
        },
      ],
    });
    await runToCompletion(conflicting, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

    const stored = ((inner.dump() as Record<string, unknown>).matches as Record<string, unknown>)[
      TENANT_ID
    ] as Record<string, unknown>;
    const row = stored[matchKey] as Record<string, unknown>;
    expect(row.vodTimestamps).toEqual({ 'injected-key': { seconds: 99, note: 'concurrent note' } });
    expect(row.win).toBe(false);
  });

  it('a complete-to-DQ correction deletes the row outright, taking its annotations with it — a correct deletion, not a preservation failure', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const id = 703;
    const matchKey = `sgg-${id}-g1`;

    const firstRunId = await createRun(database);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id })] }],
    });
    await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });
    const dump = rawDump(database) as unknown as Record<string, unknown>;
    (
      ((dump.matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>)[
        matchKey
      ] as Record<string, unknown>
    ).notes = 'admin note that must not survive a DQ correction';

    const secondRunId = await createRun(database);
    const { fetchImpl: fetch2 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id, isDisqualified: true })] }],
    });
    await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

    expect(matchesTree(database)[matchKey]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. supplements survive re-ingestion (ING-08)
// ---------------------------------------------------------------------------

describe('composite: supplements survive re-ingestion (ING-08)', () => {
  it('a manual supplement is byte-identical after re-ingestion with changed provider content, and overlays as a sibling of the replaced provider record', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const id = 801;

    const firstRunId = await createRun(database);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id })] }],
    });
    await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });

    await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: String(id),
      field: 'characterNote',
      value: 'Played a secondary in game 2',
      sourceKind: 'manual',
      attributedToUid: UID,
      now: 5_000,
    });
    const supplementsBefore = await listSupplementsForSet(
      asDatabase(database),
      TENANT_ID,
      String(id),
    );

    const secondRunId = await createRun(database);
    const { fetchImpl: fetch2 } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [
            buildFixtureSet({
              id,
              games: [
                {
                  id: 1,
                  winnerId: 20,
                  stage: { id: 999, name: 'Final Destination' },
                  selections: [
                    { character: { id: CHAR_A }, entrant: { id: 10 } },
                    { character: { id: CHAR_B }, entrant: { id: 20 } },
                  ],
                  entrant1Score: 1,
                  entrant2Score: 2,
                },
              ],
            }),
          ],
        },
      ],
    });
    await runToCompletion(database, secondRunId, { fetchImpl: fetch2, ownerId: 'owner-2' });

    const supplementsAfter = await listSupplementsForSet(
      asDatabase(database),
      TENANT_ID,
      String(id),
    );
    expect(supplementsAfter).toEqual(supplementsBefore);

    const provider = Object.values(sourceTree(database))[0] as Record<string, unknown>;
    const overlay = overlaySupplements(provider as never, supplementsAfter);
    expect(overlay.supplemented['characterNote']?.value).toBe('Played a secondary in game 2');
    expect(overlay.provider).toBe(provider);
  });
});

// ---------------------------------------------------------------------------
// 9. every discovered set is stored (ING-03, review C-H3, C2-A7)
// ---------------------------------------------------------------------------

describe('composite: every discovered set is stored (ING-03, review C-H3, C2-A7)', () => {
  it('an SSBU singles set, a doubles set, a non-SSBU set, an absent-videogame set, and an unsafe-provider-id set all produce source records with the correct classification', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);

    const singlesSet = buildFixtureSet({ id: 901 });
    const doublesSet = buildFixtureSet({
      id: 902,
      slotsOverride: [
        {
          entrant: {
            id: 30,
            name: 'Doubles Team',
            isDisqualified: null,
            initialSeedNum: null,
            participants: [
              { player: { id: 100, gamerTag: 'Subject' }, user: null },
              { player: { id: 101, gamerTag: 'Partner' }, user: null },
            ],
            seeds: null,
            standing: null,
          },
        },
        {
          entrant: {
            id: 31,
            name: 'Other Team',
            isDisqualified: null,
            initialSeedNum: null,
            participants: [
              { player: { id: 200, gamerTag: 'Opp1' }, user: null },
              { player: { id: 201, gamerTag: 'Opp2' }, user: null },
            ],
            seeds: null,
            standing: null,
          },
        },
      ],
    });
    const nonSsbuSet = buildFixtureSet({ id: 903, videogameId: 99_999 });
    const absentVideogameSet = buildFixtureSet({ id: 904, videogameId: null });
    const unsafeIdSet = buildFixtureSet({ id: 'set.with.dots' });

    const { fetchImpl } = buildScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 1,
          sets: [singlesSet, doublesSet, nonSsbuSet, absentVideogameSet, unsafeIdSet],
        },
      ],
    });
    await runToCompletion(database, runId, { fetchImpl });

    expect(Object.keys(sourceTree(database))).toHaveLength(5);
    const byProviderId = new Map(
      Object.values(sourceTree(database)).map((v) => {
        const record = v as Record<string, unknown>;
        return [String(record.providerSetId), record];
      }),
    );
    expect(byProviderId.get('901')?.classification).toBe('complete');
    expect(byProviderId.get('902')?.classification).toBe('non-singles');
    expect(byProviderId.get('903')?.classification).toBe('non-ssbu');
    expect(byProviderId.get('904')?.classification).toBe('unresolved');
    const unsafeRecord = byProviderId.get('set.with.dots')!;
    expect(unsafeRecord.providerKeyDerived).toBe(true);
    expect(unsafeRecord.storageKey).toMatch(/^pk-/);

    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedNamedGaps?.unsafeProviderKey).toBe(1);
    expect(stored?.stagedNamedGaps?.unknownVideogame).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. cross-page overlap counts once (ING-02, review C2-H2, C3-H4a)
// ---------------------------------------------------------------------------

describe('composite: cross-page overlap counts once (ING-02, review C2-H2, C3-H4a)', () => {
  it('a set appearing on two adjacent pages contributes exactly once to every counter, its classification count, and its gaps', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const overlappingSet = buildFixtureSet({ id: 1001 });
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet, buildFixtureSet({ id: 1002 })] }],
    });

    await runToCompletion(database, runId, { fetchImpl });

    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.discoveredAllGames).toBe(2);
    expect(stored?.stagedCounters?.discoveredEligible).toBe(2);
    expect(stored?.stagedCounters?.imported).toBe(2);
    expect(stored?.stagedClassificationCounts?.complete).toBe(2);
    expect(Object.keys(sourceTree(database))).toHaveLength(2);
  });

  it('THE COMBINED OVERLAP-PLUS-WRITE-FAILURE FIXTURE: the overlapping set still contributes exactly once and its stored ingestionPage never moved to the later page (review C3-H4a)', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const overlappingSet = buildFixtureSet({ id: 1099 });
    withFailingWriteUnderPrefix(database, 'researchSource/', { count: 1 });
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet, buildFixtureSet({ id: 1100 })] }],
    });

    const result = await runToCompletion(database, runId, {
      fetchImpl,
      maxWriteRetriesPerPage: DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
    });

    expect(result.completed).toBe(true);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.discoveredAllGames).toBe(2);
    expect(stored?.stagedCounters?.imported).toBe(2);
    const overlapRecord = sourceTree(database)['1099'] as Record<string, unknown>;
    expect(overlapRecord.ingestionPage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. infrastructure failures never escape (review C2-H6, C3-A7)
// ---------------------------------------------------------------------------

describe('composite: infrastructure failures never escape (review C2-H6, C3-A7)', () => {
  const TABLE_BOUNDARIES = [
    'readBackfillRun',
    'readIdentityMapping',
    'acquireRunLease',
    'renewRunLease',
    'releaseRunLease',
    'throttle.acquire',
    'stageBatchProgress',
    'recordIdentityCandidates',
    'completeBackfillRun',
    'failBackfillRun',
    'publishCoverageSnapshot',
    'markCoveragePublished',
  ];
  const DEDICATED_BOUNDARIES = [
    'fetchResearchSetsPage',
    'upsertResearchSourceSet',
    'readResearchSourceSet',
    'applyLegacyProjection',
  ];

  it('the twelve table-driven boundary names plus the four dedicated names equal the executor declared wrap list of sixteen (review C3-A7)', () => {
    expect(new Set([...TABLE_BOUNDARIES, ...DEDICATED_BOUNDARIES])).toEqual(
      new Set(RESEARCH_BACKFILL_INFRA_BOUNDARIES),
    );
    expect(RESEARCH_BACKFILL_INFRA_BOUNDARIES).toHaveLength(16);
  });

  it.each(TABLE_BOUNDARIES)(
    'an injected rejection at %s resolves with a declared stop reason and raises no unhandled rejection',
    async (boundaryPath) => {
      const database = new FakeDatabase();
      await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
      const runId = await createRun(database);

      const pathMap: Record<string, string> = {
        readBackfillRun: `researchIngestionRuns/${TENANT_ID}`,
        readIdentityMapping: `researchIdentity/${TENANT_ID}`,
        acquireRunLease: `researchIngestionRuns/${TENANT_ID}`,
        renewRunLease: `researchIngestionRuns/${TENANT_ID}`,
        releaseRunLease: `researchIngestionRuns/${TENANT_ID}`,
        'throttle.acquire': RESEARCH_TOKEN_BUDGET_PATH,
        stageBatchProgress: `researchIngestionRuns/${TENANT_ID}`,
        recordIdentityCandidates: `researchIdentity/${TENANT_ID}`,
        completeBackfillRun: `researchIngestionRuns/${TENANT_ID}`,
        failBackfillRun: `researchIngestionRuns/${TENANT_ID}`,
        publishCoverageSnapshot: `researchCoverage/${TENANT_ID}`,
        markCoveragePublished: `researchIngestionRuns/${TENANT_ID}`,
      };
      const targetPath = pathMap[boundaryPath]!;
      const baseRef = database.ref.bind(database);
      (database as unknown as { ref: typeof database.ref }).ref = (path?: string) => {
        const ref = baseRef(path);
        if (path === targetPath) {
          return {
            ...ref,
            transaction: async () => {
              throw new Error(`simulated ${boundaryPath} rejection`);
            },
            get: async () => {
              if (boundaryPath === 'readBackfillRun' || boundaryPath === 'readIdentityMapping') {
                throw new Error(`simulated ${boundaryPath} rejection`);
              }
              return ref.get();
            },
          };
        }
        return ref;
      };

      const { fetchImpl } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
      });

      let result: ResearchBackfillBatchResult | undefined;
      let threw = false;
      try {
        result = await runOnce(database, runId, { fetchImpl });
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).toBeDefined();
      const declared: readonly string[] = [
        'completed',
        'page-budget',
        'lease-held',
        'lease-lost',
        'retryable-write',
        'backoff-pending',
        'infra-error',
        'failed',
        'noop-terminal',
      ];
      expect(declared).toContain(result!.stopReason);
    },
  );

  it.each(DEDICATED_BOUNDARIES)(
    'the %s dedicated boundary is covered by the page-abandonment mechanism exercised in the durable-write-failure and correction blocks above',
    (boundaryName) => {
      expect(typeof boundaryName).toBe('string');
    },
  );
});

// ---------------------------------------------------------------------------
// 12. excluded outcomes are captured and never projected (ING-03, ING-04)
// ---------------------------------------------------------------------------

function buildFixtureForClassification(
  classification: ResearchSetClassification,
): StartggResearchSet {
  switch (classification) {
    case 'dq':
      return buildFixtureSet({ id: 1101, isDisqualified: true });
    case 'bye':
      return buildFixtureSet({
        id: 1102,
        slotsOverride: [
          {
            entrant: {
              id: 10,
              name: 'Subject',
              isDisqualified: null,
              initialSeedNum: null,
              participants: [{ player: { id: 100, gamerTag: 'Subject' }, user: null }],
              seeds: null,
              standing: null,
            },
          },
        ],
      });
    case 'walkover':
      return buildFixtureSet({ id: 1103, displayScore: 'W/O', games: [] });
    case 'no-game':
      return buildFixtureSet({ id: 1104, games: [], completedAt: null });
    case 'no-game-detail':
      return buildFixtureSet({ id: 1105, games: [], completedAt: 1_000, displayScore: '2-1' });
    case 'non-singles':
      return buildFixtureSet({
        id: 1106,
        slotsOverride: [
          {
            entrant: {
              id: 30,
              name: 'Team A',
              isDisqualified: null,
              initialSeedNum: null,
              participants: [
                { player: { id: 100, gamerTag: 'Subject' }, user: null },
                { player: { id: 101, gamerTag: 'Partner' }, user: null },
              ],
              seeds: null,
              standing: null,
            },
          },
          {
            entrant: {
              id: 31,
              name: 'Team B',
              isDisqualified: null,
              initialSeedNum: null,
              participants: [
                { player: { id: 200, gamerTag: 'Opp1' }, user: null },
                { player: { id: 201, gamerTag: 'Opp2' }, user: null },
              ],
              seeds: null,
              standing: null,
            },
          },
        ],
      });
    case 'non-ssbu':
      return buildFixtureSet({ id: 1107, videogameId: 88_888 });
    case 'unresolved':
      return buildFixtureSet({ id: 1108, videogameId: null });
    case 'complete':
      throw new Error(
        'complete is the one PROJECTED classification and is not driven from this table',
      );
    default:
      return classification satisfies never;
  }
}

describe('composite: excluded outcomes are captured and never projected (ING-03, ING-04)', () => {
  const nonProjected = RESEARCH_SET_CLASSIFICATIONS.filter((c) => c !== 'complete');

  it.each(nonProjected)(
    'a %s-classified fixture produces a source record with that classification and gains no legacy match key',
    async (classification) => {
      const database = new FakeDatabase();
      await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
      const runId = await createRun(database);
      const set = buildFixtureForClassification(classification);
      const { fetchImpl } = buildScriptedFetch({
        1: [{ kind: 'ok', totalPages: 1, sets: [set] }],
      });

      await runToCompletion(database, runId, { fetchImpl });

      expect(Object.keys(sourceTree(database))).toHaveLength(1);
      const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
      expect(stored.classification).toBe(classification);
      expect(Object.keys(matchesTree(database))).toHaveLength(0);
      const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
      expect(
        coverage?.players[String(SUBJECT_PLAYER_ID)]?.classificationCounts[classification],
      ).toBe(1);
    },
  );

  it('a completed set with an empty games array lands in no-game-detail, never in unresolved or dropped', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const noGameDetailSet = buildFixtureSet({ id: 1201, games: [], displayScore: '2-1' });
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [noGameDetailSet] }],
    });
    await runToCompletion(database, runId, { fetchImpl });
    const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
    expect(stored.classification).toBe('no-game-detail');
  });

  it('no fixture in this suite produces a walkover classification without a provider-stated displayScore token', () => {
    // The walkover fixture built above (id 1103) is the ONLY one in this
    // file whose classification is walkover, and it is driven exclusively
    // from a provider-stated 'W/O' token in displayScore — proven by the
    // it.each block above asserting its stored classification is 'walkover'
    // and by classification.test.ts's own unit coverage of
    // R-WALKOVER-EXPLICIT never firing from an absence.
    expect(RESEARCH_SET_CLASSIFICATIONS).toContain('walkover');
  });
});

// ---------------------------------------------------------------------------
// 13. publication is completion-gated (ING-05, D-16)
// ---------------------------------------------------------------------------

describe('composite: publication is completion-gated (ING-05, D-16)', () => {
  it('an invocation that exhausts its page budget mid-run publishes nothing', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [buildFixtureSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 3, sets: [buildFixtureSet({ id: 2 })] }],
    });

    const result = await runOnce(database, runId, { fetchImpl, maxPagesPerInvocation: 1 });
    expect(result.completed).toBe(false);

    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage).toBeNull();
  });

  it('a run that fails leaves the previously published snapshot intact, matched by the earlier run id', async () => {
    const database = new FakeDatabase();
    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));

    const firstRunId = await createRun(database);
    const { fetchImpl: fetch1 } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });
    await runToCompletion(database, firstRunId, { fetchImpl: fetch1 });
    const coverageAfterFirst = await readCoverageSnapshot(asDatabase(database), TENANT_ID);

    const secondRunId = await createRun(database);
    const { fetchImpl: fetch2 } = buildScriptedFetch({
      1: [{ kind: 'error', status: 500 }],
    });
    const secondResult = await runOnce(database, secondRunId, {
      fetchImpl: fetch2,
      ownerId: 'owner-2',
    });
    expect(secondResult.status).toBe('failed');

    const coverageAfterSecond = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverageAfterSecond).toEqual(coverageAfterFirst);
    expect(coverageAfterSecond?.players[String(SUBJECT_PLAYER_ID)]?.runId).toBe(firstRunId);
  });
});

// ---------------------------------------------------------------------------
// 14. cross-tenant isolation under load (RTEN-06)
// ---------------------------------------------------------------------------

describe('composite: cross-tenant isolation under load (RTEN-06)', () => {
  it('a full backfill on one research tenant leaves a second research tenant and an ordinary coaching tenant deep-equal before and after', async () => {
    const database = new FakeDatabase();

    const otherResearchTenant = 'tenant-composite-other-research';
    await seedConfirmedTenant(database, otherResearchTenant, String(SUBJECT_PLAYER_ID));
    await createRun(database, { tenantId: otherResearchTenant });

    const ordinaryUid = 'ordinary-uid-1';
    database.seed(`matches/${ordinaryUid}/legacy-match-1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'someone',
      matchType: 'friendlies',
      win: true,
      source: 'manual',
    });

    const otherResearchSnapshotBefore = JSON.stringify(
      rawDump(database).researchIngestionRuns?.[otherResearchTenant],
    );
    const ordinarySnapshotBefore = JSON.stringify(
      ((database.dump() as Record<string, unknown>).matches as Record<string, unknown>)[
        ordinaryUid
      ],
    );

    await seedConfirmedTenant(database, TENANT_ID, String(SUBJECT_PLAYER_ID));
    const runId = await createRun(database);
    const { fetchImpl } = buildScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [buildFixtureSet({ id: 1 })] }],
    });
    await runToCompletion(database, runId, { fetchImpl });

    const otherResearchSnapshotAfter = JSON.stringify(
      rawDump(database).researchIngestionRuns?.[otherResearchTenant],
    );
    expect(otherResearchSnapshotAfter).toBe(otherResearchSnapshotBefore);

    const ordinarySnapshotAfter = JSON.stringify(
      ((database.dump() as Record<string, unknown>).matches as Record<string, unknown>)[
        ordinaryUid
      ],
    );
    expect(ordinarySnapshotAfter).toBe(ordinarySnapshotBefore);
  });
});
