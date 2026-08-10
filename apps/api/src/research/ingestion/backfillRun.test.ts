import type { Database } from 'firebase-admin/database';
import { normalizeResearchClassificationCounts } from '@smash-tracker/shared';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { ConflictingTransactionDatabase } from '../../test-support/conflictingTransactionDatabase.js';
import {
  acquireRunLease,
  advanceRunState,
  completeBackfillRun,
  createOrResumeBackfillRun,
  failBackfillRun,
  markCoveragePublished,
  readActiveBackfillRun,
  readBackfillRun,
  readTenantIngestionState,
  releaseRunLease,
  renewRunLease,
  type RunLeaseHolder,
} from './backfillRun.js';

function asDatabase(database: FakeDatabase | ConflictingTransactionDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-1';
const PLAYER_ID = '1802316';
const OTHER_PLAYER_ID = '999999';
const UID = 'admin-1';

async function createRunningRun(
  database: FakeDatabase,
  overrides: Partial<{ playerId: string; mode: 'full' | 'refresh'; now: number }> = {},
) {
  return createOrResumeBackfillRun(asDatabase(database), {
    tenantId: TENANT_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    requestedByUid: UID,
    mode: overrides.mode ?? 'full',
    now: overrides.now ?? 1_000,
  });
}

describe('createOrResumeBackfillRun', () => {
  it('creates a run with status running, cursor page 1, and outcome created', async () => {
    const database = new FakeDatabase();
    const result = await createRunningRun(database);
    expect(result.outcome).toBe('created');
    expect(result.resumed).toBe(false);
    expect(result.status).toBe('running');
    expect(result.runId).toBeTruthy();

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, result.runId!);
    expect(run?.status).toBe('running');
    expect(run?.cursor).toEqual({ page: 1 });
    expect(run?.playerId).toBe(PLAYER_ID);
  });

  it('resumes the same run id for the same player and mode while running', async () => {
    const database = new FakeDatabase();
    const first = await createRunningRun(database);

    const second = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: PLAYER_ID,
      requestedByUid: UID,
      mode: 'full',
      now: 2_000,
    });

    expect(second.outcome).toBe('resumed');
    expect(second.resumed).toBe(true);
    expect(second.runId).toBe(first.runId);

    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(Object.keys(state.runs)).toHaveLength(1);
  });

  it('refuses a different confirmed player id with outcome busy, creating no run', async () => {
    const database = new FakeDatabase();
    const first = await createRunningRun(database, { playerId: PLAYER_ID });

    const busy = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: OTHER_PLAYER_ID,
      requestedByUid: UID,
      mode: 'full',
      now: 2_000,
    });

    expect(busy.outcome).toBe('busy');
    expect(busy.runId).toBe(first.runId);
    expect(busy.activePlayerId).toBe(PLAYER_ID);

    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(Object.keys(state.runs)).toHaveLength(1);
  });

  it('refuses a different mode on the same player id with outcome busy', async () => {
    const database = new FakeDatabase();
    await createRunningRun(database, { playerId: PLAYER_ID, mode: 'full' });

    const busy = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: PLAYER_ID,
      requestedByUid: UID,
      mode: 'refresh',
      now: 2_000,
    });

    expect(busy.outcome).toBe('busy');
    expect(busy.activeMode).toBe('full');
  });

  it('leaves the stored state byte-unchanged on a busy refusal', async () => {
    const database = new FakeDatabase();
    await createRunningRun(database, { playerId: PLAYER_ID });
    const before = JSON.parse(JSON.stringify(database.dump()));

    await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: OTHER_PLAYER_ID,
      requestedByUid: UID,
      mode: 'full',
      now: 2_000,
    });

    expect(database.dump()).toEqual(before);
  });

  it('creates a NEW run with a new id after the first run completed', async () => {
    const database = new FakeDatabase();
    const first = await createRunningRun(database);
    const holderA = await acquireRunLease(asDatabase(database), TENANT_ID, first.runId!, 'owner-a');
    await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      first.runId!,
      holderA.holder!,
      3_000,
    );

    const second = await createRunningRun(database, { now: 4_000 });
    expect(second.outcome).toBe('created');
    expect(second.runId).not.toBe(first.runId);
  });

  it('records the supplied high-water timestamp on a refresh-mode run cursor', async () => {
    const database = new FakeDatabase();
    const result = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: TENANT_ID,
      playerId: PLAYER_ID,
      requestedByUid: UID,
      mode: 'refresh',
      updatedAfterSeconds: 12_345,
      now: 1_000,
    });
    const run = await readBackfillRun(asDatabase(database), TENANT_ID, result.runId!);
    expect(run?.cursor?.updatedAfterSeconds).toBe(12_345);
  });

  it('fails closed on malformed stored state without replacing or deleting it', async () => {
    const database = new FakeDatabase();
    database.seed(`researchIngestionRuns/${TENANT_ID}`, { activeRunId: 42, runs: 'not-a-map' });
    const before = JSON.parse(JSON.stringify(database.dump()));

    await expect(createRunningRun(database)).rejects.toThrow();
    expect(database.dump()).toEqual(before);
  });

  it('resolves a concurrent create to a single run id reported identically by both callers (ConflictingTransactionDatabase)', async () => {
    const database = new FakeDatabase();
    let winnerRunId: string | null = null;

    const conflictDb = new ConflictingTransactionDatabase(database, {
      path: `researchIngestionRuns/${TENANT_ID}`,
      competingWrite: async () => {
        const winner = await createOrResumeBackfillRun(asDatabase(database), {
          tenantId: TENANT_ID,
          playerId: PLAYER_ID,
          requestedByUid: UID,
          mode: 'full',
          now: 500,
        });
        winnerRunId = winner.runId;
      },
    });

    const loser = await createOrResumeBackfillRun(asDatabase(conflictDb), {
      tenantId: TENANT_ID,
      playerId: PLAYER_ID,
      requestedByUid: UID,
      mode: 'full',
      now: 1_000,
    });

    expect(winnerRunId).toBeTruthy();
    expect(loser.runId).toBe(winnerRunId);

    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(Object.keys(state.runs)).toHaveLength(1);
  });
});

