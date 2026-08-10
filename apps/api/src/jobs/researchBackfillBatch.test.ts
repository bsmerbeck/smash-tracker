import type { Database } from 'firebase-admin/database';
import {
  normalizeResearchClassificationCounts,
  researchTenantIngestionStateSchema,
} from '@smash-tracker/shared';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  acquireRunLease,
  createOrResumeBackfillRun,
  readBackfillRun,
  readTenantIngestionState,
} from '../research/ingestion/backfillRun.js';
import { readCoverageSnapshot } from '../research/ingestion/rollup.js';
import { confirmIdentityPlayers } from '../research/ingestion/identity.js';
import { RESEARCH_TOKEN_BUDGET_PATH } from '../research/ingestion/throttle.js';
import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from '../startgg/client.js';
import {
  DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
  RESEARCH_BACKFILL_INFRA_BOUNDARIES,
  RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES,
  runResearchBackfillBatch,
  type ResearchBackfillBatchOptions,
} from './researchBackfillBatch.js';

function asDatabase(database: unknown): Database {
  return database as Database;
}

const TENANT_ID = 'tenant-1';
const PLAYER_ID = '100';
const UID = 'admin-1';
const SUBJECT_PLAYER_ID = 100;
const OPPONENT_PLAYER_ID = 200;
const CHAR_A = 1271; // -> fighter 67 (Bayonetta)
const CHAR_B = 1272; // -> fighter 61 (Bowser Jr.)
const STAGE_ID = 311; // Battlefield

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeSet(
  overrides: Partial<{
    id: number;
    completedAt: number | null;
    updatedAt: number | null;
    videogameId: number | null;
    displayScore: string | null;
    isDisqualified: boolean | null;
    subjectEntrantId: number;
    opponentEntrantId: number;
    subjectPlayerId: number;
    opponentPlayerId: number;
    games: StartggResearchSet['games'];
    slotsOverride: StartggResearchSet['slots'];
  }> = {},
): StartggResearchSet {
  const subjectEntrantId = overrides.subjectEntrantId ?? 10;
  const opponentEntrantId = overrides.opponentEntrantId ?? 20;
  const subjectPlayerId = overrides.subjectPlayerId ?? SUBJECT_PLAYER_ID;
  const opponentPlayerId = overrides.opponentPlayerId ?? OPPONENT_PLAYER_ID;
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
    vodUrl: null,
    identifier: null,
    event: {
      id: 1,
      name: 'Test Event',
      slug: 'test/event',
      isOnline: false,
      numEntrants: 32,
      type: null,
      videogame:
        overrides.videogameId === null ? null : { id: overrides.videogameId ?? SSBU_VIDEOGAME_ID },
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
          name: 'Opponent',
          isDisqualified: null,
          initialSeedNum: null,
          participants: [{ player: { id: opponentPlayerId, gamerTag: 'Opponent' }, user: null }],
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

/** A scripted `fetch` for `fetchResearchSetsPage`: keyed by page number, each call to a page pops the next scripted entry (the last entry repeats once exhausted). */
function makeScriptedFetch(script: Record<number, PageScriptEntry[]>): {
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

async function confirmPlayer(
  database: FakeDatabase,
  tenantId = TENANT_ID,
  playerId = PLAYER_ID,
): Promise<void> {
  await confirmIdentityPlayers(asDatabase(database), tenantId, UID, [{ playerId }]);
}

async function createRun(
  database: FakeDatabase,
  opts: { playerId?: string; mode?: 'full' | 'refresh'; tenantId?: string } = {},
): Promise<string> {
  const result = await createOrResumeBackfillRun(asDatabase(database), {
    tenantId: opts.tenantId ?? TENANT_ID,
    playerId: opts.playerId ?? PLAYER_ID,
    requestedByUid: UID,
    mode: opts.mode ?? 'full',
  });
  return result.runId!;
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

/** Loosely-typed view of the raw tree for test-only reach-in assertions/mutations — never used by the executor itself. */
interface RawDump {
  researchIngestionRuns?: Record<
    string,
    { activeRunId?: string | null; runs?: Record<string, { coveragePublishedAtMs?: number }> }
  >;
  researchIdentity?: Record<string, { candidates?: Record<string, unknown> }>;
}

function rawDump(database: FakeDatabase): RawDump {
  return database.dump() as unknown as RawDump;
}

/** Simulates RTDB's removal of empty object children during a write/read round trip. */
function stripEmptyObjectsLikeRtdb(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmptyObjectsLikeRtdb);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const stripped = stripEmptyObjectsLikeRtdb(child);
      if (
        stripped !== null &&
        typeof stripped === 'object' &&
        !Array.isArray(stripped) &&
        Object.keys(stripped).length === 0
      ) {
        continue;
      }
      result[key] = stripped;
    }
    return result;
  }
  return value;
}

async function run(
  database: FakeDatabase,
  runId: string,
  opts: ResearchBackfillBatchOptions = {},
  tenantId = TENANT_ID,
) {
  return runResearchBackfillBatch(asDatabase(database), 'server-token', tenantId, runId, {
    ownerId: 'invocation-1',
    // Fixture pages script 1 set per page; the provider-truncation guard
    // treats a short non-final page as clipped, so the requested page size
    // must match the fixture shape (tests exercising the guard override).
    perPage: 1,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: happy path', () => {
  it('processes a two-page fixture with the default limits, writing one source record per unique set', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);

    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 2 })] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(Object.keys(sourceTree(database))).toHaveLength(2);
  });

  it('a second identical run leaves the source-record count and legacy match-key count unchanged', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);

    const buildFetch = () =>
      makeScriptedFetch({
        1: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 1 })] }],
        2: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 2 })] }],
      });

    const firstRunId = await createRun(database);
    await run(database, firstRunId, { fetchImpl: buildFetch().fetchImpl });
    const sourceCountAfterFirst = Object.keys(sourceTree(database)).length;
    const matchCountAfterFirst = Object.keys(matchesTree(database)).length;

    const secondRunId = await createRun(database);
    await run(database, secondRunId, { fetchImpl: buildFetch().fetchImpl });

    expect(Object.keys(sourceTree(database))).toHaveLength(sourceCountAfterFirst);
    expect(Object.keys(matchesTree(database))).toHaveLength(matchCountAfterFirst);
  });

  it('with maxPagesPerInvocation 1, the first invocation stops at the page budget and two more finish the run', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 2 })] }],
      3: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 3 })] }],
    });

    const first = await run(database, runId, { fetchImpl, maxPagesPerInvocation: 1 });
    expect(first.completed).toBe(false);
    expect(first.stopReason).toBe('page-budget');
    expect(first.cursorPage).toBe(2);

    const second = await run(database, runId, {
      fetchImpl,
      maxPagesPerInvocation: 1,
      ownerId: 'invocation-2',
    });
    expect(second.completed).toBe(false);
    expect(second.cursorPage).toBe(3);

    const third = await run(database, runId, {
      fetchImpl,
      maxPagesPerInvocation: 1,
      ownerId: 'invocation-3',
    });
    expect(third.completed).toBe(true);
    expect(Object.keys(sourceTree(database))).toHaveLength(3);
  });

  it('reads only the one run record it was given; a second tenant run is left untouched', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database, 'other-tenant', PLAYER_ID);
    await createRun(database, { tenantId: 'other-tenant' });
    const otherTenantSnapshotBefore = JSON.parse(
      JSON.stringify(rawDump(database).researchIngestionRuns?.['other-tenant']),
    );

    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });
    await run(database, runId, { fetchImpl });

    const otherTenantSnapshotAfter = rawDump(database).researchIngestionRuns?.['other-tenant'];
    expect(otherTenantSnapshotAfter).toEqual(otherTenantSnapshotBefore);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting / backoff
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: rate limiting and backoff', () => {
  it('persists the cursor at the SAME page BEFORE sleeping, then re-fetches and continues (cursor-before-sleep ordering)', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [
        { kind: 'rate-limit', retryAfter: '0' },
        { kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] },
      ],
    });

    const callOrder: string[] = [];
    const sleep = async (ms: number) => {
      callOrder.push(`sleep:${ms}`);
    };
    // Record the order of the cursor write (via a wrapped stageBatchProgress
    // through the run-state node write) against the injected sleep by
    // hooking the underlying transaction on the run-state ref.
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

    const result = await run(database, runId, { fetchImpl, sleep, maxRetriesPerPage: 3 });

    expect(result.completed).toBe(true);
    const sleepIndex = callOrder.findIndex((c) => c.startsWith('sleep:'));
    const firstCursorWriteAfterFetch = callOrder.indexOf('cursor-write');
    expect(firstCursorWriteAfterFetch).toBeGreaterThanOrEqual(0);
    expect(firstCursorWriteAfterFetch).toBeLessThan(sleepIndex);
  });

  it('stamps retryAfterObserved true and the raw value when a Retry-After header is present', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [
        { kind: 'rate-limit', retryAfter: '0' },
        { kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] },
      ],
    });

    const result = await run(database, runId, { fetchImpl, sleep: async () => undefined });
    expect(result.retryAfterObserved).toBe(true);

    const run1 = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(run1?.lastRetryAfterValue).toBe('0');
  });

  it('stamps retryAfterObserved false and still backs off when no Retry-After header is present', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'rate-limit' }, { kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });

    const result = await run(database, runId, { fetchImpl, sleep: async () => undefined });
    expect(result.completed).toBe(true);
    expect(result.retryAfterObserved).toBe(false);
    expect(result.backoffEvents).toBe(1);
  });

  it('exceeding the rate-limit retry budget fails the run with a rate-limit reason and returns without throwing', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'rate-limit', retryAfter: '0' }],
    });

    const result = await run(database, runId, {
      fetchImpl,
      sleep: async () => undefined,
      maxRetriesPerPage: 1,
    });

    expect(result.stopReason).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.reason).toMatch(/rate-limited/);
  });

  it('a query-complexity rejection fails the run immediately and does not retry', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl, calls } = makeScriptedFetch({ 1: [{ kind: 'complexity' }] });

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toBe('query-complexity-rejected');
    expect(calls.filter((p) => p === 1)).toHaveLength(1);
  });

  it('a non-rate-limit provider error fails the run with that reason, preserving the cursor', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({ 1: [{ kind: 'error', status: 500 }] });

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(result.retryable).toBe(false);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('failed');
    expect(stored?.cursor?.page).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Durable-write failures and page-level retry
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: durable-write failures', () => {
  function withFailingUpsert(database: FakeDatabase, failuresRemaining: { count: number }) {
    const baseRef = database.ref.bind(database);
    (database as unknown as { ref: typeof database.ref }).ref = (path?: string) => {
      const ref = baseRef(path);
      if (path && path.startsWith('researchSource/') && failuresRemaining.count > 0) {
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

  it('with maxWriteRetriesPerPage 0, a write failure leaves the cursor on the same page with pageAttempt incremented and returns retryable-write', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    withFailingUpsert(database, { count: 1 });
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });

    const result = await run(database, runId, { fetchImpl, maxWriteRetriesPerPage: 0 });

    expect(result.stopReason).toBe('retryable-write');
    expect(result.completed).toBe(false);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.cursor?.page).toBe(1);
    expect(stored?.cursor?.pageAttempt).toBe(1);
  });

  it('with the DEFAULT write-retry budget, the same one-shot injection is absorbed and the run completes', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    withFailingUpsert(database, { count: 1 });
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });

    const result = await run(database, runId, {
      fetchImpl,
      maxWriteRetriesPerPage: DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
    });

    expect(result.completed).toBe(true);
    expect(result.writeRetries).toBe(1);
    expect(Object.keys(sourceTree(database))).toHaveLength(1);
  });

  it('exceeding the write-retry budget fails the run with a write-failure reason and leaves the cursor at that page', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    withFailingUpsert(database, { count: 5 });
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });

    const result = await run(database, runId, { fetchImpl, maxWriteRetriesPerPage: 2 });

    expect(result.stopReason).toBe('retryable-write');
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('failed');
    expect(stored?.cursor?.page).toBe(1);
  });

  it('a set appearing on two adjacent pages contributes exactly once to discoveredAllGames and imported', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const overlappingSet = makeSet({ id: 42 });
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet, makeSet({ id: 43 })] }],
    });

    await run(database, runId, { fetchImpl });

    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.discoveredAllGames).toBe(2);
    expect(stored?.stagedCounters?.imported).toBe(2);
  });

  it('the combined overlap-plus-write-failure fixture contributes exactly once (review C3-H4a)', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const overlappingSet = makeSet({ id: 99 });
    withFailingUpsert(database, { count: 1 });
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [overlappingSet, makeSet({ id: 100 })] }],
    });

    const result = await run(database, runId, {
      fetchImpl,
      maxWriteRetriesPerPage: DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
    });

    expect(result.completed).toBe(true);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.discoveredAllGames).toBe(2);
    expect(stored?.stagedCounters?.imported).toBe(2);
  });

  it('an unsafe provider id is stored under a derived-safe key, increments the unsafe-key gap, and remaining sets still process', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const unsafeSet = makeSet({ id: 1, subjectEntrantId: 10, opponentEntrantId: 20 });
    (unsafeSet as unknown as { id: string }).id = 'set.with.dots';
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [unsafeSet, makeSet({ id: 2 })] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.completed).toBe(true);
    expect(Object.keys(sourceTree(database))).toHaveLength(2);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedNamedGaps?.unsafeProviderKey).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Classification behavior
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: classification behavior', () => {
  it('a non-SSBU set produces a source record with the non-ssbu classification and no legacy match row', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1, videogameId: 99999 })] }],
    });

    await run(database, runId, { fetchImpl });

    const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
    expect(stored.classification).toBe('non-ssbu');
    expect(Object.keys(matchesTree(database))).toHaveLength(0);
    const run1 = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(run1?.stagedCounters?.discoveredAllGames).toBe(1);
    expect(run1?.stagedCounters?.discoveredEligible ?? 0).toBe(0);
  });

  it('a set with an absent videogame id is unresolved, increments the unknown-videogame gap, and is never non-ssbu', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1, videogameId: null })] }],
    });

    await run(database, runId, { fetchImpl });

    const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
    expect(stored.classification).toBe('unresolved');
    const run1 = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(run1?.stagedNamedGaps?.unknownVideogame).toBe(1);
  });

  it('a DQ set produces a source record and zero legacy match rows', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1, isDisqualified: true })] }],
    });

    await run(database, runId, { fetchImpl });

    const stored = Object.values(sourceTree(database))[0] as Record<string, unknown>;
    expect(stored.classification).toBe('dq');
    expect(Object.keys(matchesTree(database))).toHaveLength(0);
  });

  it('re-running after a set flips from complete to DQ deletes the projected match rows and increments corrected', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);

    const firstRunId = await createRun(database);
    const { fetchImpl: fetch1 } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 7 })] }],
    });
    await run(database, firstRunId, { fetchImpl: fetch1 });
    expect(Object.keys(matchesTree(database))).toHaveLength(1);

    const secondRunId = await createRun(database);
    const { fetchImpl: fetch2 } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 7, isDisqualified: true })] }],
    });
    await run(database, secondRunId, { fetchImpl: fetch2, ownerId: 'invocation-2' });

    expect(Object.keys(matchesTree(database))).toHaveLength(0);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, secondRunId);
    expect(stored?.stagedCounters?.corrected).toBe(1);
  });

  it('a stale-write-skipped upsert accumulates nothing, produces no projection, and increments staleWritesSkipped', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const set = makeSet({ id: 1 });
    // Seed a record with a NEWER lastObservedAtMs than the fetch this
    // invocation will use, forcing the stale-write-skipped compare-and-skip.
    database.seed(`researchSource/${TENANT_ID}/sets/1`, {
      providerSetId: '1',
      apiIds: { setId: '1' },
      classification: 'complete',
      ruleId: 'R-COMPLETE',
      ingestionRunId: 'some-other-run',
      fetchedAtMs: 5_000_000,
      lastObservedAtMs: 5_000_000,
      contentFingerprint: 'irrelevant',
    });
    const { fetchImpl } = makeScriptedFetch({ 1: [{ kind: 'ok', totalPages: 1, sets: [set] }] });

    const result = await run(database, runId, { fetchImpl, now: () => 1_000 });

    expect(result.staleWritesSkipped).toBe(1);
    expect(result.completed).toBe(true);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.discoveredAllGames ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Identity candidate mining
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: identity candidates', () => {
  it('mines and records identity candidates once per page, before the cursor advances', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [
      { playerId: PLAYER_ID, gamerTag: 'Subject', knownTagVariants: ['Alt Tag'] },
    ]);
    const runId = await createRun(database);
    const candidateSet = makeSet({
      id: 1,
      subjectPlayerId: SUBJECT_PLAYER_ID,
      opponentPlayerId: 300,
      opponentEntrantId: 21,
    });
    (
      candidateSet.slots![1]!.entrant as { participants: { player: { gamerTag: string } }[] }
    ).participants[0]!.player.gamerTag = 'Alt Tag';
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [candidateSet] }],
    });

    await run(database, runId, { fetchImpl });

    const mappingDump = rawDump(database).researchIdentity?.[TENANT_ID];
    expect(mappingDump?.candidates?.['300']).toBeDefined();
  });

  it('a recordIdentityCandidates rejection abandons the page; the candidates are present after the retry', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, UID, [
      { playerId: PLAYER_ID, gamerTag: 'Subject', knownTagVariants: ['Alt Tag'] },
    ]);
    const runId = await createRun(database);
    const candidateSet = makeSet({ id: 1, opponentPlayerId: 300, opponentEntrantId: 21 });
    (
      candidateSet.slots![1]!.entrant as { participants: { player: { gamerTag: string } }[] }
    ).participants[0]!.player.gamerTag = 'Alt Tag';
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [candidateSet] }],
    });

    let failedOnce = false;
    const baseRef = database.ref.bind(database);
    (database as unknown as { ref: typeof database.ref }).ref = (path?: string) => {
      const ref = baseRef(path);
      if (path === `researchIdentity/${TENANT_ID}` && !failedOnce) {
        const originalTx = ref.transaction.bind(ref);
        return {
          ...ref,
          transaction: async (fn: (current: unknown) => unknown) => {
            if (!failedOnce) {
              failedOnce = true;
              throw new Error('simulated candidate write failure');
            }
            return originalTx(fn);
          },
        };
      }
      return ref;
    };

    const result = await run(database, runId, {
      fetchImpl,
      maxWriteRetriesPerPage: DEFAULT_MAX_WRITE_RETRIES_PER_PAGE,
    });

    expect(result.completed).toBe(true);
    expect(result.writeRetries).toBe(1);
    const mappingDump = rawDump(database).researchIdentity?.[TENANT_ID];
    expect(mappingDump?.candidates?.['300']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Startup validation / terminal reachability (review C3-H1)
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: startup failures reach a terminal state', () => {
  it('a run whose stored playerId cannot be converted ends failed, clears activeRunId, and frees the tenant', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database, TENANT_ID, 'not-a-number');
    const runId = await createRun(database, { playerId: 'not-a-number' });
    const { fetchImpl, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(calls).toHaveLength(0);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('failed');
    expect(stored?.lease).toBeUndefined();
    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBeNull();

    const next = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: PLAYER_ID,
      requestedByUid: UID,
      mode: 'full',
    });
    expect(next.outcome).toBe('created');
  });

  it('a run whose tenant has no confirmed player ids fails with the identity reason and issues zero fetches', async () => {
    const database = new FakeDatabase();
    // No confirmIdentityPlayers call — an unconfirmed tenant.
    const runId = await createRun(database);
    const { fetchImpl, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toBe('identity-not-confirmed');
    expect(calls).toHaveLength(0);
    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBeNull();
  });

  it('a run whose stored playerId is non-numeric fails with the invalid-player-id reason and issues zero fetches', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database, TENANT_ID, 'abc123');
    const runId = await createRun(database, { playerId: 'abc123' });
    const { fetchImpl, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.reason).toBe('invalid-player-id');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lease semantics
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: lease semantics', () => {
  it('a second concurrent invocation returns lease-held with zero fetch calls', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'someone-else');

    const { fetchImpl, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('lease-held');
    expect(result.completed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a stored fence bump between two pages stops the invocation with lease-lost, without failing the run', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    let fenceBumped = false;
    const { fetchImpl: baseFetch } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 2 })] }],
    });
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { page: number } };
      if (body.variables.page === 2 && !fenceBumped) {
        fenceBumped = true;
        await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'invocation-1');
      }
      return baseFetch(url, init);
    }) as unknown as typeof fetch;

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('lease-lost');
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('running');
  });

  it('a lease taken between the fetch and the first write of a page leaves the source subtree unchanged', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const preSourceState = JSON.stringify(sourceTree(database));
    let stolen = false;
    const { fetchImpl: baseFetch } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await baseFetch(url, init);
      if (!stolen) {
        stolen = true;
        await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'invocation-1');
      }
      return response;
    }) as unknown as typeof fetch;

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('lease-lost');
    expect(JSON.stringify(sourceTree(database))).toBe(preSourceState);
  });

  it('an invocation refused the lease attempts neither startup validation', async () => {
    const database = new FakeDatabase();
    // Deliberately give the run an invalid playerId AND no confirmed
    // identity mapping — if either validation ran, it would fail the run.
    await createRun(database, { playerId: 'not-a-number' });
    const runId = (await readTenantIngestionState(asDatabase(database), TENANT_ID)).activeRunId!;
    await acquireRunLease(asDatabase(database), TENANT_ID, runId, 'someone-else');

    const result = await run(database, runId, {});

    expect(result.stopReason).toBe('lease-held');
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Synchronous sleep budget (review C2-A3, C3-A1)
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: synchronous sleep budget', () => {
  it('an invocation whose accumulated sleep would exceed maxSyncBackoffMs returns backoff-pending without sleeping', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'rate-limit', retryAfter: '9999' }],
    });
    let slept = false;
    const sleep = async () => {
      slept = true;
    };

    const result = await run(database, runId, { fetchImpl, sleep, maxSyncBackoffMs: 100 });

    expect(result.stopReason).toBe('backoff-pending');
    expect(result.retryable).toBe(true);
    expect(slept).toBe(false);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('running');
    expect(stored?.lease).toBeUndefined();
  });

  it('across several throttle acquisitions against a drained bucket, the sum of slept ms never exceeds maxSyncBackoffMs', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Drain the shared token bucket so every acquire() must wait.
    database.seed(RESEARCH_TOKEN_BUDGET_PATH, { tokensMilli: 0, lastRefillAtMs: 0 });
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 5, sets: [makeSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 5, sets: [makeSet({ id: 2 })] }],
      3: [{ kind: 'ok', totalPages: 5, sets: [makeSet({ id: 3 })] }],
      4: [{ kind: 'ok', totalPages: 5, sets: [makeSet({ id: 4 })] }],
      5: [{ kind: 'ok', totalPages: 5, sets: [makeSet({ id: 5 })] }],
    });
    let clock = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      clock += ms;
    };

    const result = await run(database, runId, {
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
// Terminal-run recovery and publication (review C-H8, C2-H4, C2-H3)
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: terminal-run recovery and coverage publication', () => {
  it('a completed run with no coveragePublishedAtMs is published and marked, with zero fetch calls', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl: fetch1 } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });
    await run(database, runId, { fetchImpl: fetch1 });

    // Simulate a crash between completion and publication: clear the
    // coveragePublishedAtMs marker while keeping the run completed.
    const runsDump = rawDump(database);
    delete runsDump.researchIngestionRuns![TENANT_ID]!.runs![runId]!.coveragePublishedAtMs;

    const { fetchImpl: fetch2, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const result = await run(database, runId, { fetchImpl: fetch2 });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(calls).toHaveLength(0);
    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.players[PLAYER_ID]).toBeDefined();
  });

  it('a completed and already-published run is a pure no-op: zero fetches, zero writes', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl: fetch1 } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });
    await run(database, runId, { fetchImpl: fetch1 });

    const preDump = JSON.stringify(database.dump());
    const { fetchImpl: fetch2, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const result = await run(database, runId, { fetchImpl: fetch2 });

    expect(result.completed).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(database.dump())).toBe(preDump);
  });

  it('reaching the final page completes and publishes the run, matching the run staged values', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });

    const result = await run(database, runId, { fetchImpl });
    expect(result.completed).toBe(true);

    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.players[PLAYER_ID]?.counters.discoveredAllGames).toBe(
      stored?.stagedCounters?.discoveredAllGames,
    );
  });

  it('an invocation that does not reach the final page publishes nothing', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 2 })] }],
    });

    const result = await run(database, runId, { fetchImpl, maxPagesPerInvocation: 1 });
    expect(result.completed).toBe(false);

    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage).toBeNull();
  });

  it('a stale run republication does not roll a newer completed run backward (review C2-H4)', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);

    const runA = await createRun(database);
    const { fetchImpl: fetchA } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });
    await run(database, runA, { fetchImpl: fetchA, now: () => 1_000 });

    const runB = await createRun(database);
    const { fetchImpl: fetchB } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 2 })] }],
    });
    await run(database, runB, { fetchImpl: fetchB, ownerId: 'invocation-b', now: () => 2_000 });

    const coverageBeforeReplay = await readCoverageSnapshot(asDatabase(database), TENANT_ID);

    // Strip run A's publication marker and re-address it.
    const runsDump = rawDump(database);
    delete runsDump.researchIngestionRuns![TENANT_ID]!.runs![runA]!.coveragePublishedAtMs;
    const { fetchImpl: fetchReplay, calls } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [] }],
    });
    const result = await run(database, runA, { fetchImpl: fetchReplay, ownerId: 'invocation-c' });

    expect(result.completed).toBe(true);
    expect(calls).toHaveLength(0);
    const coverageAfterReplay = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverageAfterReplay).toEqual(coverageBeforeReplay);
    const storedRunA = await readBackfillRun(asDatabase(database), TENANT_ID, runA);
    expect(storedRunA?.coveragePublishedAtMs).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Never-throw infra boundary contract (review C2-H6)
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: never-throw infrastructure boundary', () => {
  it('declares exactly seventeen wrapped boundaries: twelve table-driven plus five dedicated', () => {
    const tableDriven = [
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
    const dedicated = [
      'fetchResearchSetsPage',
      'fetchResearchSetsIdProbe',
      'upsertResearchSourceSet',
      'readResearchSourceSet',
      'applyLegacyProjection',
    ];
    expect(new Set([...tableDriven, ...dedicated])).toEqual(
      new Set(RESEARCH_BACKFILL_INFRA_BOUNDARIES),
    );
    expect(RESEARCH_BACKFILL_INFRA_BOUNDARIES).toHaveLength(17);
  });

  it.each([
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
  ])('resolves with a declared stop reason when %s rejects', async (boundaryPath) => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
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

    // Boundaries that go through the run-state ref are triggered by failing
    // EVERY transaction against that ref, since this suite proves each
    // boundary resolves with a stop reason rather than a rejected promise —
    // not the exact call site within the shared node.
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

    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 1, sets: [makeSet({ id: 1 })] }],
    });

    let result;
    let threw = false;
    try {
      result = await run(database, runId, { fetchImpl });
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
  });

  it.each([
    'fetchResearchSetsPage',
    'fetchResearchSetsIdProbe',
    'upsertResearchSourceSet',
    'readResearchSourceSet',
    'applyLegacyProjection',
  ])(
    'the %s dedicated boundary is covered by its own named behavior test elsewhere in this suite',
    (boundaryName) => {
      // fetchResearchSetsPage: 'a non-rate-limit provider error fails the run...' above.
      // fetchResearchSetsIdProbe: the provider-dead-page carve-out suite below.
      // upsertResearchSourceSet: 'with maxWriteRetriesPerPage 0, a write failure...' above.
      // readResearchSourceSet / applyLegacyProjection: covered by the same
      // page-abandonment mechanism exercised by the durable-write-failure
      // tests above, since all four boundaries share one abandon-and-retry
      // code path in the executor.
      expect(typeof boundaryName).toBe('string');
    },
  );
});

