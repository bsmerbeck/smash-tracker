import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type { ResearchIngestionRun, ResearchPageReceipt } from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  acquireRunLease,
  completeBackfillRun,
  createOrResumeBackfillRun,
  type RunLeaseHolder,
} from './backfillRun.js';
import {
  buildCoverageResponse,
  deriveRefreshUpdatedAfterSeconds,
  foldClassificationCounts,
  foldCounters,
  foldNamedGaps,
  foldPageReceipt,
  mergeDateCoverage,
  mergeDateCoverageSpan,
  publishCoverageSnapshot,
  readCoverageSnapshot,
  stageBatchProgress,
} from './rollup.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-1';
const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';
const UID = 'admin-1';

function emptyReceipt(overrides: Partial<ResearchPageReceipt> = {}): ResearchPageReceipt {
  return {
    page: 1,
    attempt: 0,
    stagedAtMs: 0,
    counters: {},
    namedGaps: {},
    classificationCounts: {},
    uniqueCounters: {},
    uniqueNamedGaps: {},
    uniqueClassificationCounts: {},
    ...overrides,
  };
}

async function createAcquiredRun(
  database: FakeDatabase,
  playerId: string,
  now = 1_000,
): Promise<{ runId: string; holder: RunLeaseHolder }> {
  const created = await createOrResumeBackfillRun(asDatabase(database), {
    tenantId: TENANT_ID,
    playerId,
    requestedByUid: UID,
    mode: 'full',
    now,
  });
  const acquired = await acquireRunLease(
    asDatabase(database),
    TENANT_ID,
    created.runId!,
    'owner-a',
    now,
  );
  return { runId: created.runId!, holder: acquired.holder! };
}

describe('foldCounters / foldNamedGaps / foldClassificationCounts', () => {
  it('foldCounters(undefined, { imported: 2 }) returns every counter at 0 except imported at 2', () => {
    const result = foldCounters(undefined, { imported: 2 });
    expect(result).toEqual({
      discoveredAllGames: 0,
      discoveredEligible: 0,
      imported: 2,
      skipped: 0,
      unresolved: 0,
      corrected: 0,
      providerUnavailablePages: 0,
      providerUnavailableRowEstimate: 0,
    });
  });

  it('foldCounters adds present delta members and leaves absent members unchanged', () => {
    const existing = { imported: 5, skipped: 1 };
    const result = foldCounters(existing, { imported: 2 });
    expect(result.imported).toBe(7);
    expect(result.skipped).toBe(1);
  });

  it('foldNamedGaps behaves identically over the gap counters', () => {
    const result = foldNamedGaps({ unknownCharacter: 3 }, { unknownCharacter: 1, unknownStage: 2 });
    expect(result.unknownCharacter).toBe(4);
    expect(result.unknownStage).toBe(2);
  });

  it('foldClassificationCounts behaves identically over the per-classification map', () => {
    const result = foldClassificationCounts({ complete: 3 }, { complete: 1, dq: 2 });
    expect(result.complete).toBe(4);
    expect(result.dq).toBe(2);
  });
});