describe('advanceRunState', () => {
  it('rejects a schema-invalid next state before commit and preserves the valid stored run', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
    );
    const before = JSON.parse(JSON.stringify(database.dump()));

    await expect(
      advanceRunState(
        asDatabase(database),
        TENANT_ID,
        created.runId!,
        acquired.holder!,
        { cursor: { page: 0 } },
        5_000,
      ),
    ).rejects.toThrow();

    expect(database.dump()).toEqual(before);
  });

  it('leaves every other run member intact when writing a new cursor page', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
    );

    const result = await advanceRunState(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      acquired.holder!,
      { cursor: { page: 4 } },
      5_000,
    );

    expect(result.outcome).toBe('applied');
    expect(result.run?.cursor).toEqual({ page: 4 });
    expect(result.run?.status).toBe('running');
    expect(result.run?.playerId).toBe(PLAYER_ID);
    expect(result.run?.mode).toBe('full');
    expect(result.run?.lease?.ownerId).toBe('owner-a');
    expect(result.run?.leaseFenceCounter).toBe(1);
  });

  it('is a no-op returning the absent outcome for a run id that does not exist', async () => {
    const database = new FakeDatabase();
    const holder: RunLeaseHolder = { ownerId: 'owner-a', fence: 1 };
    const result = await advanceRunState(asDatabase(database), TENANT_ID, 'no-such-run', holder, {
      cursor: { page: 2 },
    });
    expect(result.outcome).toBe('absent');
    expect(result.run).toBeNull();
  });

  it('is a no-op on a run whose status is already terminal', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
    );
    await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      acquired.holder!,
      2_000,
    );

    const result = await advanceRunState(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      acquired.holder!,
      { cursor: { page: 2 } },
    );
    expect(result.outcome).toBe('terminal');
  });
});