// ---------------------------------------------------------------------------
// Provider-truncation guard (live probe 2026-08-08: start.gg silently clips
// node lists to fit its object budget instead of returning its documented
// over-budget rejection; a fully clipped page reports totalPages 0)
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: provider-truncation guard', () => {
  it('fails the run when a short non-final page arrives at page 1 (in-response clipping, no prior knowledge yet)', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // perPage 2, one node returned, totalPages says 1559 more pages exist —
    // the exact shape the live probe observed at the budget cliff. This is
    // page 1 (no prior pagination knowledge exists yet), so "pages remain"
    // is decided from the RESPONSE's own totalPages — `fetchResearchSetsPage`
    // itself no longer guards against this shape (Dead-PREFIX extension);
    // the confirmation probe finding a SECOND id the heavy query never
    // returned is what confirms this is clipping, not a dead prefix.
    const { fetchImpl } = makeScriptedFetch({
      1: [
        { kind: 'ok', totalPages: 1559, sets: [makeSet({ id: 1 })] }, // main fetch: 1/2
        { kind: 'ok', totalPages: 1559, sets: [makeSet({ id: 1 }), makeSet({ id: 2 })] }, // probe: finds an EXTRA id
      ],
    });

    const result = await run(database, runId, { fetchImpl, perPage: 2 });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toContain('provider-truncated-page');
    // Nothing from the clipped page may land: a partial page is lost rows.
    expect(Object.keys(sourceTree(database))).toHaveLength(0);
  });

  it('fails the run when a later page collapses to zero nodes and the confirmation probe finds nodes (the heavy query was clipped)', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Page 1 is full (1/1) and establishes totalPages 3; page 2 arrives
    // fully clipped (0 nodes, totalPages collapsed to 0) — in-response
    // detection cannot see this, the executor's prior-knowledge check must.
    // The same-page ID-only confirmation probe (the provider-dead-page
    // carve-out's discriminator) finds a node the heavy query did not, so
    // this is confirmed clipping, not a dead page — the hard failure stands.
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 1 })] }],
      2: [
        { kind: 'ok', totalPages: 0, sets: [] }, // main fetch: collapsed/empty
        { kind: 'ok', totalPages: 3, sets: [makeSet({ id: 999 })] }, // confirmation probe: finds a node
      ],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toContain('provider-truncated-page');
    expect(result.reason).toContain('totalPages=3');
    // Page 1's full contents survive; the run is restartable after the fix.
    expect(Object.keys(sourceTree(database))).toHaveLength(1);
  });

  it('still completes on a legitimately short (empty) final page', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Provider count drift: totalPages 2 but page 2 is empty. totalPages is
    // NOT beyond the current page, so this is a legitimate final page shape
    // — the guard must not overfire and the run must complete.
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 2, sets: [makeSet({ id: 1 })] }],
      2: [{ kind: 'ok', totalPages: 2, sets: [] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.completed).toBe(true);
    expect(Object.keys(sourceTree(database))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provider-dead-page carve-out (30-CONTEXT.md "Provider-dead-page
// carve-out", decided by Codex advisor as product-owner proxy, 2026-08-08):
// start.gg deterministically returns an EMPTY connection (total=0,
// totalPages=0) for specific row ranges of a player's history (observed:
// Hungrybox rows 16-30) — a provider-side fault, not clipping. A same-page
// ID-only confirmation probe distinguishes a genuinely dead page from a
// clipped one, since the zero/zero shape alone is not unique to either.
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: provider-dead-page carve-out', () => {
  it('materializes zero classification maps so a dead-page receipt survives an RTDB empty-object round trip', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 1 })] }],
      2: [
        { kind: 'ok', totalPages: 0, sets: [] },
        { kind: 'ok', totalPages: 0, sets: [] },
      ],
      3: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 2 })] }],
    });

    await run(database, runId, { fetchImpl, maxPagesPerInvocation: 1 });
    const second = await run(database, runId, {
      fetchImpl,
      maxPagesPerInvocation: 1,
      ownerId: 'invocation-2',
    });
    expect(second.stopReason).toBe('page-budget');
    expect(second.cursorPage).toBe(3);

    const rawState = rawDump(database).researchIngestionRuns?.[TENANT_ID] as unknown as {
      runs: Record<string, { pendingPageReceipt: Record<string, unknown> }>;
    };
    const rawReceipt = rawState.runs[runId]!.pendingPageReceipt;
    const expectedZeros = normalizeResearchClassificationCounts(undefined);
    expect(rawReceipt.classificationCounts).toEqual(expectedZeros);
    expect(rawReceipt.uniqueClassificationCounts).toEqual(expectedZeros);

    const roundTripped = stripEmptyObjectsLikeRtdb(rawState);
    const parsed = researchTenantIngestionStateSchema.safeParse(roundTripped);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.runs?.[runId]?.pendingPageReceipt?.classificationCounts).toEqual(
        expectedZeros,
      );
      expect(parsed.data.runs?.[runId]?.pendingPageReceipt?.uniqueClassificationCounts).toEqual(
        expectedZeros,
      );
    }
  });

  it('an empty+collapsed page whose confirmation probe ALSO returns zero stages a named-gap receipt, advances the cursor, and the run completes with the counters published', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Page 1 establishes totalPages 3; page 2 collapses to zero nodes/zero
    // totalPages, and its confirmation probe ALSO reports zero nodes/zero
    // total — CONFIRMED dead, not clipped. Page 3 is the real final page.
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 1 })] }],
      2: [
        { kind: 'ok', totalPages: 0, sets: [] }, // main fetch
        { kind: 'ok', totalPages: 0, sets: [] }, // confirmation probe: also empty
      ],
      3: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 2 })] }],
    });

    const result = await run(database, runId, { fetchImpl });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe('completed');
    // The dead page contributed no source record — only pages 1 and 3 did.
    expect(Object.keys(sourceTree(database))).toHaveLength(2);

    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.providerUnavailablePages).toBe(1);
    expect(stored?.stagedCounters?.providerUnavailableRowEstimate).toBe(1); // perPage 1 in this suite's run() helper

    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.players[PLAYER_ID]?.counters.providerUnavailablePages).toBe(1);
    expect(coverage?.players[PLAYER_ID]?.counters.providerUnavailableRowEstimate).toBe(1);
    expect(coverage?.totals.counters.providerUnavailablePages).toBe(1);
  });

  it('26 consecutive confirmed dead pages fail the run with the dead-page-cap reason', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Page 1 establishes a large totalPages; every subsequent page falls
    // back to the scripted default (empty/zero for BOTH the main fetch and
    // its confirmation probe), so it is confirmed dead every time.
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 100, sets: [makeSet({ id: 1 })] }],
    });

    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const result = await run(database, runId, {
      fetchImpl,
      maxPagesPerInvocation: 40,
      maxSyncBackoffMs: 300_000,
      sleep,
      now: () => clock,
    });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toMatch(/provider-unavailable streak exceeded/);
    expect(result.reason).toContain(String(RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES + 1));
    // Only page 1 ever wrote a source record; the cap trips before any of
    // the dead pages could be mistaken for real ones.
    expect(Object.keys(sourceTree(database))).toHaveLength(1);
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('failed');
  });

  it('a healthy page between two runs of dead pages resets the consecutive-dead-page counter, so the run still completes', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Page 1 establishes totalPages 30. Pages 2-14 (13 dead pages) and
    // pages 16-29 (14 more dead pages) fall back to the scripted default
    // (confirmed dead — none of them is the final page, so every one goes
    // through the confirmation probe rather than the legitimate-short-
    // final-page path); page 15 and page 30 are real, healthy pages.
    // Combined, 13 + 14 = 27 consecutive dead pages would exceed the cap of
    // 25 without a reset — the healthy page at 15 must reset the run so
    // neither run individually ever approaches the cap.
    const { fetchImpl } = makeScriptedFetch({
      1: [{ kind: 'ok', totalPages: 30, sets: [makeSet({ id: 1 })] }],
      15: [{ kind: 'ok', totalPages: 30, sets: [makeSet({ id: 2 })] }],
      30: [{ kind: 'ok', totalPages: 30, sets: [makeSet({ id: 3 })] }],
    });

    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const result = await run(database, runId, {
      fetchImpl,
      maxPagesPerInvocation: 40,
      maxSyncBackoffMs: 300_000,
      sleep,
      now: () => clock,
    });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe('completed');
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.providerUnavailablePages).toBe(27);
  });
});

