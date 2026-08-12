import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  ENRICHMENT_LEASE_TTL_MS,
  acquireEnrichmentRunLease,
  advanceEnrichmentRunState,
  completeEnrichmentRun,
  createOrResumeEnrichmentRun,
  failEnrichmentRun,
  markEnrichmentCoveragePublished,
  readActiveEnrichmentRun,
  readEnrichmentRun,
  releaseEnrichmentRunLease,
  renewEnrichmentRunLease,
  type EnrichmentRunLeaseHolder,
} from './runState.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-enr-1';

async function createRunning(database: FakeDatabase, now = 1_000) {
  return createOrResumeEnrichmentRun(asDatabase(database), TENANT_ID, now);
}

describe('runState (enrichment)', () => {
  it('creating a run when none is active returns a new run; calling again returns the SAME run', async () => {
    const database = new FakeDatabase();
    const first = await createRunning(database, 1_000);
    expect(first.resumed).toBe(false);

    const second = await createRunning(database, 2_000);
    expect(second.resumed).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  it('acquiring a lease increments the fence sequence stored on the run and copies the new value onto the lease', async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);

    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    expect(acquired.acquired).toBe(true);
    expect(acquired.holder?.fence).toBe(1);

    const run = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(run?.leaseFenceCounter).toBe(1);
    expect(run?.lease?.fence).toBe(1);
  });

  it("a second holder acquiring after the first lease expires receives a strictly higher fence; the first holder's subsequent advance is refused", async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);

    const first = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
      1_000,
    );
    expect(first.acquired).toBe(true);
    const firstHolder = first.holder as EnrichmentRunLeaseHolder;

    // Owner A's lease expires at 2_000; owner B acquires at 3_000.
    const second = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-b',
      3_000,
      1_000,
    );
    expect(second.acquired).toBe(true);
    expect(second.holder?.fence).toBeGreaterThan(firstHolder.fence);

    const staleAdvance = await advanceEnrichmentRunState(
      asDatabase(database),
      TENANT_ID,
      runId,
      firstHolder,
      { cursor: { stage: 'discovery', pageTitle: 'StaleWrite' } },
    );
    expect(staleAdvance.outcome).toBe('lease-lost');
  });

  it('releasing a lease does not decrement, reset or remove the fence sequence, so a released-then-reacquired lease cannot revalidate a stale holder', async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);

    const first = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    const firstHolder = first.holder as EnrichmentRunLeaseHolder;
    await releaseEnrichmentRunLease(asDatabase(database), TENANT_ID, runId, firstHolder);

    const runAfterRelease = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(runAfterRelease?.leaseFenceCounter).toBe(1);
    expect(runAfterRelease?.lease).toBeUndefined();

    const second = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-b',
      2_000,
    );
    expect(second.holder?.fence).toBe(2);
    expect(second.holder?.fence).toBeGreaterThan(firstHolder.fence);

    // The released, stale first holder can never revalidate.
    const staleRenew = await renewEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      firstHolder,
      3_000,
    );
    expect(staleRenew).toBe(false);
  });

  it('advancing run state through a stale fence is refused and writes nothing; the stored run is byte-unchanged afterwards', async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);
    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    const holder = acquired.holder as EnrichmentRunLeaseHolder;

    const before = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    const staleHolder: EnrichmentRunLeaseHolder = {
      ownerId: holder.ownerId,
      fence: holder.fence + 99,
    };

    const result = await advanceEnrichmentRunState(
      asDatabase(database),
      TENANT_ID,
      runId,
      staleHolder,
      {
        cursor: { stage: 'discovery', pageTitle: 'ShouldNotApply' },
      },
    );
    expect(result.outcome).toBe('lease-lost');

    const after = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('a run marked complete records its completion timestamp, and the coverage-published timestamp is separately recoverable after a crash between the two writes', async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);
    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    const holder = acquired.holder as EnrichmentRunLeaseHolder;

    const completed = await completeEnrichmentRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      holder,
      5_000,
    );
    expect(completed.outcome).toBe('applied');
    expect(completed.run?.completedAtMs).toBe(5_000);
    expect(completed.run?.coveragePublishedAtMs).toBeUndefined();
    expect(completed.run?.lease).toBeUndefined();

    // Crash-recoverable second write: marking published later still succeeds.
    const published = await markEnrichmentCoveragePublished(
      asDatabase(database),
      TENANT_ID,
      runId,
      6_000,
    );
    expect(published?.coveragePublishedAtMs).toBe(6_000);

    const runningRunPublishAttempt = await (async () => {
      const fresh = new FakeDatabase();
      const { runId: freshRunId } = await createRunning(fresh);
      return markEnrichmentCoveragePublished(asDatabase(fresh), TENANT_ID, freshRunId, 7_000);
    })();
    expect(runningRunPublishAttempt).toBeNull();
  });

  it('a failed run records its failure reason and is no longer active', async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);
    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    const holder = acquired.holder as EnrichmentRunLeaseHolder;

    const failed = await failEnrichmentRun(
      asDatabase(database),
      TENANT_ID,
      runId,
      holder,
      'boom',
      9_000,
    );
    expect(failed.outcome).toBe('applied');
    expect(failed.run?.status).toBe('failed');
    expect(failed.run?.failedAtMs).toBe(9_000);
    expect(failed.run?.reason).toBe('boom');

    const active = await readActiveEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(active).toBeNull();
  });

  it('the cursor member persists the last completed unit of work so a resumed run continues rather than restarting', async () => {
    const database = new FakeDatabase();
    const { runId } = await createRunning(database);
    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      runId,
      'owner-a',
      1_000,
    );
    const holder = acquired.holder as EnrichmentRunLeaseHolder;

    const advanced = await advanceEnrichmentRunState(
      asDatabase(database),
      TENANT_ID,
      runId,
      holder,
      {
        cursor: { stage: 'extraction', pageTitle: 'Supernova/2026/Ultimate/Singles Bracket' },
      },
    );
    expect(advanced.outcome).toBe('applied');

    const stored = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(stored?.cursor?.stage).toBe('extraction');
    expect(stored?.cursor?.pageTitle).toBe('Supernova/2026/Ultimate/Singles Bracket');
  });

  it('every transaction update function tolerates a null first invocation (FakeDatabase emulates the real SDK)', async () => {
    const database = new FakeDatabase();
    // No prior write of any kind — every call below is a genuinely first
    // transaction on an empty node.
    const created = await createRunning(database, 1_000);
    expect(created.status).toBe('running');
    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId,
      'owner-a',
      1_000,
    );
    expect(acquired.acquired).toBe(true);
  });

  it('ENRICHMENT_LEASE_TTL_MS matches the shipped machinery (120000ms)', () => {
    expect(ENRICHMENT_LEASE_TTL_MS).toBe(120_000);
  });
});