describe('acquireRunLease / renewRunLease / releaseRunLease', () => {
  it('repairs only RTDB-stripped classification maps on a pending receipt and persists the healed shape', async () => {
    const database = new FakeDatabase();
    const runId = 'run-with-stripped-classifications';
    database.seed(`researchIngestionRuns/${TENANT_ID}`, {
      activeRunId: runId,
      runs: {
        [runId]: {
          status: 'running',
          mode: 'full',
          playerId: PLAYER_ID,
          requestedByUid: UID,
          startedAtMs: 1_000,
          cursor: { page: 112 },
          pendingPageReceipt: {
            page: 111,
            attempt: 0,
            stagedAtMs: 2_000,
            counters: { providerUnavailablePages: 1, providerUnavailableRowEstimate: 15 },
            namedGaps: {},
            uniqueCounters: { providerUnavailablePages: 1, providerUnavailableRowEstimate: 15 },
            uniqueNamedGaps: {},
          },
        },
      },
    });

    const expectedZeros = normalizeResearchClassificationCounts(undefined);
    const read = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(read?.pendingPageReceipt?.classificationCounts).toEqual(expectedZeros);
    expect(read?.pendingPageReceipt?.uniqueClassificationCounts).toEqual(expectedZeros);

    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      3_000,
    );
    expect(acquired.acquired).toBe(true);

    const rawRun = (
      database.dump() as unknown as {
        researchIngestionRuns: {
          [TENANT_ID]: { runs: Record<string, { pendingPageReceipt: Record<string, unknown> }> };
        };
      }
    ).researchIngestionRuns[TENANT_ID].runs[runId]!;
    expect(rawRun.pendingPageReceipt.classificationCounts).toEqual(expectedZeros);
    expect(rawRun.pendingPageReceipt.uniqueClassificationCounts).toEqual(expectedZeros);
  });

  it('keeps every other required pending-receipt member strict during compatibility repair', async () => {
    const database = new FakeDatabase();
    const runId = 'run-missing-required-receipt-member';
    const zeros = normalizeResearchClassificationCounts(undefined);
    database.seed(`researchIngestionRuns/${TENANT_ID}`, {
      activeRunId: runId,
      runs: {
        [runId]: {
          status: 'running',
          mode: 'full',
          playerId: PLAYER_ID,
          requestedByUid: UID,
          startedAtMs: 1_000,
          pendingPageReceipt: {
            page: 111,
            attempt: 0,
            stagedAtMs: 2_000,
            namedGaps: {},
            classificationCounts: zeros,
            uniqueCounters: {},
            uniqueNamedGaps: {},
            uniqueClassificationCounts: zeros,
          },
        },
      },
    });
    const before = JSON.parse(JSON.stringify(database.dump()));

    await expect(readBackfillRun(asDatabase(database), TENANT_ID, runId)).rejects.toThrow(
      /counters/,
    );
    expect(database.dump()).toEqual(before);
  });

  it('does not erase a schema-invalid run when lease release parses the stored state', async () => {
    const database = new FakeDatabase();
    const runId = 'run-with-invalid-cursor';
    database.seed(`researchIngestionRuns/${TENANT_ID}`, {
      activeRunId: runId,
      runs: {
        [runId]: {
          status: 'running',
          mode: 'full',
          playerId: PLAYER_ID,
          requestedByUid: UID,
          startedAtMs: 1_000,
          cursor: { page: 0 },
          lease: { ownerId: 'owner-a', acquiredAtMs: 1_000, expiresAtMs: 2_000, fence: 1 },
          leaseFenceCounter: 1,
        },
      },
    });
    const before = JSON.parse(JSON.stringify(database.dump()));

    await expect(
      releaseRunLease(asDatabase(database), TENANT_ID, runId, { ownerId: 'owner-a', fence: 1 }),
    ).rejects.toThrow();

    expect(database.dump()).toEqual(before);
  });

  it('grants a lease with no prior lease, stores fence 1, and an expiry derived from now + TTL', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);

    const result = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
      50_000,
    );

    expect(result.acquired).toBe(true);
    expect(result.holder).toEqual({ ownerId: 'owner-a', fence: 1 });
    expect(result.expiresAtMs).toBe(51_000);

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, created.runId!);
    expect(run?.leaseFenceCounter).toBe(1);
    expect(run?.lease?.ownerId).toBe('owner-a');
  });

  it('fails a second owner while the first lease is live and unexpired, leaving fence untouched', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
      50_000,
    );

    const secondAttempt = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-b',
      2_000,
      50_000,
    );

    expect(secondAttempt.acquired).toBe(false);
    expect(secondAttempt.heldBy).toBe('owner-a');

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, created.runId!);
    expect(run?.leaseFenceCounter).toBe(1);
    expect(run?.lease?.ownerId).toBe('owner-a');
  });

  it('succeeds a second owner after the stored expiry has passed', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
      10_000,
    );

    const afterExpiry = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-b',
      20_000,
      10_000,
    );

    expect(afterExpiry.acquired).toBe(true);
    expect(afterExpiry.holder?.fence).toBe(2);
  });

  it('issues a new higher fence on a same-owner re-acquisition and increments leaseFenceCounter', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const first = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
      50_000,
    );
    const second = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      2_000,
      50_000,
    );

    expect(first.holder?.fence).toBe(1);
    expect(second.holder?.fence).toBe(2);

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, created.runId!);
    expect(run?.leaseFenceCounter).toBe(2);
  });

  it('proves the ABA sequence: a released-then-reissued fence never revalidates a stale holder (review C2-H1)', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;

    // A acquires (fence 1), then stalls past the TTL.
    const a = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
      5_000,
    );
    expect(a.holder?.fence).toBe(1);

    // B expires A and takes fence 2.
    const b = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-b',
      10_000,
      5_000,
    );
    expect(b.holder?.fence).toBe(2);

    // B releases.
    await releaseRunLease(asDatabase(database), TENANT_ID, runId, b.holder!);

    // C acquires — must receive fence 3, never fence 1.
    const c = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-c',
      11_000,
      5_000,
    );
    expect(c.holder?.fence).toBe(3);

    // Stale A attempts to advance with fence 1 — rejected, byte-unchanged.
    const before = JSON.parse(JSON.stringify(database.dump()));
    const staleWrite = await advanceRunState(
      asDatabase(database),
      TENANT_ID,
      runId,
      a.holder!,
      { cursor: { page: 2 } },
      12_000,
    );
    expect(staleWrite.outcome).toBe('lease-lost');
    expect(database.dump()).toEqual(before);
  });

  it('removes the lease member entirely on release while leaving leaseFenceCounter at its last-issued value', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
    );

    await releaseRunLease(asDatabase(database), TENANT_ID, created.runId!, acquired.holder!);

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, created.runId!);
    expect(run?.lease).toBeUndefined();
    expect(run?.leaseFenceCounter).toBe(1);
  });

  it('renews with a matching owner and fence, extending expiry and keeping the fence', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
      10_000,
    );

    const renewed = await renewRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      acquired.holder!,
      5_000,
      10_000,
    );
    expect(renewed).toBe(true);

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, created.runId!);
    expect(run?.lease?.fence).toBe(1);
    expect(run?.lease?.expiresAtMs).toBe(15_000);
  });

  it('refuses renewal with a matching owner but a stale fence, or a matching fence but a different owner', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
      10_000,
    );

    const staleFence = await renewRunLease(asDatabase(database), TENANT_ID, created.runId!, {
      ownerId: 'owner-a',
      fence: 999,
    });
    expect(staleFence).toBe(false);

    const wrongOwner = await renewRunLease(asDatabase(database), TENANT_ID, created.runId!, {
      ownerId: 'owner-b',
      fence: acquired.holder!.fence,
    });
    expect(wrongOwner).toBe(false);
  });

  it('under ConflictingTransactionDatabase, exactly one of two concurrent lease acquisitions succeeds and leaseFenceCounter advances exactly once', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;

    let competingResult: Awaited<ReturnType<typeof acquireRunLease>> | null = null;
    const conflictDb = new ConflictingTransactionDatabase(database, {
      path: `researchIngestionRuns/${TENANT_ID}`,
      competingWrite: async () => {
        competingResult = await acquireRunLease(
          asDatabase(database),
          TENANT_ID,
          runId,
          'owner-a',
          1_000,
        );
      },
    });

    const loserResult = await acquireRunLease(
      asDatabase(conflictDb),
      TENANT_ID,
      runId,
      'owner-b',
      1_500,
    );

    const successes = [competingResult!.acquired, loserResult.acquired].filter(Boolean);
    expect(successes).toHaveLength(1);

    const run = await readBackfillRun(asDatabase(database), TENANT_ID, runId);
    expect(run?.leaseFenceCounter).toBe(1);
  });
});