describe('mergeDateCoverage / mergeDateCoverageSpan', () => {
  const AUG_2026_MS = 1_767_225_600_000; // 2026-01-01T00:00:00Z-ish era, a real 2026 epoch-ms value
  const JAN_2025_MS = 1_735_689_600_000;

  it('sets both ends to a real 2026 epoch-millisecond value when starting from nothing', () => {
    const result = mergeDateCoverage(undefined, AUG_2026_MS);
    expect(result).toEqual({ earliestSetAtMs: AUG_2026_MS, latestSetAtMs: AUG_2026_MS });
  });

  it('widens the earliest and leaves the latest alone', () => {
    const result = mergeDateCoverage(
      { earliestSetAtMs: AUG_2026_MS, latestSetAtMs: 1_798_761_600_000 },
      JAN_2025_MS,
    );
    expect(result.earliestSetAtMs).toBe(JAN_2025_MS);
    expect(result.latestSetAtMs).toBe(1_798_761_600_000);
  });

  it('a null sample leaves the existing coverage unchanged', () => {
    const existing = { earliestSetAtMs: AUG_2026_MS, latestSetAtMs: AUG_2026_MS };
    expect(mergeDateCoverage(existing, null)).toEqual(existing);
  });

  it('mergeDateCoverageSpan widens both ends independently', () => {
    const existing = { earliestSetAtMs: AUG_2026_MS, latestSetAtMs: AUG_2026_MS };
    const result = mergeDateCoverageSpan(existing, {
      earliestSetAtMs: JAN_2025_MS,
      latestSetAtMs: 1_798_761_600_000,
    });
    expect(result.earliestSetAtMs).toBe(JAN_2025_MS);
    expect(result.latestSetAtMs).toBe(1_798_761_600_000);
  });

  it('mergeDateCoverageSpan with a null on either end leaves that end alone', () => {
    const existing = { earliestSetAtMs: AUG_2026_MS, latestSetAtMs: AUG_2026_MS };
    const result = mergeDateCoverageSpan(existing, { earliestSetAtMs: null, latestSetAtMs: null });
    expect(result).toEqual(existing);
  });

  it('mergeDateCoverageSpan adopts an incoming span verbatim with no existing coverage', () => {
    const result = mergeDateCoverageSpan(undefined, {
      earliestSetAtMs: JAN_2025_MS,
      latestSetAtMs: AUG_2026_MS,
    });
    expect(result).toEqual({ earliestSetAtMs: JAN_2025_MS, latestSetAtMs: AUG_2026_MS });
  });

  it('folding a two-set page through the per-sample widener matches folding the resulting span directly', () => {
    const viaPerSample = mergeDateCoverage(mergeDateCoverage(undefined, JAN_2025_MS), AUG_2026_MS);
    const viaSpan = mergeDateCoverageSpan(undefined, {
      earliestSetAtMs: JAN_2025_MS,
      latestSetAtMs: AUG_2026_MS,
    });
    expect(viaSpan).toEqual(viaPerSample);
  });
});

