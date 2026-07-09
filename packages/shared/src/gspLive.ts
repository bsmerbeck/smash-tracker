import { z } from 'zod';

/**
 * V17.1: live community GSP thresholds — the current Elite Smash entry GSP
 * and the current max GSP (the #1 player), cached server-side in the RTDB
 * singleton `gspLive` and refreshed lazily from gsptiers.com's own data
 * endpoint (https://gsptiers.com/gsp-thingy/gsp, the JSON its client
 * renders from) when older than the API's staleness window (~6h — "a few
 * times a day" across ALL users, not per user).
 *
 * Why: the GSP↔MMR model needs a calibration observation for its drifting
 * `t` parameter. Before this, the anchor was either the doc's static
 * 2026-06-11 observation or a manual user edit; a fresh upstream reading a
 * few times a day keeps the computed threshold (and the tier ladder's max)
 * honest without anyone typing numbers in. The UI keeps attributing
 * gsptiers.com (which itself credits elitegsp.com).
 */
export const gspLiveSchema = z.object({
  /** Elite Smash entry GSP as reported upstream. */
  elite: z.number().int().positive(),
  /** Max (rank-1) GSP as reported upstream. */
  max: z.number().int().positive(),
  /** Epoch ms the API fetched this from upstream — doubles as the model-calibration timestamp. */
  fetchedAt: z.number(),
  source: z.literal('gsptiers.com'),
});
export type GspLive = z.infer<typeof gspLiveSchema>;

/** The upstream endpoint's response shape (unknown extra keys ignored). */
export const gsptiersUpstreamSchema = z.object({
  max: z.number().positive(),
  elite: z.number().positive(),
});