describe('lease-fenced mutators', () => {
  it('return lease-lost for a stale fence, a higher-than-stored fence, a wrong owner, and a missing lease — byte-unchanged', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );

    // Missing lease case needs a fresh run with no lease acquired.
    const secondCreated = await createOrResumeBackfillRun(asDatabase(database), {
      tenantId: 'tenant-2',
      playerId: PLAYER_ID,
      requestedByUid: UID,
      mode: 'full',
      now: 1_000,
    });

    const cases: [string, RunLeaseHolder, string, string][] = [
      ['lower fence', { ownerId: 'owner-a', fence: 0 }, TENANT_ID, runId],
      ['higher fence', { ownerId: 'owner-a', fence: 99 }, TENANT_ID, runId],
      ['wrong owner', { ownerId: 'owner-x', fence: acquired.holder!.fence }, TENANT_ID, runId],
      ['missing lease', { ownerId: 'owner-a', fence: 1 }, 'tenant-2', secondCreated.runId!],
    ];

    for (const [, holder, tenantId, targetRunId] of cases) {
      const before = JSON.parse(JSON.stringify(database.dump()));
      const result = await advanceRunState(asDatabase(database), tenantId, targetRunId, holder, {
        cursor: { page: 2 },
      });
      expect(result.outcome).toBe('lease-lost');
      expect(database.dump()).toEqual(before);
    }
  });

  it('checks owner and fence together for completeBackfillRun and failBackfillRun too', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      'owner-a',
      1_000,
    );

    const wrongOwnerComplete = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      {
        ownerId: 'owner-x',
        fence: acquired.holder!.fence,
      },
    );
    expect(wrongOwnerComplete.outcome).toBe('lease-lost');

    const wrongFenceFail = await failBackfillRun(
      asDatabase(database),
      TENANT_ID,
      created.runId!,
      { ownerId: 'owner-a', fence: 999 },
      'boom',
    );
    expect(wrongFenceFail.outcome).toBe('lease-lost');
  });

  it('THE FAIL-BEFORE-LEASE WEDGE: a fabricated holder against an unleased running run changes nothing (review C3-H1)', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;

    const result = await failBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      { ownerId: 'fabricated', fence: 1 },
      'fabricated failure',
    );
    expect(result.outcome).toBe('lease-lost');

    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBe(runId);
    expect(state.runs[runId]?.status).toBe('running');
  });

  it('THE LEASED STARTUP FAILURE: acquire immediately followed by fail COMMITS and frees the tenant (review C3-H1)', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;

    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    const failResult = await failBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      acquired.holder!,
      'startup validation failed',
      2_000,
    );

    expect(failResult.outcome).toBe('applied');
    expect(failResult.run?.status).toBe('failed');
    expect(failResult.run?.reason).toBe('startup validation failed');
    expect(failResult.run?.lease).toBeUndefined();
    expect(failResult.run?.leaseFenceCounter).toBe(1);

    const state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(state.activeRunId).toBeNull();

    const nextTrigger = await createRunningRun(database, { now: 3_000 });
    expect(nextTrigger.outcome).toBe('created');
  });
});

