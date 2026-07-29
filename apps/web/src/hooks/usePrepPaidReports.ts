import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { creditsQueryKey } from './useBilling';
import { prepReportJobsQueryKey } from './usePrepReportJobs';

interface GeneratePrepReportInput {
  opponentName: string;
  /**
   * A bundle child's job id is the server-derived, pre-paid slot id
   * returned by `useStartPrepBundle` — passing it here executes that
   * specific child through the ordinary single-report path (the server
   * detects the pre-paid credit from the stored job's own `reason`, never
   * re-charging it). Omitted for a standalone single-opponent purchase,
   * where the server falls back to a server-generated job id.
   */
  jobId?: string;
}

/**
 * POST /api/reports with `reason: 'prep_report'` (Phase 27, RPT-01) — a
 * single-opponent prep report purchase (or a bundle child's own execution,
 * when `jobId` is the pre-paid slot id). Invalidates both the credits query
 * and the prep-jobs query `onSettled` — a failed job refunds automatically,
 * so the balance can move on either a success OR a failure outcome, and only
 * `onSettled` (not `onSuccess`) covers both.
 */
export function useGeneratePrepReport(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ opponentName, jobId }: GeneratePrepReportInput) =>
      api.reports.generatePrep({
        reason: 'prep_report',
        entryKey,
        opponentName,
        ...(jobId !== undefined ? { jobId } : {}),
      }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creditsQueryKey }),
        queryClient.invalidateQueries({ queryKey: prepReportJobsQueryKey(entryKey) }),
      ]);
    },
  });
}

interface StartPrepBundleInput {
  bundleId: string;
  opponentNames: string[];
}

/**
 * POST /api/reports with `reason: 'prep_bundle'` (Phase 27, RPT-02) — the
 * exactly-three-opponent bundle purchase. This call itself only takes
 * payment and creates three pre-paid child jobs (it does not generate a
 * report in-request), so the returned `jobs` list is what the caller feeds
 * to `executeBundleChildren` below. Same settle-time invalidation as
 * `useGeneratePrepReport`.
 */
export function useStartPrepBundle(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bundleId, opponentNames }: StartPrepBundleInput) =>
      api.reports.startPrepBundle({
        reason: 'prep_bundle',
        entryKey,
        bundleId,
        opponentNames,
      }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creditsQueryKey }),
        queryClient.invalidateQueries({ queryKey: prepReportJobsQueryKey(entryKey) }),
      ]);
    },
  });
}

/**
 * Fires a bundle's three pre-paid child jobs concurrently through the
 * caller-supplied single-report generation function (normally
 * `useGeneratePrepReport(entryKey).mutateAsync`), so `PrepPaidReportsCard`
 * (27-10) does not hand-roll the fan-out itself. Each child is an ordinary
 * prep-single submission whose job id is the pre-paid child id — the server
 * refuses to charge again for it, and a child failure is expected to refund
 * server-side (the balance is refetched on settle either way by the mutation
 * this drives). `Promise.allSettled` — one child's rejection must never
 * short-circuit the other two children's own submissions.
 */
export function executeBundleChildren(
  generateChild: (input: GeneratePrepReportInput) => Promise<unknown>,
  jobs: Array<{ opponentName: string; jobId: string }>,
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    jobs.map((job) => generateChild({ opponentName: job.opponentName, jobId: job.jobId })),
  );
}
