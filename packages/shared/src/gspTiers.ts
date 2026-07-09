import { eliteThresholdGsp, estimateMaxGsp } from './gspMmr.js';

/**
 * The gsptiers.com tier ladder, re-computed locally.
 *
 *   Source: https://gsptiers.com (by golf#6991 / yetimoose), ladder
 *   definitions read from its client source, captured 2026-07-09.
 *
 * gsptiers.com defines every tier as a FIXED FRACTION of the current max
 * GSP (God = max, Legend = 99.8%, … top 90% = 10%), plus one live row: the
 * Elite Smash entry threshold. That works because GSP is literally "players
 * you outrank", so `gsp / max` approximates a percentile — top X% ⇔
 * GSP ≥ (1 − X/100)·max. We don't scrape the site (same stance as
 * elitegsp.com — link out with attribution instead); both inputs come from
 * our own model: the Elite threshold from `eliteThresholdGsp(t)` and the
 * max from `estimateMaxGsp(t)` (ceiling × an observed ratio — see
 * `MAX_GSP_OVER_CEILING` in gspMmr.ts). Boundaries are therefore ESTIMATES,
 * and the microbands near the very top (0.2% apart) carry the most error —
 * the UI links gsptiers.com for the live ladder.
 */

/** Tier ids, top to bottom. 'below' is our sentinel for "under the last ladder row" (bottom 10%) — not a gsptiers.com row. */
export type GspTierId =
  | 'god'
  | 'legend'
  | 'demon'
  | 'freak'
  | 'cracked'
  | 'top1'
  | 'top2'
  | 'top3'
  | 'top4'
  | 'top5'
  | 'elite'
  | 'top20'
  | 'top30'
  | 'top40'
  | 'top50'
  | 'top90'
  | 'below';

/**
 * The fraction-of-max tiers, descending, verbatim from gsptiers.com's
 * client source (captured 2026-07-09). The Elite row is intentionally NOT
 * here — its boundary is the live threshold, not a fraction of max.
 */
export const GSP_TIER_FRACTIONS: ReadonlyArray<{ id: GspTierId; fraction: number }> = [
  { id: 'god', fraction: 1 },
  { id: 'legend', fraction: 0.998 },
  { id: 'demon', fraction: 0.996 },
  { id: 'freak', fraction: 0.994 },
  { id: 'cracked', fraction: 0.992 },
  { id: 'top1', fraction: 0.99 },
  { id: 'top2', fraction: 0.98 },
  { id: 'top3', fraction: 0.97 },
  { id: 'top4', fraction: 0.96 },
  { id: 'top5', fraction: 0.95 },
  { id: 'top20', fraction: 0.8 },
  { id: 'top30', fraction: 0.7 },
  { id: 'top40', fraction: 0.6 },
  { id: 'top50', fraction: 0.5 },
  { id: 'top90', fraction: 0.1 },
];

export interface GspTierBoundary {
  id: GspTierId;
  /** Minimum GSP to sit in this tier (rounded to a whole GSP). */
  gsp: number;
  /**
   * "top X% of players" for this boundary, one decimal. 0 for 'god' (the UI
   * shows "est. max" instead). For 'elite' this is computed from the live
   * threshold ÷ max (≈9.5% as of 2026-07-09, drifting), like gsptiers.com's
   * own elite-percent readout.
   */
  topPercent: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The full ladder at drift parameter `t` (see `estimateT`), descending by
 * boundary GSP. The Elite row is slotted by value — normally between top 5%
 * and top 20%, but sorting by GSP keeps the ladder monotonic even if the
 * threshold ever drifts past a fraction boundary.
 */
export function getGspTierLadder(t: number, options?: { maxGsp?: number }): GspTierBoundary[] {
  // V17.1: a live upstream max reading (see gspLive.ts) replaces the
  // estimateMaxGsp ratio model when available — an actual observation beats
  // the captured-ratio estimate, and a few hours of staleness costs only
  // ~hundreds of GSP against bands tens of thousands wide.
  const max = options?.maxGsp ?? estimateMaxGsp(t);
  const elite = eliteThresholdGsp(t);

  const rows: GspTierBoundary[] = GSP_TIER_FRACTIONS.map(({ id, fraction }) => ({
    id,
    gsp: Math.round(max * fraction),
    topPercent: round1((1 - fraction) * 100),
  }));
  rows.push({
    id: 'elite',
    gsp: Math.round(elite),
    topPercent: round1((1 - elite / max) * 100),
  });

  return rows.sort((a, b) => b.gsp - a.gsp);
}

export interface GspTierPosition {
  /** The tier the reading sits in, or the 'below' sentinel (bottom 10%) when under every ladder row. */
  current: GspTierBoundary | { id: 'below'; gsp: 0; topPercent: 100 };
  /** The next tier up, or `null` at 'god' (nowhere left to climb). */
  next: GspTierBoundary | null;
  /** GSP still needed to reach `next` (`null` at the top). */
  gspToNext: number | null;
  /** 0–1 progress from the current tier's boundary toward `next` (`null` at the top). */
  progressToNext: number | null;
}

/** Locates a GSP reading on the ladder (see `getGspTierLadder`) and how far it is from the next tier up. */
export function getGspTierPosition(gsp: number, ladder: GspTierBoundary[]): GspTierPosition {
  const currentIndex = ladder.findIndex((row) => gsp >= row.gsp);

  if (currentIndex === 0) {
    return { current: ladder[0]!, next: null, gspToNext: null, progressToNext: null };
  }

  const current =
    currentIndex === -1
      ? ({ id: 'below', gsp: 0, topPercent: 100 } as const)
      : ladder[currentIndex]!;
  const next = currentIndex === -1 ? ladder[ladder.length - 1]! : ladder[currentIndex - 1]!;

  const span = next.gsp - current.gsp;
  const progress = span > 0 ? Math.min(Math.max((gsp - current.gsp) / span, 0), 1) : 1;

  return {
    current,
    next,
    gspToNext: Math.max(next.gsp - gsp, 0),
    progressToNext: progress,
  };
}
