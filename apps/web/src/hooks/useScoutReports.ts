import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GenerateReportRequest } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const reportsConfigQueryKey = ['reportsConfig'] as const;
export const scoutReportsListQueryKey = ['scoutReports'] as const;

/**
 * GET /api/reports/config — whether AI scouting reports are enabled for the
 * signed-in user. Never 403s server-side; the response's `enabled` flag is
 * how the Scout page decides whether to show the "Generate AI report" button
 * at all. Long `staleTime` since this rarely changes mid-session.
 */
export function useReportsConfig() {
  const { user } = useAuth();
  return useQuery({
    queryKey: reportsConfigQueryKey,
    queryFn: () => api.reports.config(),
    enabled: Boolean(user),
    staleTime: 60 * 60 * 1000,
  });
}

/** POST /api/reports — generate (and store) an AI report. Invalidates the past-reports list. */
export function useGenerateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateReportRequest) => api.reports.generate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: scoutReportsListQueryKey });
    },
  });
}

/** GET /api/reports — the signed-in user's past AI reports, newest first. */
export function useScoutReportsList() {
  const { user } = useAuth();
  return useQuery({
    queryKey: scoutReportsListQueryKey,
    queryFn: () => api.reports.list(),
    enabled: Boolean(user),
  });
}
