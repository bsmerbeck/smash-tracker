import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PrepReportJobStatusEntry, ReportJobStatus } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * How often to re-poll `GET /api/reports/jobs` while any job for the brief
 * is still non-terminal (T-27-46 mitigation: the interval below computes
 * `false` once every job is terminal, so this cadence never runs forever).
 */
const PREP_REPORT_JOB_POLL_INTERVAL_MS = 4_000;

/**
 * Short — this query backs an active polling surface (T-27-46), unlike the
 * app-wide 60s default (`apps/web/src/lib/queryClient.ts`): a stale read
 * here would delay the UI noticing a job's terminal transition.
 */
const PREP_REPORT_JOBS_STALE_TIME_MS = 2_000;

/**
 * A job keeps this hook polling while its status is one of these three —
 * 27-CONTEXT.md "Purchase behavior": a failed job's credit refund commits
 * asynchronously, so `failed` is NOT yet a stop-polling state — only once
 * the job settles at `succeeded` or transitions on to `refunded` does
 * polling stop. Typed against the shared `ReportJobStatus` enum so a future
 * change to that enum surfaces here as a type error rather than a silently
 * stale literal set.
 */
const POLLING_JOB_STATUSES: ReadonlySet<ReportJobStatus> = new Set(['queued', 'running', 'failed']);

function hasNonTerminalJob(jobs: PrepReportJobStatusEntry[]): boolean {
  return jobs.some((job) => POLLING_JOB_STATUSES.has(job.status));
}

/**
 * Pure interval computation, exported so the T-27-46 stop-polling behavior
 * is unit-tested directly (a terminal fixture -> `false`, a fixture
 * containing a queued/running/failed job -> the poll interval) without
 * relying on real elapsed time or TanStack Query's own scheduling.
 */
export function computePrepReportJobsRefetchInterval(
  jobs: PrepReportJobStatusEntry[] | undefined,
): number | false {
  if (!jobs || jobs.length === 0) {
    return false;
  }
  return hasNonTerminalJob(jobs) ? PREP_REPORT_JOB_POLL_INTERVAL_MS : false;
}

export function prepReportJobsQueryKey(entryKey: string) {
  return ['prepReportJobs', entryKey] as const;
}

/**
 * Pure helper mapping the job list to a lookup by curated opponent name —
 * exported and unit-tested directly since `PrepPaidReportsCard` (27-10)
 * needs per-opponent row state, not the raw array.
 */
export function mapPrepReportJobsByOpponentName(
  jobs: PrepReportJobStatusEntry[],
): Record<string, PrepReportJobStatusEntry> {
  const byOpponentName: Record<string, PrepReportJobStatusEntry> = {};
  for (const job of jobs) {
    byOpponentName[job.opponentName] = job;
  }
  return byOpponentName;
}

/**
 * GET /api/reports/jobs (Phase 27, RPT-03) — polls while any job for this
 * brief is non-terminal, stops once every known job is terminal (T-27-46).
 *
 * `options.enabled` lets a caller keep the hook mounted but idle (e.g. the
 * paid card renders before any purchase exists) rather than remounting it
 * once there is something to poll for — remounting would lose the query's
 * warm cache and refetch from scratch.
 */
export function usePrepReportJobs(entryKey: string | undefined, options?: { enabled?: boolean }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: prepReportJobsQueryKey(entryKey ?? ''),
    queryFn: () => api.reports.prepJobs(entryKey as string),
    enabled: Boolean(user) && Boolean(entryKey) && (options?.enabled ?? true),
    staleTime: PREP_REPORT_JOBS_STALE_TIME_MS,
    refetchInterval: (currentQuery) =>
      computePrepReportJobsRefetchInterval(currentQuery.state.data?.jobs),
  });

  const jobsByOpponentName = useMemo(
    () => mapPrepReportJobsByOpponentName(query.data?.jobs ?? []),
    [query.data],
  );

  return { ...query, jobsByOpponentName };
}
