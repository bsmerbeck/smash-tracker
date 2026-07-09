import type { GspSettings, TCalibration } from '@smash-tracker/shared';
import { useGspLive } from '@/hooks/useGspLive';
import { bestCalibration } from './gspMmrModel';

/**
 * V17.1: the calibration every GSP-page component should feed the model —
 * `bestCalibration` over the user's manual threshold edit and the live
 * gsptiers.com reading (one shared TanStack cache entry regardless of how
 * many components call this). Replaces direct `calibrationFromSettings`
 * calls in components; pure builders keep taking a `TCalibration` param.
 */
export function useModelCalibration(settings: GspSettings): TCalibration | undefined {
  const { data: live } = useGspLive();
  return bestCalibration(settings, live);
}