describe('completeBackfillRun / markCoveragePublished / failBackfillRun', () => {
  it('completes a run, releases the lease, preserves staged data, and clears the active-run pointer', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );

    await advanceRunState(
      asDatabase(database),
      TENANT_ID,
      runId,
      acquired.holder!,
      { cursor: { page: 3 } },
      1_500,
    );

    const result = await completeBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      acquired.holder!,
      2_000,
    );

    expect(result.outcome).toBe('applied');
    expect(result.run?.status).toBe('completed');
    expect(result.run?.completedAtMs).toBe(2_000);
    expect(result.run?.cursor).toEqual({ page: 3 });
    expect(result.run?.lease).toBeUndefined();
    expect(result.run?.leaseFenceCounter).toBe(1);
    expect(result.run?.coveragePublishedAtMs).toBeUndefined();

    const active = await readActiveBackfillRun(asDatabase(database), TENANT_ID);
    expect(active).toBeNull();
  });

  it('markCoveragePublished sets coveragePublishedAtMs idempotently and no-ops on a running run', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );

    const runningNoOp = await markCoveragePublished(asDatabase(database), TENANT_ID, runId, 5_000);
    expect(runningNoOp).toBeNull();

    await completeBackfillRun(asDatabase(database), TENANT_ID, runId, acquired.holder!, 2_000);

    const first = await markCoveragePublished(asDatabase(database), TENANT_ID, runId, 5_000);
    expect(first?.coveragePublishedAtMs).toBe(5_000);

    const second = await markCoveragePublished(asDatabase(database), TENANT_ID, runId, 5_000);
    expect(second?.coveragePublishedAtMs).toBe(5_000);
  });

  it('failBackfillRun sets status failed with reason, preserves the cursor, releases the lease, clears activeRunId', async () => {
    const database = new FakeDatabase();
    const created = await createRunningRun(database);
    const runId = created.runId!;
    const acquired = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    await advanceRunState(
      asDatabase(database),
      TENANT_ID,
      runId,
      acquired.holder!,
      { cursor: { page: 2 } },
      1_500,
    );

    const result = await failBackfillRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      acquired.holder!,
      'startgg rejected',
      2_000,
    );

    expect(result.outcome).toBe('applied');
    expect(result.run?.status).toBe('failed');
    expect(result.run?.reason).toBe('startgg rejected');
    expect(result.run?.cursor).toEqual({ page: 2 });
    expect(result.run?.lease).toBeUndefined();

    const active = await readActiveBackfillRun(asDatabase(database), TENANT_ID);
    expect(active).toBeNull();
  });

  it('reads lease-absent with leaseFenceCounter preserved after release', async () => {
    const database = new FakeDatabase();

    const runA = await createRunningRun(database, { playerId: '1' });
    const acquiredA = await acquireRunLease(
      asDatabase(database),
      TENANT_ID,
      runA.runId!,
      'owner-a',
      1_000,
    );
    await releaseRunLease(asDatabase(database), TENANT_ID, runA.runId!, acquiredA.holder!);
    const afterRelease = await readBackfillRun(asDatabase(database), TENANT_ID, runA.runId!);
    expect(afterRelease?.lease).toBeUndefined();
    expect(afterRelease?.leaseFenceCounter).toBe(1);
  });
});

describe('run history pruning', () => {
  it('prunes the oldest terminal run on the eleventh run, leaving exactly ten, never pruning the active run', async () => {
    const database = new FakeDatabase();

    for (let i = 0; i < 10; i += 1) {
      const created = await createRunningRun(database, { now: 1_000 + i });
      const acquired = await acquireRunLease(
        asDatabase(database),
        TENANT_ID,
        created.runId!,
        `owner-${i}`,
        1_000 + i,
      );
      await completeBackfillRun(
        asDatabase(database),
        TENANT_ID,
        created.runId!,
        acquired.holder!,
        2_000 + i,
      );
    }

    let state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(Object.keys(state.runs)).toHaveLength(10);

    const eleventh = await createRunningRun(database, { now: 5_000 });
    state = await readTenantIngestionState(asDatabase(database), TENANT_ID);
    expect(Object.keys(state.runs)).toHaveLength(10);
    expect(state.runs[eleventh.runId!]).toBeDefined();
    expect(state.activeRunId).toBe(eleventh.runId);
  });
});
