import type { GspPoint, GspSettings, GspZone, TCalibration } from '@smash-tracker/shared';
import { eliteThresholdGsp, estimateT, gspToMmr } from '@smash-tracker/shared';

/**
 * V10.1 page-level glue for the reverse-engineered GSP->MMR model
 * (packages/shared/src/gspMmr.ts). The shared module is pure math over
 * `(gsp, t)`; this file owns the two page-specific decisions:
 *
 *   1. WHERE the t-calibration comes from: the user's existing Elite
 *      Threshold setting. `gspSettings` already stores exactly what a
 *      `TCalibration` needs — `eliteThreshold` (the GSP value) and
 *      `updatedAt` (when it was saved) — so V10.1 required NO schema change
 *      (verified against `gspSettingsSchema`). An `updatedAt` of 0 is the
 *      API's "never actually saved" sentinel (see `RtdbService.getGspSettings`),
 *      in which case we fall back to the model's built-in 2026-06-11 anchor.
 *   2. WHICH t each conversion uses: historical GSP readings are converted
 *      at the t of THEIR OWN log time (t drifts ~0.98/hour, so a
 *      reading from last month must not be interpreted against today's
 *      inflated ceiling). This is what makes the MMR view flat over time
 *      when skill is flat, unlike the ever-inflating GSP number.
 */

/** The community reverse-engineering doc every constant in the model traces to (captured 2026-07-07). */
export const GSP_MMR_DOC_URL =
  'https://docs.google.com/document/d/e/2PACX-1vTJ_OknOfmnoZ-jKu0lHukq6lTZJOLn6zEPUZMHOzRWZ68AOIPuejUQI1JqDDepP324fThnmShXeudb/pub';

/**
 * Derives a t-calibration from the user's Elite Threshold setting, or
 * `undefined` when they've never actually saved one (`updatedAt: 0` is the
 * API's synthesized-default sentinel — calibrating on the placeholder value
 * would poison the model, so we use the doc's anchor instead).
 */
export function calibrationFromSettings(settings: GspSettings): TCalibration | undefined {
  if (settings.updatedAt <= 0) return undefined;
  return { eliteThresholdGsp: settings.eliteThreshold, atMs: settings.updatedAt };
}

/**
 * The COMPUTED current Elite Smash entry GSP (rounded to a whole GSP): the
 * model's Elite MMR (1142) pushed through the forward curve at t(now),
 * recalibrated by the user's latest threshold edit when present.
 */
export function computedEliteThreshold(nowMs: number, calibration?: TCalibration): number {
  return Math.round(eliteThresholdGsp(estimateT(nowMs, calibration)));
}

/** One GSP reading converted to the hidden-MMR scale. */
export interface MmrPoint {
  time: number;
  /** Estimated hidden MMR (fractional — display code rounds). */
  mmr: number;
  /** 'main' readings are ±1-GSP-accurate; 'top'/'bottom' fall in the approximate linear tails. */
  zone: GspZone;
  win: boolean;
}

/** Estimated MMR for a single GSP reading taken at `atMs` (t evaluated at the reading's own time — see module doc). */
export function estimateMmrAt(
  gsp: number,
  atMs: number,
  calibration?: TCalibration,
): { mmr: number; zone: GspZone } {
  return gspToMmr(gsp, estimateT(atMs, calibration));
}

/** Converts a chronological GSP series to the MMR scale, each reading at its own log-time t (see module doc). */
export function toMmrSeries(series: GspPoint[], calibration?: TCalibration): MmrPoint[] {
  return series.map((p) => {
    const { mmr, zone } = estimateMmrAt(p.gsp, p.time, calibration);
    return { time: p.time, mmr, zone, win: p.win };
  });
}