describe('foldPageReceipt', () => {
  const baseRun: ResearchIngestionRun = {
    status: 'running',
    mode: 'full',
    playerId: PLAYER_A,
    requestedByUid: UID,
    startedAtMs: 0,
  };

  it('with no pendingPageReceipt returns staged totals equal to stored totals plus the receipt counters (both bundles)', () => {
    const run: ResearchIngestionRun = { ...baseRun, stagedCounters: { imported: 3 } };
    const receipt = emptyReceipt({
      page: 1,
      counters: { imported: 2 },
      uniqueCounters: { imported: 1 },
    });
    const folded = foldPageReceipt(run, receipt);
    expect(folded.stagedCounters.imported).toBe(5);
    expect(folded.stagedUniqueCounters.imported).toBe(1);
  });

  it('on a same-page retry SUBTRACTS the pending receipt before adding the incoming one, over both bundles', () => {
    const pendingReceipt = emptyReceipt({
      page: 5,
      counters: { imported: 3 },
      uniqueCounters: { imported: 3 },
    });
    const run: ResearchIngestionRun = {
      ...baseRun,
      stagedCounters: { imported: 10 },
      stagedUniqueCounters: { imported: 10 },
      pendingPageReceipt: pendingReceipt,
    };
    const retryReceipt = emptyReceipt({
      page: 5,
      attempt: 1,
      counters: { imported: 2 },
      uniqueCounters: { imported: 2 },
    });

    const folded = foldPageReceipt(run, retryReceipt);
    // 10 (baseline before page 5) - 3 (undo attempt 1) + 2 (attempt 2) = 9
    expect(folded.stagedCounters.imported).toBe(9);
    expect(folded.stagedUniqueCounters.imported).toBe(9);
  });

  it('on a DIFFERENT pending page adds without subtracting', () => {
    const pendingReceipt = emptyReceipt({ page: 4, counters: { imported: 3 } });
    const run: ResearchIngestionRun = {
      ...baseRun,
      stagedCounters: { imported: 10 },
      pendingPageReceipt: pendingReceipt,
    };
    const nextReceipt = emptyReceipt({ page: 5, counters: { imported: 2 } });
    const folded = foldPageReceipt(run, nextReceipt);
    expect(folded.stagedCounters.imported).toBe(12);
  });

  it('floors every folded counter at zero in both bundles', () => {
    const run: ResearchIngestionRun = { ...baseRun, stagedCounters: { imported: 0 } };
    const receipt = emptyReceipt({ page: 1, counters: { imported: -50 } });
    const folded = foldPageReceipt(run, receipt);
    expect(folded.stagedCounters.imported).toBe(0);
  });

  it('widens the staged date coverage from the receipt SPAN and raises observedMaxUpdatedAtSeconds only when larger', () => {
    const run: ResearchIngestionRun = {
      ...baseRun,
      stagedDateCoverage: { earliestSetAtMs: 2_000, latestSetAtMs: 3_000 },
      observedMaxUpdatedAtSeconds: 100,
    };
    const receipt = emptyReceipt({
      page: 1,
      earliestSetAtMs: 1_000,
      latestSetAtMs: 5_000,
      observedMaxUpdatedAtSeconds: 50,
    });
    const folded = foldPageReceipt(run, receipt);
    expect(folded.stagedDateCoverage).toEqual({ earliestSetAtMs: 1_000, latestSetAtMs: 5_000 });
    // Both are monotone envelopes — a smaller observed high-water never lowers it.
    expect(folded.observedMaxUpdatedAtSeconds).toBe(100);
  });

  it('a receipt whose two span ends differ widens both ends of the staged coverage in one fold', () => {
    const run: ResearchIngestionRun = { ...baseRun };
    const receipt = emptyReceipt({ page: 1, earliestSetAtMs: 100, latestSetAtMs: 900 });
    const folded = foldPageReceipt(run, receipt);
    expect(folded.stagedDateCoverage).toEqual({ earliestSetAtMs: 100, latestSetAtMs: 900 });
  });
});

describe('deriveRefreshUpdatedAfterSeconds', () => {
  it('selects the most recent completed run for that player id and subtracts the overlap', () => {
    const state = {
      runs: {
        r1: {
          status: 'completed',
          mode: 'full',
          playerId: PLAYER_A,
          requestedByUid: UID,
          startedAtMs: 0,
          completedAtMs: 1_000,
          observedMaxUpdatedAtSeconds: 200_000,
        } as ResearchIngestionRun,
        r2: {
          status: 'completed',
          mode: 'full',
          playerId: PLAYER_A,
          requestedByUid: UID,
          startedAtMs: 0,
          completedAtMs: 2_000,
          observedMaxUpdatedAtSeconds: 300_000,
        } as ResearchIngestionRun,
      },
    };
    const result = deriveRefreshUpdatedAfterSeconds(state, PLAYER_A);
    expect(result).toBe(300_000 - 86_400);
  });

  it('ignores a completed run for a DIFFERENT player id in the same tenant', () => {
    const state = {
      runs: {
        r1: {
          status: 'completed',
          mode: 'full',
          playerId: PLAYER_B,
          requestedByUid: UID,
          startedAtMs: 0,
          completedAtMs: 5_000,
          observedMaxUpdatedAtSeconds: 999_999,
        } as ResearchIngestionRun,
      },
    };
    expect(deriveRefreshUpdatedAfterSeconds(state, PLAYER_A)).toBeNull();
  });

  it('returns null given no completed run, or one with no observed maximum', () => {
    expect(deriveRefreshUpdatedAfterSeconds({ runs: {} }, PLAYER_A)).toBeNull();
    const state = {
      runs: {
        r1: {
          status: 'completed',
          mode: 'full',
          playerId: PLAYER_A,
          requestedByUid: UID,
          startedAtMs: 0,
          completedAtMs: 1_000,
        } as ResearchIngestionRun,
      },
    };
    expect(deriveRefreshUpdatedAfterSeconds(state, PLAYER_A)).toBeNull();
  });
});

