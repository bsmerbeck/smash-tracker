import type { Database } from 'firebase-admin/database';
import { reportJobSchema } from '@smash-tracker/shared';
import { refundCredit } from '../billing/credits.js';
import { createEvent, dayShardKey } from '../events/ledger.js';
import { buildBillingEnvelope } from '../events/envelope.js';

/**
 * BILL-06: recovers report-generation jobs that crashed mid-flight and never
 * reached a terminal state. Reads ONLY the bounded `reportJobsByStatus/running`
 * index (never a cross-user scan of `reportJobs`) — the same index
 * `routes/reports.ts` maintains alongside every `running`/terminal write.
 *
 * Mirrors `reports.ts`'s own (unexported) `failJob()` transition shape: set
 * the job `failed`, clear the running index, update the day-mirror, refund
 * the credit, and emit exactly one `report_failed` B event — but with a
 * DISTINCT causationId suffix (`:sweep`) so a sweep-driven failure is
 * distinguishable from a route-driven one in the event ledger (and can never
 * collide with `report_failed`'s dedup key even if both paths somehow raced).
 *
 * T-10-06-04 (double-refund): the running-index guard is what makes this
 * idempotent — once a job is swept, its `reportJobsByStatus/running/{uid}/{jobId}`
 * entry is cleared, so a second sweep run never finds it again and never
 * refunds twice.
 *
 * Unconditional refund (RESEARCH.md Pattern 5 step 5): a job that reached
 * `running` either (a) belongs to a non-allowlisted uid that successfully
 * spent a credit before transitioning to `running` (the 402 path in
 * `reports.ts` never reaches `running`), or (b) belongs to an allowlisted
 * (free-access) uid that never spent one. This job cannot durably
 * distinguish (a) from (b) without a per-user ledger scan (which would break
 * the bounded-index discipline this sweep is built on), so it always calls
 * `refundCredit()` — a harmless no-op-adjacent credit for a free-access uid,
 * matching the research-authored design exactly.
 */

export interface SweepStuckReportJobsResult {
  swept: number;
  refunded: number;
}

export interface SweepStuckReportJobsOptions {
  /** Staleness window in ms; defaults to `reports.ts`'s own `REPORT_JOB_STALE_MS` (15 min). */
  staleMs?: number;
  /** Injectable "now" for tests. */
  now?: number;
}

/** Mirrors `routes/reports.ts`'s `REPORT_JOB_STALE_MS` — kept as a local constant to avoid a route->job import. */
const DEFAULT_STALE_MS = 15 * 60 * 1000;

export async function runSweepStuckReportJobs(
  database: Database,
  opts: SweepStuckReportJobsOptions = {},
): Promise<SweepStuckReportJobsResult> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = opts.now ?? Date.now();
  const result: SweepStuckReportJobsResult = { swept: 0, refunded: 0 };

  const runningSnapshot = await database.ref('reportJobsByStatus/running').get();
  if (!runningSnapshot.exists()) {
    return result;
  }

  const runningIndex = (runningSnapshot.val() ?? {}) as Record<string, Record<string, unknown>>;

  for (const [uid, jobsForUid] of Object.entries(runningIndex)) {
    for (const jobId of Object.keys(jobsForUid ?? {})) {
      const jobRef = database.ref(`reportJobs/${uid}/${jobId}`);
      const jobSnapshot = await jobRef.get();

      if (!jobSnapshot.exists()) {
        // Orphaned index entry with no backing job record — clear it, there
        // is nothing to refund.
        await database.ref(`reportJobsByStatus/running/${uid}/${jobId}`).remove();
        continue;
      }

      const parsed = reportJobSchema.safeParse(jobSnapshot.val());
      if (!parsed.success) {
        // Corrupt job record — safe-parse-and-skip, never throw.
        continue;
      }
      const job = parsed.data;

      if (job.status !== 'running') {
        // Already transitioned by the owning request between this sweep
        // reading the index and reading the job — clear the stale index
        // entry (it should have been cleared by that transition already;
        // this is a defensive no-op-safe cleanup).
        await database.ref(`reportJobsByStatus/running/${uid}/${jobId}`).remove();
        continue;
      }

      if (now - job.updatedAt <= staleMs) {
        // Genuinely in-flight (or recently so) — leave untouched.
        continue;
      }

      const failedAt = now;
      await jobRef.set(
        reportJobSchema.parse({
          status: 'failed',
          createdAt: job.createdAt,
          updatedAt: failedAt,
          attempt: job.attempt,
          creditRef: job.creditRef,
        }),
      );

      const day = dayShardKey(failedAt);
      await database.ref().update({
        [`reportJobsByStatus/running/${uid}/${jobId}`]: null,
        [`reportJobsByDay/${day}/${jobId}`]: { uid, status: 'failed' },
      });

      await refundCredit(database, uid, jobId);
      result.refunded += 1;

      void createEvent(
        database,
        buildBillingEnvelope({
          eventName: 'report_failed',
          source: 'job',
          actorId: uid,
          sessionId: uid,
          causationId: `${jobId}:report_failed:sweep`,
          consentState: 'unknown',
          payload: {},
        }),
      );

      result.swept += 1;
    }
  }

  return result;
}
