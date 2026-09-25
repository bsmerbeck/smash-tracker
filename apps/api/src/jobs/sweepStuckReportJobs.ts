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
 * the credit (only if the job was charged — see below), and emit exactly one
 * `report_failed` B event — but with a DISTINCT causationId suffix (`:sweep`)
 * so a sweep-driven failure is distinguishable from a route-driven one in
 * the event ledger (and can never collide with `report_failed`'s dedup key
 * even if both paths somehow raced).
 *
 * T-10-06-04 (double-refund): the running-index guard is what makes this
 * idempotent — once a job is swept, its `reportJobsByStatus/running/{uid}/{jobId}`
 * entry is cleared, so a second sweep run never finds it again and never
 * refunds twice.
 *
 * Refund only a charged job (post-plan fix 39-10, owner decision
 * 2026-09-25): a job that reached `running` either (a) belongs to a uid that
 * successfully spent a credit, or (b) belongs to an allowlisted (free-access)
 * uid that spent nothing. Before 39-10 the job record could not distinguish
 * (a) from (b) without a per-user ledger scan (which would break the
 * bounded-index discipline this sweep is built on), so the sweep refunded
 * unconditionally — which MINTED a credit for every swept free job. Since
 * 39-10, `routes/reports.ts` records `wasCharged` on the job at spend time,
 * so the sweep now calls `refundCredit()` only when `job.wasCharged !==
 * false`: `true` refunds, and an ABSENT field (a record written before 39-10)
 * keeps the original refund, because such a job may well have been charged.
 * Everything else is unchanged for an uncharged job — it is still set
 * `failed`, its index and day-mirror are still cleared, and its
 * `report_failed` event is still emitted. `refunded` counts actual refunds
 * only; `swept` counts every job.
 *
 * Field preservation (260806-hzx): the terminal write carries the stored
 * job's identity fields forward rather than reconstructing a minimal
 * record. `reason` is the load-bearing one — `routes/reports.ts`'s
 * `preSpent` bundle-slot gate and its synthesis retry window both branch on
 * it, so a swept job that lost it looked exactly like a legacy job to every
 * downstream money decision. `resultRef` is carried defensively only; a
 * `running` job never actually has one under the current writes. Both
 * spreads MUST stay conditional on truthiness (not `!== undefined`) —
 * `reason` is `.nullish()`, so a stored `null` must also produce no key,
 * and an explicit `undefined` own-property survives Zod's optional parse
 * but is rejected by the real RTDB SDK at write time (the 2026-07-30
 * envelope failure class). Mirrors `failJob()` in `routes/reports.ts`.
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
          ...(job.reason ? { reason: job.reason } : {}),
          ...(job.resultRef ? { resultRef: job.resultRef } : {}),
          // Phase 39 (D-07, review C2-M5): preserve the failure CAUSE on the
          // terminal JOB write only — never on the `report_failed` envelope
          // payload below, whose shape is a shipped class-B contract. Future-
          // proofing, not a live path: the sweep only catches stale `running`
          // jobs, before a validator could have written a cause.
          ...(job.failureReason ? { failureReason: job.failureReason } : {}),
          // Post-plan fix (39-10): the spend fact the route recorded. `typeof`,
          // NOT truthiness — `false` ("no credit was taken") must survive.
          // The refund below branches on it: only `false` withholds the refund.
          ...(typeof job.wasCharged === 'boolean' ? { wasCharged: job.wasCharged } : {}),
        }),
      );

      const day = dayShardKey(failedAt);
      await database.ref().update({
        [`reportJobsByStatus/running/${uid}/${jobId}`]: null,
        [`reportJobsByDay/${day}/${jobId}`]: { uid, status: 'failed' },
      });

      // 39-10: `false` means the route never took a credit — refunding would
      // mint one. `true` and an absent field (pre-39-10 record) refund.
      if (job.wasCharged !== false) {
        await refundCredit(database, uid, jobId);
        result.refunded += 1;
      }

      void createEvent(
        database,
        buildBillingEnvelope({
          eventName: 'report_failed',
          source: 'job',
          actorId: uid,
          sessionId: uid,
          causationId: `${jobId}:report_failed:sweep`,
          consentState: 'unknown',
          payload: job.reason ? { reason: job.reason } : {},
        }),
      );

      result.swept += 1;
    }
  }

  return result;
}
