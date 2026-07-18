import { describe, expect, it } from 'vitest';
import type { ReportJob } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { runSweepStuckReportJobs } from './sweepStuckReportJobs.js';

const FIXED_NOW = 1_700_000_000_000;
const STALE_MS = 15 * 60 * 1000;

function runningJob(overrides: Partial<ReportJob> = {}): ReportJob {
  return {
    status: 'running',
    createdAt: FIXED_NOW - STALE_MS * 2,
    updatedAt: FIXED_NOW - STALE_MS * 2,
    attempt: 0,
    creditRef: 'job-1',
    ...overrides,
  };
}

function seedRunningJob(database: FakeDatabase, uid: string, jobId: string, job: ReportJob): void {
  database.seed(`reportJobs/${uid}/${jobId}`, job);
  database.seed(`reportJobsByStatus/running/${uid}/${jobId}`, true);
}

function eventsNamed(database: FakeDatabase, eventName: string): unknown[] {
  const dump = database.dump() as Record<string, unknown>;
  const ledger = (dump.eventLedger ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(ledger)
    .flatMap((day) => Object.values(day))
    .filter((event) => (event as { eventName: string }).eventName === eventName);
}

describe('runSweepStuckReportJobs', () => {
  it('returns all-zero counts when there is nothing running', async () => {
    const database = new FakeDatabase();
    const result = await runSweepStuckReportJobs(database as never, { now: FIXED_NOW });
    expect(result).toEqual({ swept: 0, refunded: 0 });
  });

  it('transitions a stale running job to failed, refunds the credit, and emits exactly one report_failed', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 0);
    seedRunningJob(database, 'uid-1', 'job-1', runningJob());

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 1, refunded: 1 });

    const jobSnapshot = await database.ref('reportJobs/uid-1/job-1').get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'failed', creditRef: 'job-1' });

    const balance = await database.ref('credits/uid-1/balance').get();
    expect(balance.val()).toBe(1);

    const runningIndex = await database.ref('reportJobsByStatus/running/uid-1/job-1').get();
    expect(runningIndex.exists()).toBe(false);

    const dump = database.dump() as Record<string, unknown>;
    const byDay = dump.reportJobsByDay as Record<string, Record<string, unknown>>;
    const dayEntries = Object.values(byDay ?? {});
    const matching = dayEntries.flatMap((day) =>
      day['job-1'] !== undefined ? [day['job-1']] : [],
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ uid: 'uid-1', status: 'failed' });

    const reportFailedEvents = eventsNamed(database, 'report_failed');
    expect(reportFailedEvents).toHaveLength(1);
    expect(reportFailedEvents[0]).toMatchObject({ causationId: 'job-1:report_failed:sweep' });

    expect(eventsNamed(database, 'credit_refunded')).toHaveLength(1);
  });

  it('leaves a running job WITHIN the staleness window untouched', async () => {
    const database = new FakeDatabase();
    seedRunningJob(
      database,
      'uid-1',
      'job-fresh',
      runningJob({ updatedAt: FIXED_NOW - 1000, createdAt: FIXED_NOW - 1000 }),
    );

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 0, refunded: 0 });
    const jobSnapshot = await database.ref('reportJobs/uid-1/job-fresh').get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'running' });
    const runningIndex = await database.ref('reportJobsByStatus/running/uid-1/job-fresh').get();
    expect(runningIndex.exists()).toBe(true);
  });

  it('never double-refunds a job on a second sweep run over the same state', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 0);
    seedRunningJob(database, 'uid-1', 'job-1', runningJob());

    const first = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });
    expect(first).toEqual({ swept: 1, refunded: 1 });

    const second = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW + 1000,
      staleMs: STALE_MS,
    });
    expect(second).toEqual({ swept: 0, refunded: 0 });

    const balance = await database.ref('credits/uid-1/balance').get();
    expect(balance.val()).toBe(1);
    expect(eventsNamed(database, 'credit_refunded')).toHaveLength(1);
  });

  it('only acts on jobs present in the reportJobsByStatus/running index — never scans reportJobs directly', async () => {
    const database = new FakeDatabase();
    // A running job whose index entry was never written (simulating index
    // drift) must NEVER be touched by the sweep — it relies solely on the
    // bounded index, not a cross-user scan of reportJobs.
    database.seed('reportJobs/uid-unindexed/job-unindexed', runningJob());

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 0, refunded: 0 });
    const jobSnapshot = await database.ref('reportJobs/uid-unindexed/job-unindexed').get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'running' });
  });

  it('clears an orphaned running-index entry with no backing job record, without erroring', async () => {
    const database = new FakeDatabase();
    database.seed('reportJobsByStatus/running/uid-1/job-ghost', true);

    const result = await runSweepStuckReportJobs(database as never, { now: FIXED_NOW });

    expect(result).toEqual({ swept: 0, refunded: 0 });
    const runningIndex = await database.ref('reportJobsByStatus/running/uid-1/job-ghost').get();
    expect(runningIndex.exists()).toBe(false);
  });

  it('skips a corrupt stored job record via safe-parse-and-skip, without throwing', async () => {
    const database = new FakeDatabase();
    database.seed('reportJobs/uid-1/job-corrupt', { status: 'not-a-real-status' });
    database.seed('reportJobsByStatus/running/uid-1/job-corrupt', true);

    const result = await runSweepStuckReportJobs(database as never, { now: FIXED_NOW });

    expect(result).toEqual({ swept: 0, refunded: 0 });
  });

  it('clears a stale running-index entry whose job already transitioned to a terminal state', async () => {
    const database = new FakeDatabase();
    database.seed(
      'reportJobs/uid-1/job-done',
      runningJob({ status: 'succeeded', resultRef: 'result-1' }),
    );
    database.seed('reportJobsByStatus/running/uid-1/job-done', true);

    const result = await runSweepStuckReportJobs(database as never, { now: FIXED_NOW });

    expect(result).toEqual({ swept: 0, refunded: 0 });
    const runningIndex = await database.ref('reportJobsByStatus/running/uid-1/job-done').get();
    expect(runningIndex.exists()).toBe(false);
  });
});
