import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const gspLiveQueryKey = ['gspLive'] as const;

/**
 * GET /api/gsp-live — the live community elite/max GSP thresholds (V17.1),
 * cached server-side and refreshed from gsptiers.com a few times a day. A
 * 404 (nothing fetched upstream yet) is normal early on: consumers fall
 * back to the model's static anchor / the user's manual calibration, so the
 * query error is simply absorbed as `data: undefined`. Long staleTime — the
 * server only refreshes every ~6h, so refetching more often buys nothing.
 */
export function useGspLive() {
  const { user } = useAuth();
  return useQuery({
    queryKey: gspLiveQueryKey,
    queryFn: () => api.gspLive.get(),
    enabled: user != null,
    staleTime: 30 * 60 * 1000,
  });
}