describe('stageBatchProgress', () => {
  it('advances the cursor and the counters in a single run-state write', async () => {
    const database = new FakeDatabase();
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A);

    let transactionCalls = 0;
    const originalRef = database.ref.bind(database);
    database.ref = ((path?: string) => {
      const ref = originalRef(path);
      const originalTransaction = ref.transaction.bind(ref);
      ref.transaction = (async (updateFn: (current: unknown) => unknown) => {
        transactionCalls += 1;
        return originalTransaction(updateFn);
      }) as typeof ref.transaction;
      return ref;
    }) as typeof database.ref;

    const result = await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({ page: 1, counters: { imported: 2 } }),
      cursor: { page: 2 },
      now: 1_500,
    });

    expect(result.outcome).toBe('applied');
    expect(result.run?.cursor).toEqual({ page: 2 });
    expect(result.run?.stagedCounters?.imported).toBe(2);
    expect(transactionCalls).toBe(1);
  });

  it('two calls for DIFFERENT pages produce the SUM of their receipts (both bundles)', async () => {
    const database = new FakeDatabase();
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A);

    await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({
        page: 1,
        counters: { imported: 2 },
        uniqueCounters: { imported: 2 },
      }),
      cursor: { page: 2 },
    });
    const second = await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({
        page: 2,
        counters: { imported: 3 },
        uniqueCounters: { imported: 3 },
      }),
      cursor: { page: 3 },
    });

    expect(second.run?.stagedCounters?.imported).toBe(5);
    expect(second.run?.stagedUniqueCounters?.imported).toBe(5);
  });

  it('two calls for the SAME page produce the SECOND receipt values, not the sum (both bundles)', async () => {
    const database = new FakeDatabase();
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A);

    await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({
        page: 5,
        counters: { imported: 4 },
        uniqueCounters: { imported: 4 },
      }),
      cursor: { page: 5, pageAttempt: 1 },
    });
    const retry = await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({
        page: 5,
        attempt: 1,
        counters: { imported: 2 },
        uniqueCounters: { imported: 2 },
      }),
      cursor: { page: 5, pageAttempt: 2 },
    });

    expect(retry.run?.stagedCounters?.imported).toBe(2);
    expect(retry.run?.stagedUniqueCounters?.imported).toBe(2);
  });

  it('staging an abandoned page receipt leaves the cursor on that page with pageAttempt incremented, replaced by the next attempt', async () => {
    const database = new FakeDatabase();
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A);

    const abandoned = await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({ page: 3, counters: { imported: 1 } }),
      cursor: { page: 3, pageAttempt: 1 },
    });
    expect(abandoned.run?.cursor).toEqual({ page: 3, pageAttempt: 1 });
    expect(abandoned.run?.stagedCounters?.imported).toBe(1);

    const retried = await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({ page: 3, attempt: 1, counters: { imported: 5 } }),
      cursor: { page: 4, pageAttempt: 0 },
    });
    expect(retried.run?.cursor).toEqual({ page: 4, pageAttempt: 0 });
    expect(retried.run?.stagedCounters?.imported).toBe(5);
  });
});