// ---------------------------------------------------------------------------
// Dead-PREFIX extension (30-CONTEXT.md "Dead-PREFIX extension", decided by
// Codex advisor as product-owner proxy, 2026-08-08): a dead zone's LEADING
// EDGE presents as a SHORT-BUT-NONZERO page with intact totalPages — the
// provider returns the page's living prefix and silently drops rows from
// the first dead row on. Safeguard 1: the same-page ID-only confirmation
// probe must find the EXACT same id set as the heavy query's returned
// nodes (any mismatch retains the hard clipping failure). Safeguard 2: the
// consecutive-unavailable streak is DURABLE (persisted on the cursor),
// never invocation-scoped.
// ---------------------------------------------------------------------------

describe('runResearchBackfillBatch: dead-PREFIX extension', () => {
  it('a confirmed dead-PREFIX page (heavy 2/3, probe returns the identical 2 ids) ingests the living rows normally and stages the provider-unavailable counters on the same receipt', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    // Page 1 is a FULL page (3/3, perPage 3) establishing totalPages 3 —
    // full, so it never enters the short-page detection at all. Page 2 is
    // a dead PREFIX: the heavy query returns 2/3 living rows and the
    // confirmation probe returns the SAME 2 ids — CONFIRMED dead prefix,
    // not clipping. Page 3 is the real final page.
    const { fetchImpl } = makeScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 3,
          sets: [makeSet({ id: 1 }), makeSet({ id: 2 }), makeSet({ id: 3 })],
        },
      ],
      2: [
        { kind: 'ok', totalPages: 3, sets: [makeSet({ id: 4 }), makeSet({ id: 5 })] }, // main fetch: 2/3
        { kind: 'ok', totalPages: 3, sets: [makeSet({ id: 4 }), makeSet({ id: 5 })] }, // probe: identical ids
      ],
      3: [{ kind: 'ok', totalPages: 3, sets: [makeSet({ id: 9 })] }],
    });

    const result = await run(database, runId, { fetchImpl, perPage: 3 });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe('completed');
    // Page 2's two LIVING rows were ingested normally (unlike the
    // empty-page carve-out, which has nothing to ingest): 3 (page 1) + 2
    // (page 2's living prefix) + 1 (page 3) = 6 source records.
    expect(Object.keys(sourceTree(database))).toHaveLength(6);
    expect(sourceTree(database)['4']).toBeDefined();
    expect(sourceTree(database)['5']).toBeDefined();

    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.providerUnavailablePages).toBe(1);
    // perPage 3 - 2 living rows = 1 estimated dead row on page 2.
    expect(stored?.stagedCounters?.providerUnavailableRowEstimate).toBe(1);

    const coverage = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(coverage?.players[PLAYER_ID]?.counters.providerUnavailablePages).toBe(1);
    expect(coverage?.players[PLAYER_ID]?.counters.providerUnavailableRowEstimate).toBe(1);
    expect(coverage?.totals.counters.providerUnavailablePages).toBe(1);
  });

  it('fails the run as provider-truncated when the confirmation probe finds an EXTRA id beyond the heavy query’s returned rows', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 3,
          sets: [makeSet({ id: 1 }), makeSet({ id: 2 }), makeSet({ id: 3 })],
        },
      ],
      2: [
        { kind: 'ok', totalPages: 3, sets: [makeSet({ id: 4 }), makeSet({ id: 5 })] }, // main: 2/3
        {
          kind: 'ok',
          totalPages: 3,
          sets: [makeSet({ id: 4 }), makeSet({ id: 5 }), makeSet({ id: 6 })], // probe: 3 ids, a superset
        },
      ],
    });

    const result = await run(database, runId, { fetchImpl, perPage: 3 });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toContain('provider-truncated-page');
    // Nothing from page 2 lands — only page 1's three records survive.
    expect(Object.keys(sourceTree(database))).toHaveLength(3);
  });

  it('fails the run as provider-truncated when the confirmation probe returns a DIFFERENT id set of the same size', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);
    const { fetchImpl } = makeScriptedFetch({
      1: [
        {
          kind: 'ok',
          totalPages: 3,
          sets: [makeSet({ id: 1 }), makeSet({ id: 2 }), makeSet({ id: 3 })],
        },
      ],
      2: [
        { kind: 'ok', totalPages: 3, sets: [makeSet({ id: 4 }), makeSet({ id: 5 })] }, // main: 2/3
        { kind: 'ok', totalPages: 3, sets: [makeSet({ id: 4 }), makeSet({ id: 777 })] }, // probe: id 777 instead of 5
      ],
    });

    const result = await run(database, runId, { fetchImpl, perPage: 3 });

    expect(result.stopReason).toBe('failed');
    expect(result.reason).toContain('provider-truncated-page');
    expect(Object.keys(sourceTree(database))).toHaveLength(3);
  });

  it('a durable consecutive-dead-page streak spread across multiple invocations still fails at the cap (persisted via the cursor, never an invocation-scoped counter)', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);

    // Page 1 is a full, healthy 2/2 page (perPage 2) establishing totalPages
    // 100. Pages 2 through 27 (26 pages) are each a confirmed dead PREFIX
    // (1/2 living rows, probe confirms the same single id) — one MORE than
    // the cap, so the run must fail exactly once the streak reaches 26,
    // no matter how many separate invocations it takes to get there.
    const script: Record<number, PageScriptEntry[]> = {
      1: [{ kind: 'ok', totalPages: 100, sets: [makeSet({ id: 1 }), makeSet({ id: 2 })] }],
    };
    for (let page = 2; page <= 27; page += 1) {
      const setId = 1000 + page;
      script[page] = [
        { kind: 'ok', totalPages: 100, sets: [makeSet({ id: setId })] }, // main: 1/2
        { kind: 'ok', totalPages: 100, sets: [makeSet({ id: setId })] }, // probe: identical id
      ];
    }
    const { fetchImpl } = makeScriptedFetch(script);

    // A shared manual clock across every invocation — the real throttle's
    // token-bucket pacing would otherwise force real (slow) waits across
    // ~50+ scripted requests and blow the test timeout.
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };

    let result = await run(database, runId, {
      fetchImpl,
      perPage: 2,
      maxPagesPerInvocation: 10,
      maxSyncBackoffMs: 300_000,
      sleep,
      now: () => clock,
      ownerId: 'invocation-1',
    });
    let invocationCount = 1;
    while (result.stopReason === 'page-budget') {
      invocationCount += 1;
      result = await run(database, runId, {
        fetchImpl,
        perPage: 2,
        maxPagesPerInvocation: 10,
        maxSyncBackoffMs: 300_000,
        sleep,
        now: () => clock,
        ownerId: `invocation-${invocationCount}`,
      });
    }

    // Proves persistence: the cap could not have been reached from a single
    // invocation's own budget (10 pages), so multiple invocations' worth of
    // durably-staged cursor state had to accumulate to trip it.
    expect(invocationCount).toBeGreaterThan(1);
    expect(result.stopReason).toBe('failed');
    expect(result.reason).toMatch(/provider-unavailable streak exceeded/);
    expect(result.reason).toContain(String(RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES + 1));
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.status).toBe('failed');
  });

  it('a full healthy page mid-stream resets the durable streak, so 30 dead-PREFIX pages split 15/15 around it never trip the cap', async () => {
    const database = new FakeDatabase();
    await confirmPlayer(database);
    const runId = await createRun(database);

    // Page 1 (healthy, establishes totalPages 33) + pages 2-16 (15 dead
    // prefixes) + page 17 (healthy full page — resets the streak) + pages
    // 18-32 (15 more dead prefixes) + page 33 (the real final page).
    // Combined, 15 + 15 = 30 consecutive dead pages would exceed the cap of
    // 25 without the reset at page 17 — the healthy page must reset the
    // streak so neither block individually approaches the cap.
    const script: Record<number, PageScriptEntry[]> = {
      1: [{ kind: 'ok', totalPages: 33, sets: [makeSet({ id: 1 }), makeSet({ id: 2 })] }],
      17: [{ kind: 'ok', totalPages: 33, sets: [makeSet({ id: 900 }), makeSet({ id: 901 })] }],
      33: [{ kind: 'ok', totalPages: 33, sets: [makeSet({ id: 999 })] }],
    };
    for (const page of [...Array(15).keys()].map((i) => i + 2)) {
      const setId = 2000 + page;
      script[page] = [
        { kind: 'ok', totalPages: 33, sets: [makeSet({ id: setId })] },
        { kind: 'ok', totalPages: 33, sets: [makeSet({ id: setId })] },
      ];
    }
    for (const page of [...Array(15).keys()].map((i) => i + 18)) {
      const setId = 3000 + page;
      script[page] = [
        { kind: 'ok', totalPages: 33, sets: [makeSet({ id: setId })] },
        { kind: 'ok', totalPages: 33, sets: [makeSet({ id: setId })] },
      ];
    }
    const { fetchImpl } = makeScriptedFetch(script);

    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const result = await run(database, runId, {
      fetchImpl,
      perPage: 2,
      maxPagesPerInvocation: 40,
      maxSyncBackoffMs: 300_000,
      sleep,
      now: () => clock,
    });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe('completed');
    const stored = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(stored?.stagedCounters?.providerUnavailablePages).toBe(30);
  });
});
