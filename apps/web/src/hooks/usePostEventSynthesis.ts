import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  errorResponseSchema,
  practicePlanResponseSchema,
  synthesisJobStatusResponseSchema,
  type PracticePlanResponse,
  type ReportJobStatus,
  type SynthesisJobStatusResponse,
} from '@smash-tracker/shared';
import { ApiError, getApiBaseUrl, getDirectApiBaseUrl } from '@/lib/api';
import { getActiveSubjectHeader } from '@/lib/subjectQueryKey';
import { getFirebaseAuth } from '@/lib/firebase';
import { useAuth } from './useAuth';

/**
 * Phase 28 (28-09, REV-03): self-contained request helper mirroring
 * `apps/web/src/lib/api.ts`'s own `apiRequest` (Authorization +
 * `X-Active-Subject` headers, JSON parse, `ApiError` on non-2xx) — this file
 * is not among `apps/web/src/lib/api.ts`'s declared owners for this plan,
 * and `apiRequest`/`apiRequestParsed` are private to that module (same
 * precedent `useCoachNotes.ts` documents for its own `coachRequest`). Unlike
 * `useCoachNotes.ts`'s token-scoped routes, these ARE ordinary signed-in-user
 * routes, so — unlike that hook — an auth header IS attached here.
 */
async function getAuthHeader(): Promise<Record<string, string>> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    return {};
  }
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

interface SynthesisRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Overrides the request origin — pass `getDirectApiBaseUrl()` for a generation SUBMISSION. */
  baseUrl?: string;
}

async function synthesisRequest<TResponse>(
  path: string,
  options: SynthesisRequestOptions = {},
): Promise<TResponse> {
  const authHeader = await getAuthHeader();
  const hasBody = options.body !== undefined;

  const response = await fetch(`${options.baseUrl ?? getApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...authHeader,
      'X-Active-Subject': getActiveSubjectHeader(),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(json);
    if (parsedError.success) {
      throw new ApiError(response.status, parsedError.data.message, parsedError.data.details);
    }
    throw new ApiError(response.status, response.statusText || 'Request failed');
  }

  return json as TResponse;
}

/**
 * How often to re-poll `GET /api/reports/synthesis` while the ONE current
 * synthesis job for this entry is still non-terminal — same cadence as
 * `usePrepReportJobs`'s `PREP_REPORT_JOB_POLL_INTERVAL_MS` (T-27-46's
 * stop-on-terminal precedent, applied to a single job instead of a list).
 */
const SYNTHESIS_JOB_POLL_INTERVAL_MS = 4_000;

/** Short — mirrors `usePrepReportJobs`'s `PREP_REPORT_JOBS_STALE_TIME_MS` (an active polling surface, unlike the app-wide 60s default). */
const SYNTHESIS_JOB_STALE_TIME_MS = 2_000;

/**
 * A job keeps `useSynthesisJob` polling while its status is one of these
 * three — `failed` is NOT a stop-polling state (the async refund commits
 * after the failure write), only `succeeded`/`refunded` are terminal.
 * Mirrors `usePrepReportJobs.ts`'s `POLLING_JOB_STATUSES` exactly.
 */
const POLLING_JOB_STATUSES: ReadonlySet<ReportJobStatus> = new Set(['queued', 'running', 'failed']);

/**
 * Pure interval computation, exported so the stop-polling behavior is
 * unit-tested directly without relying on real elapsed time or TanStack
 * Query's own scheduling — mirrors `computePrepReportJobsRefetchInterval`.
 * `undefined` (query hasn't resolved) and `null` (no job submitted yet, the
 * `{job: null}` response shape) both mean "nothing to poll for" — `false`.
 */
export function computeSynthesisJobRefetchInterval(
  job: SynthesisJobStatusResponse['job'] | null | undefined,
): number | false {
  if (job == null) {
    return false;
  }
  return POLLING_JOB_STATUSES.has(job.status) ? SYNTHESIS_JOB_POLL_INTERVAL_MS : false;
}

export function synthesisJobQueryKey(entryKey: string) {
  return ['postEventSynthesisJob', entryKey] as const;
}

/**
 * GET /api/reports/synthesis?entryKey= (Phase 28, REV-03) — the ONE current
 * synthesis job for this entry (`{job: null}` when none has ever been
 * submitted). Deliberately on the ORDINARY same-origin path, mirroring
 * `usePrepReportJobs`'s own read/write origin split: a status read is a
 * plain fast read, never the direct-to-Cloud-Run escape hatch reserved for
 * generation SUBMISSIONS.
 */
export function useSynthesisJob(entryKey: string | undefined, options?: { enabled?: boolean }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: synthesisJobQueryKey(entryKey ?? ''),
    queryFn: async () => {
      const json = await synthesisRequest<unknown>(
        `/api/reports/synthesis?entryKey=${encodeURIComponent(entryKey as string)}`,
      );
      return synthesisJobStatusResponseSchema.parse(json);
    },
    enabled: Boolean(user) && Boolean(entryKey) && (options?.enabled ?? true),
    staleTime: SYNTHESIS_JOB_STALE_TIME_MS,
    refetchInterval: (currentQuery) =>
      computeSynthesisJobRefetchInterval(currentQuery.state.data?.job),
  });
}

export function practicePlanQueryKey(planId: string) {
  return ['postEventPracticePlan', planId] as const;
}

/**
 * GET /api/reports/practice-plans/:planId (Phase 28, REV-03) — the stored
 * practice plan once a synthesis job's `resultRef` is populated. Idle
 * (`enabled: false`) with no `planId`, the same shape a succeeded job hasn't
 * yet delivered a `resultRef` for, or the card hasn't expanded "View plan"
 * yet — this hook never fetches speculatively. Ordinary same-origin path,
 * same reasoning as `useSynthesisJob` above (a plain read, not a
 * generation submission).
 */
export function usePracticePlan(planId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: practicePlanQueryKey(planId ?? ''),
    queryFn: async (): Promise<PracticePlanResponse> => {
      const json = await synthesisRequest<unknown>(
        `/api/reports/practice-plans/${encodeURIComponent(planId as string)}`,
      );
      return practicePlanResponseSchema.parse(json);
    },
    enabled: Boolean(user) && Boolean(planId),
  });
}

/**
 * POST /api/reports with `reason: 'post_event_synthesis'` (Phase 28,
 * REV-03) — the one-credit synthesis SUBMISSION. Rides
 * `getDirectApiBaseUrl()`, the same direct-to-Cloud-Run transport
 * `useGeneratePrepReport` uses (the Hosting proxy's 60s rewrite timeout the
 * model call can outlive). No `jobId` is ever sent from this card — unlike a
 * prep bundle child, a synthesis job has no pre-paid slot id; the server
 * resolves the ONE current job for `{uid, entryKey}` itself
 * (`prepSynthesisJobIndex`, 28-02-SUMMARY.md). `ApiError` (including a 402)
 * propagates untransformed to the caller (the card branches on
 * `error.status === 402`), never swallowed here. Invalidates the synthesis
 * job query `onSettled` (not `onSuccess`) — mirrors `useGeneratePrepReport`:
 * a submission that itself throws (e.g. a 409 outstanding-job race) can
 * still have changed server state worth re-polling for.
 */
export function useSubmitSynthesis(entryKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      synthesisRequest<unknown>('/api/reports', {
        method: 'POST',
        body: { reason: 'post_event_synthesis', entryKey },
        baseUrl: getDirectApiBaseUrl(),
      }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: synthesisJobQueryKey(entryKey) });
    },
  });
}