describe('publishCoverageSnapshot', () => {
  async function completeRunWithCounters(
    database: FakeDatabase,
    playerId: string,
    counters: { imported: number },
    now: number,
  ): Promise<{ runId: string; run: ResearchIngestionRun }> {
    const { runId, holder } = await createAcquiredRun(database, playerId, now);
    await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({
        page: 1,
        counters,
        uniqueCounters: counters,
      }),
      cursor: { page: 2 },
      now,
    });
    const completed = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      holder,
      now + 500,
    );
    return { runId, run: completed.run! };
  }

  it('writes a player section carrying the run id, completedAtMs as both stamps, and the staged counters', async () => {
    const database = new FakeDatabase();
    const { runId, run } = await completeRunWithCounters(
      database,
      PLAYER_A,
      { imported: 4 },
      1_000,
    );

    const result = await publishCoverageSnapshot(asDatabase(database), TENANT_ID, runId, run);
    expect(result.published).toBe(true);
    const section = result.snapshot.players[PLAYER_A]!;
    expect(section.runId).toBe(runId);
    expect(section.runCompletedAtMs).toBe(run.completedAtMs);
    expect(section.asOfMs).toBe(run.completedAtMs);
    expect(section.counters.imported).toBe(4);
  });

  it('publishing player B leaves player A byte-identical and adds B (review C2-H3)', async () => {
    const database = new FakeDatabase();
    const a = await completeRunWithCounters(database, PLAYER_A, { imported: 4 }, 1_000);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, a.runId, a.run);
    const before = JSON.parse(JSON.stringify(database.dump().researchCoverage));

    const b = await completeRunWithCounters(database, PLAYER_B, { imported: 7 }, 2_000);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, b.runId, b.run);

    const dump = database.dump().researchCoverage as {
      [tenant: string]: { players: Record<string, unknown> };
    };
    expect(dump[TENANT_ID]!.players[PLAYER_A]).toEqual(
      (before as { [tenant: string]: { players: Record<string, unknown> } })[TENANT_ID]!.players[
        PLAYER_A
      ],
    );
    expect(dump[TENANT_ID]!.players[PLAYER_B]).toBeDefined();
  });

  it('after publishing two non-overlapping players, totals sum element-wise and asOfMs is the larger', async () => {
    const database = new FakeDatabase();
    const a = await completeRunWithCounters(database, PLAYER_A, { imported: 4 }, 1_000);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, a.runId, a.run);
    const b = await completeRunWithCounters(database, PLAYER_B, { imported: 7 }, 5_000);
    const result = await publishCoverageSnapshot(asDatabase(database), TENANT_ID, b.runId, b.run);

    expect(result.snapshot.totals.counters.imported).toBe(11);
    expect(result.snapshot.asOfMs).toBe(b.run.completedAtMs);
  });

  it('THE CROSS-ID OVERLAP CASE: a shared provider set counts once in totals though both sections observe it (review C3-A5)', async () => {
    const database = new FakeDatabase();
    const a = await createAcquiredRun(database, PLAYER_A, 1_000);
    await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: a.runId,
      holder: a.holder,
      receipt: emptyReceipt({
        page: 1,
        counters: { imported: 1 },
        uniqueCounters: { imported: 1 },
      }),
      cursor: { page: 2 },
      now: 1_000,
    });
    const aCompleted = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      a.runId,
      a.holder,
      1_500,
    );
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, a.runId, aCompleted.run!);

    // Player B observes the SAME set (counted in its observation bundle)
    // but does not OWN it (firstIngestionPlayerId is A), so B's unique
    // bundle excludes it.
    const b = await createAcquiredRun(database, PLAYER_B, 2_000);
    await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId: b.runId,
      holder: b.holder,
      receipt: emptyReceipt({
        page: 1,
        counters: { imported: 1 }, // observed the shared set
        uniqueCounters: { imported: 0 }, // does not own it
      }),
      cursor: { page: 2 },
      now: 2_000,
    });
    const bCompleted = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      b.runId,
      b.holder,
      2_500,
    );
    const result = await publishCoverageSnapshot(
      asDatabase(database),
      TENANT_ID,
      b.runId,
      bCompleted.run!,
    );

    expect(result.snapshot.players[PLAYER_A]!.counters.imported).toBe(1);
    expect(result.snapshot.players[PLAYER_B]!.counters.imported).toBe(1);
    // totals counts the shared set ONCE via the unique bundles (1 + 0), not
    // twice via the observation bundles (1 + 1).
    expect(result.snapshot.totals.counters.imported).toBe(1);
    const observationSum =
      result.snapshot.players[PLAYER_A]!.counters.imported! +
      result.snapshot.players[PLAYER_B]!.counters.imported!;
    expect(result.snapshot.totals.counters.imported).not.toBe(observationSum);
  });

  it('publishes a fully-zeroed classification map when the run staged none', async () => {
    const database = new FakeDatabase();
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A, 1_000);
    const completed = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      holder,
      1_500,
    );
    const result = await publishCoverageSnapshot(
      asDatabase(database),
      TENANT_ID,
      runId,
      completed.run!,
    );
    expect(result.snapshot.players[PLAYER_A]!.classificationCounts).toEqual({
      complete: 0,
      dq: 0,
      bye: 0,
      walkover: 0,
      'no-game': 0,
      'no-game-detail': 0,
      'non-singles': 0,
      'non-ssbu': 0,
      unresolved: 0,
    });
  });

  it('republishing the same completed run twice yields an identical node (byte-idempotent, no now parameter)', async () => {
    const database = new FakeDatabase();
    const { runId, run } = await completeRunWithCounters(
      database,
      PLAYER_A,
      { imported: 4 },
      1_000,
    );

    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, runId, run);
    const first = JSON.parse(JSON.stringify(database.dump().researchCoverage));
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, runId, run);
    const second = JSON.parse(JSON.stringify(database.dump().researchCoverage));
    expect(second).toEqual(first);
  });

  it('THE STALE-RECOVERY CASE: republishing an older completed run reports superseded and leaves the node unchanged (review C2-H4)', async () => {
    const database = new FakeDatabase();
    const a = await completeRunWithCounters(database, PLAYER_A, { imported: 1 }, 1_000);
    const b = await completeRunWithCounters(database, PLAYER_A, { imported: 2 }, 2_000);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, a.runId, a.run);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, b.runId, b.run);

    const before = JSON.parse(JSON.stringify(database.dump().researchCoverage));
    const result = await publishCoverageSnapshot(asDatabase(database), TENANT_ID, a.runId, a.run);

    expect(result.published).toBe(false);
    expect(result.reason).toBe('superseded');
    expect(result.snapshot.players[PLAYER_A]!.runId).toBe(b.runId);
    expect(database.dump().researchCoverage).toEqual(before);
  });

  it('an older run for player P leaves player Q untouched too', async () => {
    const database = new FakeDatabase();
    const q = await completeRunWithCounters(database, PLAYER_B, { imported: 9 }, 500);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, q.runId, q.run);

    const p1 = await completeRunWithCounters(database, PLAYER_A, { imported: 1 }, 1_000);
    const p2 = await completeRunWithCounters(database, PLAYER_A, { imported: 2 }, 2_000);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, p1.runId, p1.run);
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, p2.runId, p2.run);

    const beforeQ = JSON.parse(
      JSON.stringify((database.dump().researchCoverage as Record<string, unknown>)[TENANT_ID]),
    );
    await publishCoverageSnapshot(asDatabase(database), TENANT_ID, p1.runId, p1.run);
    const afterQ = (database.dump().researchCoverage as Record<string, { players: unknown }>)[
      TENANT_ID
    ]! as { players: Record<string, unknown> };
    expect(afterQ.players[PLAYER_B]).toEqual(
      (beforeQ as { players: Record<string, unknown> }).players[PLAYER_B],
    );
  });

  it('throws for a running run and leaves the coverage node unchanged', async () => {
    const database = new FakeDatabase();
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A);
    const run = {
      status: 'running' as const,
      mode: 'full' as const,
      playerId: PLAYER_A,
      requestedByUid: UID,
      startedAtMs: 0,
    };
    void holder;
    const before = database.dump().researchCoverage;
    await expect(
      publishCoverageSnapshot(asDatabase(database), TENANT_ID, runId, run),
    ).rejects.toThrow();
    expect(database.dump().researchCoverage).toEqual(before);
  });

  it('throws for a failed run and leaves the coverage node unchanged', async () => {
    const database = new FakeDatabase();
    const run = {
      status: 'failed' as const,
      mode: 'full' as const,
      playerId: PLAYER_A,
      requestedByUid: UID,
      startedAtMs: 0,
      failedAtMs: 500,
      reason: 'boom',
    };
    const before = database.dump().researchCoverage;
    await expect(
      publishCoverageSnapshot(asDatabase(database), TENANT_ID, 'run-x', run),
    ).rejects.toThrow();
    expect(database.dump().researchCoverage).toEqual(before);
  });

  it('throws for a completed run with no completedAtMs', async () => {
    const database = new FakeDatabase();
    const run = {
      status: 'completed' as const,
      mode: 'full' as const,
      playerId: PLAYER_A,
      requestedByUid: UID,
      startedAtMs: 0,
    };
    await expect(
      publishCoverageSnapshot(asDatabase(database), TENANT_ID, 'run-x', run),
    ).rejects.toThrow();
  });

  it('asserts a 2026-era millisecond value round-trips through mergeDateCoverage and out of the published section unchanged', async () => {
    const database = new FakeDatabase();
    const millisValue = 1_767_225_600_000;
    const { runId, holder } = await createAcquiredRun(database, PLAYER_A, 1_000);
    await stageBatchProgress(asDatabase(database), {
      tenantId: TENANT_ID,
      runId,
      holder,
      receipt: emptyReceipt({ page: 1, earliestSetAtMs: millisValue, latestSetAtMs: millisValue }),
      cursor: { page: 2 },
      now: 1_000,
    });
    const completed = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      holder,
      1_500,
    );
    const result = await publishCoverageSnapshot(
      asDatabase(database),
      TENANT_ID,
      runId,
      completed.run!,
    );
    expect(result.snapshot.players[PLAYER_A]!.dateCoverage.earliestSetAtMs).toBe(millisValue);
  });
});

