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

  // 260806-hzx: the sweep's terminal write used to rebuild the job record
  // from scratch, dropping every stored field it didn't explicitly re-list
  // — including `reason`, the only prep/bundle/synthesis context the job
  // node carries. Downstream money decisions in `routes/reports.ts` (the
  // `preSpent` bundle-slot gate, the synthesis retry window) key on it, so
  // a swept job coming back reason-less looked exactly like a legacy job to
  // both.
  it.each([['prep_report'], ['prep_bundle'], ['post_event_synthesis']] as const)(
    'preserves a stored reason of %s across the sweep',
    async (reason) => {
      const database = new FakeDatabase();
      database.seed('credits/uid-1/balance', 0);
      seedRunningJob(database, 'uid-1', 'job-1', runningJob({ reason }));

      const result = await runSweepStuckReportJobs(database as never, {
        now: FIXED_NOW,
        staleMs: STALE_MS,
      });

      expect(result).toEqual({ swept: 1, refunded: 1 });

      const jobSnapshot = await database.ref('reportJobs/uid-1/job-1').get();
      expect(jobSnapshot.val()).toMatchObject({ status: 'failed', reason });

      const reportFailedEvents = eventsNamed(database, 'report_failed');
      expect(reportFailedEvents).toHaveLength(1);
      expect(reportFailedEvents[0]).toMatchObject({ payload: { reason } });
    },
  );

  it('sweeps a legacy reason-free job with no `reason` key on the terminal record, and does not throw', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 0);
    seedRunningJob(database, 'uid-1', 'job-1', runningJob());

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 1, refunded: 1 });

    const jobSnapshot = await database.ref('reportJobs/uid-1/job-1').get();
    const val = jobSnapshot.val() as Record<string, unknown>;
    expect(val.status).toBe('failed');
    expect(Object.keys(val)).not.toContain('reason');

    const reportFailedEvents = eventsNamed(database, 'report_failed');
    expect(reportFailedEvents).toHaveLength(1);
    expect(reportFailedEvents[0]).toMatchObject({ payload: {} });
  });
});

describe('runSweepStuckReportJobs — failureReason preservation (Phase 39, plan 39-07, review C2-M5)', () => {
  function reportFailedPayloads(database: FakeDatabase): Array<Record<string, unknown>> {
    return eventsNamed(database, 'report_failed').map(
      (event) => (event as { payload: Record<string, unknown> }).payload,
    );
  }

  it('carries a stale job’s failureReason onto the terminal job write, and leaves the report_failed payload byte-unchanged (reason only)', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 0);
    seedRunningJob(
      database,
      'uid-1',
      'job-1',
      runningJob({ reason: 'prep_report', failureReason: 'validation' }),
    );

    await runSweepStuckReportJobs(database as never, { now: FIXED_NOW, staleMs: STALE_MS });

    const job = (await database.ref('reportJobs/uid-1/job-1').get()).val() as Record<
      string,
      unknown
    >;
    expect(job).toMatchObject({
      status: 'failed',
      reason: 'prep_report',
      failureReason: 'validation',
    });
    const payloads = reportFailedPayloads(database);
    expect(payloads).toHaveLength(1);
    // The shipped class-B envelope's payload is EXACTLY `{ reason }` — the
    // failure cause never rides it.
    expect(Object.keys(payloads[0]!)).toEqual(['reason']);
    expect(payloads[0]).toEqual({ reason: 'prep_report' });
  });

  it('a legacy reason-free stale job carrying a failureReason keeps the cause on the job, and the report_failed payload stays {}', async () => {
    const database = new FakeDatabase();
    seedRunningJob(database, 'uid-1', 'job-2', runningJob({ failureReason: 'validation' }));

    await runSweepStuckReportJobs(database as never, { now: FIXED_NOW, staleMs: STALE_MS });

    const job = (await database.ref('reportJobs/uid-1/job-2').get()).val() as Record<
      string,
      unknown
    >;
    expect(job.failureReason).toBe('validation');
    expect(job).not.toHaveProperty('reason');
    expect(reportFailedPayloads(database)).toEqual([{}]);
  });

  it('a stale job WITHOUT a failureReason gains none (no key, never an explicit null), and the job-kind reason never carries a cause', async () => {
    const database = new FakeDatabase();
    seedRunningJob(database, 'uid-1', 'job-3', runningJob({ reason: 'prep_bundle' }));

    await runSweepStuckReportJobs(database as never, { now: FIXED_NOW, staleMs: STALE_MS });

    const job = (await database.ref('reportJobs/uid-1/job-3').get()).val() as Record<
      string,
      unknown
    >;
    expect(job).not.toHaveProperty('failureReason');
    expect(job.reason).toBe('prep_bundle');
    expect(reportFailedPayloads(database)).toEqual([{ reason: 'prep_bundle' }]);
  });
});

// Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25): the sweep refunds
// ONLY a job the route actually charged. `wasCharged` is recorded at spend
// time by `routes/reports.ts`; `false` means no credit was taken, so a refund
// would mint one. `true` and an absent field (pre-39-10 records) keep the
// refund. Refunds are proven via BALANCE and `refund` LEDGER entries — never
// via the deduped `credit_refunded` event.
describe('runSweepStuckReportJobs — refund only a charged job (39-10)', () => {
  function refundLedgerEntriesFor(
    database: FakeDatabase,
    uid: string,
    jobId: string,
  ): Array<Record<string, unknown>> {
    const dump = database.dump() as Record<string, unknown>;
    const ledger = (dump.creditLedger ?? {}) as Record<string, Record<string, unknown>>;
    return Object.values(ledger[uid] ?? {})
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => entry.type === 'refund' && entry.ref === jobId);
  }

  it('wasCharged: false — swept but NOT refunded: balance unchanged, no refund ledger entry, job failed with wasCharged false, index cleared, one report_failed:sweep', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 3);
    seedRunningJob(database, 'uid-1', 'job-free', runningJob({ wasCharged: false }));

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 1, refunded: 0 });
    expect((await database.ref('credits/uid-1/balance').get()).val()).toBe(3);
    expect(refundLedgerEntriesFor(database, 'uid-1', 'job-free')).toHaveLength(0);

    const job = (await database.ref('reportJobs/uid-1/job-free').get()).val() as Record<
      string,
      unknown
    >;
    expect(job).toMatchObject({ status: 'failed', wasCharged: false });

    const runningIndex = await database.ref('reportJobsByStatus/running/uid-1/job-free').get();
    expect(runningIndex.exists()).toBe(false);

    const reportFailedEvents = eventsNamed(database, 'report_failed');
    expect(reportFailedEvents).toHaveLength(1);
    expect(reportFailedEvents[0]).toMatchObject({ causationId: 'job-free:report_failed:sweep' });
  });

  it('wasCharged: true — refunded: balance +1 and exactly one refund ledger entry with ref=jobId', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 3);
    seedRunningJob(database, 'uid-1', 'job-paid', runningJob({ wasCharged: true }));

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 1, refunded: 1 });
    expect((await database.ref('credits/uid-1/balance').get()).val()).toBe(4);
    const entries = refundLedgerEntriesFor(database, 'uid-1', 'job-paid');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'refund', amount: 1, ref: 'job-paid' });

    const job = (await database.ref('reportJobs/uid-1/job-paid').get()).val() as Record<
      string,
      unknown
    >;
    expect(job).toMatchObject({ status: 'failed', wasCharged: true });
  });

  it('wasCharged absent (legacy pre-39-10 record) — keeps the refund: balance +1 and exactly one refund ledger entry', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 3);
    seedRunningJob(database, 'uid-1', 'job-legacy', runningJob());

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 1, refunded: 1 });
    expect((await database.ref('credits/uid-1/balance').get()).val()).toBe(4);
    expect(refundLedgerEntriesFor(database, 'uid-1', 'job-legacy')).toHaveLength(1);

    const job = (await database.ref('reportJobs/uid-1/job-legacy').get()).val() as Record<
      string,
      unknown
    >;
    expect(job).not.toHaveProperty('wasCharged');
  });

  it('a mixed batch counts every swept job but only the actual refunds', async () => {
    const database = new FakeDatabase();
    database.seed('credits/uid-1/balance', 0);
    seedRunningJob(database, 'uid-1', 'job-free', runningJob({ wasCharged: false }));
    seedRunningJob(database, 'uid-1', 'job-paid', runningJob({ wasCharged: true }));
    seedRunningJob(database, 'uid-1', 'job-legacy', runningJob());

    const result = await runSweepStuckReportJobs(database as never, {
      now: FIXED_NOW,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ swept: 3, refunded: 2 });
    expect((await database.ref('credits/uid-1/balance').get()).val()).toBe(2);
    expect(refundLedgerEntriesFor(database, 'uid-1', 'job-free')).toHaveLength(0);
  });
});