describe('readCoverageSnapshot / buildCoverageResponse', () => {
  it('a never-completed tenant reads a null snapshot rather than a zeroed one', async () => {
    const database = new FakeDatabase();
    const result = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(result).toBeNull();
  });

  it('a malformed stored snapshot reads as null rather than throwing', async () => {
    const database = new FakeDatabase();
    database.seed(`researchCoverage/${TENANT_ID}`, { garbage: true });
    const result = await readCoverageSnapshot(asDatabase(database), TENANT_ID);
    expect(result).toBeNull();
  });

  it('buildCoverageResponse lists a confirmed player id with no section as not-yet-backfilled, and reports a null snapshot alongside a live active run', () => {
    const activeRun = {
      runId: 'run-x',
      run: {
        status: 'running' as const,
        mode: 'full' as const,
        playerId: PLAYER_A,
        requestedByUid: UID,
        startedAtMs: 1_000,
        cursor: { page: 3, totalPages: 10 },
      },
    };
    const response = buildCoverageResponse({
      coverage: null,
      confirmedPlayerIds: [PLAYER_A, PLAYER_B],
      unresolvedCandidateCount: 2,
      activeRun,
    });
    expect(response.coverage).toBeNull();
    expect(response.confirmedPlayerIds).toEqual([PLAYER_A, PLAYER_B]);
    expect(response.confirmedPlayerIdCount).toBe(2);
    expect(response.activeRun?.playerId).toBe(PLAYER_A);
    expect(response.activeRun?.cursorPage).toBe(3);
  });
});
