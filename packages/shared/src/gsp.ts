import { z } from 'zod';
import type { Match } from './match.js';

/**
 * GSP (Global Smash Power) is Smash Ultimate's online quickplay ranking: the
 * number of players you're estimated to outrank, derived from a hidden
 * Elo-like rating over a roughly-normal skill distribution. Nintendo never
 * published the formula (sources: ssbwiki.com/Global_Smash_Power,
 * smashboards.com/threads/how-gsp-works.511478/). Two consequences we model
 * in this file, both straight from that research:
 *
 *   1. Gains per win SHRINK as GSP grows — you're further into the bell
 *      curve's tail, so each win outranks a smaller slice of the remaining
 *      population. `projectMatchesToElite` fits this shrinkage from the
 *      player's own history rather than assuming a fixed formula.
 *   2. A fresh character's first few matches swing wildly (small sample
 *      against a rating system that hasn't converged yet) — reflected here
 *      by treating a handful of gain observations as too little to trust a
 *      curve fit (see `MIN_OBSERVATIONS_FOR_DECAY_FIT` below).
 *
 * GSP is PER CHARACTER — every function here takes a specific `fighterId`
 * and only looks at matches for that fighter.
 *
 * Everything derived here is an ESTIMATE. There is no public GSP API and
 * projections are simulations built on a curve fit to a handful of data
 * points — the UI must present them as such.
 */

/**
 * `gspSettings/{uid}` — the user-maintained "what does Elite Smash require
 * right now" threshold. There is no public Elite Smash API: entry cutoffs
 * are estimated by the community (elitegsp.com aggregates crowd-sourced
 * submissions) and drift upward roughly continuously as more players clear
 * the bar. We link out to elitegsp.com with attribution rather than scrape
 * it, and let the user type in (and periodically update) the number
 * themselves.
 */
export const gspSettingsSchema = z.object({
  /** The user's current best estimate of their fighter's Elite Smash entry threshold. */
  eliteThreshold: z.number().int().positive(),
  /** Epoch ms this was last saved — server-stamped, drives the "as of" date in the UI. */
  updatedAt: z.number(),
});
export type GspSettings = z.infer<typeof gspSettingsSchema>;

/** PUT /api/gsp-settings body — `updatedAt` is server-stamped, same convention as `opponentNoteSchema`. */
export const upsertGspSettingsInputSchema = gspSettingsSchema.omit({ updatedAt: true });
export type UpsertGspSettingsInput = z.infer<typeof upsertGspSettingsInputSchema>;

/**
 * Placeholder default Elite Smash threshold for a brand-new user who hasn't
 * set their own yet. Elite cutoffs vary a lot by character popularity and
 * climb ~200-300k/week (per elitegsp.com's tracked history around the time
 * this was written, mid-2024) — this is a plausible mid-pack magnitude for a
 * moderately popular character, NOT a real-time figure. It exists purely so
 * the "distance to Elite" card has something to render before the user edits
 * it; the UI always shows the "check elitegsp.com" link + last-updated date
 * alongside it so the placeholder nature is obvious.
 */
export const DEFAULT_ELITE_THRESHOLD = 10_300_000;

/** One chronological GSP reading for a specific fighter. */
export interface GspPoint {
  /** Epoch ms of the match this reading came from. */
  time: number;
  /** The post-match GSP reading. */
  gsp: number;
  /** Whether that match was a win. */
  win: boolean;
}

/**
 * The chronological matches behind a fighter's GSP series — same filter and
 * ordering as `getGspSeries`, but returning the full `Match` records.
 * Index-parity with the series is guaranteed (the series is derived from
 * this), which is what lets a chart click on point `i` resolve to the match
 * to edit/delete.
 */
export function getGspMatches(matches: Match[], fighterId: number): Match[] {
  return matches
    .filter((m) => m.fighter_id === fighterId && m.gsp !== undefined)
    .sort((a, b) => a.time - b.time);
}

/**
 * Chronological GSP readings for `fighterId`, built from every match that
 * carries a `gsp` value for that fighter. Matches without a `gsp` reading
 * (offline sets, or online sets the player didn't log GSP for) are skipped
 * entirely rather than interpolated — we only ever plot/analyze real
 * readings.
 */
export function getGspSeries(matches: Match[], fighterId: number): GspPoint[] {
  return getGspMatches(matches, fighterId).map((m) => ({
    time: m.time,
    gsp: m.gsp!,
    win: m.win,
  }));
}

/** One step between two consecutive GSP readings. */
interface GspStep {
  /** GSP level the step started from (used as the x-value when fitting decay). */
  fromGsp: number;
  /** Signed change in GSP for this step (positive on a win-step, typically negative on a loss-step). */
  delta: number;
  win: boolean;
}

function toSteps(series: GspPoint[]): GspStep[] {
  const steps: GspStep[] = [];
  for (let i = 1; i < series.length; i += 1) {
    steps.push({
      fromGsp: series[i - 1]!.gsp,
      delta: series[i]!.gsp - series[i - 1]!.gsp,
      win: series[i]!.win,
    });
  }
  return steps;
}

/** Average of a number array, or `null` for an empty array. */
function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Simple trend label for the sequence of per-win gains over time: fits a
 * least-squares line against step index and reports whether the slope is
 * meaningfully negative (shrinking, the expected GSP pattern), meaningfully
 * positive (growing), or flat. "Meaningful" is anchored to the sequence's own
 * average gain so the threshold scales with the player's GSP bracket rather
 * than a fixed magnitude.
 */
function gainTrend(gains: number[]): 'shrinking' | 'growing' | 'flat' {
  if (gains.length < 2) return 'flat';
  const n = gains.length;
  const xMean = (n - 1) / 2;
  const yMean = gains.reduce((sum, v) => sum + v, 0) / n;
  let num = 0;
  let den = 0;
  gains.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) * (x - xMean);
  });
  const slope = den === 0 ? 0 : num / den;
  const scale = Math.abs(yMean) || 1;
  const relativeSlope = (slope * n) / scale;
  if (relativeSlope < -0.15) return 'shrinking';
  if (relativeSlope > 0.15) return 'growing';
  return 'flat';
}

export interface GspGainStats {
  /** Average GSP gained on a win-step, over the whole series. `null` when there are no win-steps. */
  avgGainPerWinLifetime: number | null;
  /** Average GSP lost on a loss-step, over the whole series (positive magnitude). `null` when there are no loss-steps. */
  avgDropPerLossLifetime: number | null;
  /** Same as `avgGainPerWinLifetime`, restricted to the last 20 steps. */
  avgGainPerWinLast20: number | null;
  /** Same as `avgDropPerLossLifetime`, restricted to the last 20 steps. */
  avgDropPerLossLast20: number | null;
  /** The single largest GSP gain observed on any win-step. `null` when there are no win-steps. */
  biggestGain: number | null;
  /** The single largest GSP drop (magnitude) observed on any loss-step. `null` when there are no loss-steps. */
  biggestDrop: number | null;
  /** Chronological per-win gains (for sparking/bar-charting the shrink over time). */
  perWinGains: number[];
  /** Whether per-win gains are trending down (expected as GSP climbs), up, or flat. */
  gainTrend: 'shrinking' | 'growing' | 'flat';
}

const LAST_N = 20;

/** Derives win/loss gain statistics from a chronological `GspPoint[]` (see `getGspSeries`). */
export function getGspGainStats(series: GspPoint[]): GspGainStats {
  const steps = toSteps(series);
  const winSteps = steps.filter((s) => s.win);
  const lossSteps = steps.filter((s) => !s.win);
  const last20Steps = steps.slice(-LAST_N);
  const last20WinSteps = last20Steps.filter((s) => s.win);
  const last20LossSteps = last20Steps.filter((s) => !s.win);

  const winGains = winSteps.map((s) => s.delta);
  const lossDrops = lossSteps.map((s) => -s.delta);

  return {
    avgGainPerWinLifetime: average(winGains),
    avgDropPerLossLifetime: average(lossDrops),
    avgGainPerWinLast20: average(last20WinSteps.map((s) => s.delta)),
    avgDropPerLossLast20: average(last20LossSteps.map((s) => -s.delta)),
    biggestGain: winGains.length > 0 ? Math.max(...winGains) : null,
    biggestDrop: lossDrops.length > 0 ? Math.max(...lossDrops) : null,
    perWinGains: winGains,
    gainTrend: gainTrend(winGains),
  };
}

/** Minimum win-gain observations required to fit the exponential decay curve; below this the model would be overfit to noise. */
export const MIN_OBSERVATIONS_FOR_DECAY_FIT = 5;
/** Below this many win-gain observations, projection is impossible even with the cruder fallback — the "insufficient data" floor. */
export const MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK = 2;
/** Hard cap on simulated matches — beyond this we just say "more than N". */
export const MAX_SIMULATED_MATCHES = 2000;

export interface EliteProjection {
  /** Simulated number of matches until GSP reaches the threshold, or `null` when the cap was hit (see `matchesNeededLabel`). */
  matchesNeeded: number | null;
  /** Human-facing label: the number, or `"more than 2000"` when the simulation cap was hit. */
  matchesNeededLabel: string;
  /** Whether the projection used the full exponential-decay fit, or the cruder linear-average fallback (few observations). */
  model: 'exponential-decay' | 'linear-average';
  assumptions: string[];
}

/**
 * Least-squares fit of `ln(gain) = ln(a) + b * gsp` over win-steps, i.e. an
 * exponential decay `gain(gsp) = a * exp(b * gsp)` of per-win GSP gain as a
 * function of the GSP level the win happened at — modeling the "gains shrink
 * as you climb" behavior described at the top of this file, fit from the
 * player's OWN history rather than any assumed universal formula.
 *
 * Returns `null` when the fit is degenerate: fewer than
 * `MIN_OBSERVATIONS_FOR_DECAY_FIT` win-steps, non-positive gains (can't take
 * a log), all `fromGsp` values identical (no x-variance to regress against),
 * or a fitted decay rate `b >= 0` (not actually decaying — the model doesn't
 * apply, so we fall back rather than project using a curve that predicts
 * gains INCREASING with GSP).
 */
export function fitGainDecay(winSteps: GspStep[]): { a: number; b: number } | null {
  if (winSteps.length < MIN_OBSERVATIONS_FOR_DECAY_FIT) return null;
  if (winSteps.some((s) => s.delta <= 0)) return null;

  const xs = winSteps.map((s) => s.fromGsp);
  const ys = winSteps.map((s) => Math.log(s.delta));
  const n = xs.length;
  const xMean = xs.reduce((sum, v) => sum + v, 0) / n;
  const yMean = ys.reduce((sum, v) => sum + v, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - xMean) * (ys[i]! - yMean);
    den += (xs[i]! - xMean) * (xs[i]! - xMean);
  }
  if (den === 0) return null;

  const b = num / den;
  const lnA = yMean - b * xMean;
  const a = Math.exp(lnA);

  if (!Number.isFinite(a) || !Number.isFinite(b) || b >= 0) return null;
  return { a, b };
}

/**
 * Projects how many more matches (at `recentWinRate`) it should take the
 * player to reach `threshold` GSP for the fighter behind `series`.
 *
 * Model selection, from the player's own win-step history:
 *   - >= `MIN_OBSERVATIONS_FOR_DECAY_FIT` win-gain observations that fit a
 *     valid exponential decay (see `fitGainDecay`): simulate forward,
 *     re-deriving the expected per-win gain at the CURRENT GSP level each
 *     match from the fitted curve (so gains keep shrinking as GSP climbs
 *     during the simulation itself, not just at the starting point). Loss
 *     drops are held constant at the lifetime average loss drop — the
 *     "shrinks with GSP" behavior is specifically documented for gains, not
 *     losses, and we don't have enough evidence to fit a second curve.
 *   - Between `MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK` and
 *     `MIN_OBSERVATIONS_FOR_DECAY_FIT` observations (or a decay fit that
 *     comes back degenerate): a cruder flat-average projection — average gain
 *     per win and average drop per loss, held constant for every simulated
 *     match. Labeled `'linear-average'` so the UI can call it out as cruder.
 *   - Fewer than `MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK` observations, or a
 *     zero/negative recent win rate (the player would never climb): returns
 *     `null` (unprojectable).
 *   - Already at/above the threshold: returns `null` (the UI shows an
 *     already-Elite celebration state instead of a projection).
 *
 * Simulation is capped at `MAX_SIMULATED_MATCHES`; hitting the cap without
 * reaching the threshold reports `matchesNeeded: null` /
 * `matchesNeededLabel: "more than 2000"` rather than an unbounded loop.
 */
export function projectMatchesToElite(
  series: GspPoint[],
  threshold: number,
  recentWinRate: number,
): EliteProjection | null {
  if (series.length === 0) return null;
  const currentGsp = series[series.length - 1]!.gsp;
  if (currentGsp >= threshold) return null; // already Elite — celebration state, not a projection
  if (recentWinRate <= 0) return null; // can never climb at a 0% win rate

  const steps = toSteps(series);
  const winSteps = steps.filter((s) => s.win);
  const lossSteps = steps.filter((s) => !s.win);
  if (winSteps.length < MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK) return null;

  const avgLossDrop = average(lossSteps.map((s) => -s.delta)) ?? 0;
  const decay = fitGainDecay(winSteps);

  const assumptions = [
    'GSP’s exact formula is not public — this is a simulation based on your own recent gains/losses, not Nintendo’s algorithm.',
    `Assumes you keep winning ${Math.round(recentWinRate * 100)}% of matches (your recent rate) and threshold ${threshold.toLocaleString()} from your Elite Smash setting.`,
  ];

  let gsp = currentGsp;
  let matches = 0;
  let model: EliteProjection['model'];

  if (decay) {
    model = 'exponential-decay';
    assumptions.push(
      'Models your per-win GSP gain as shrinking exponentially the higher your GSP climbs (fit from your own match history), while loss drops are held at your average.',
    );
    while (gsp < threshold && matches < MAX_SIMULATED_MATCHES) {
      const expectedGainAtGsp = decay.a * Math.exp(decay.b * gsp);
      const expectedStep = recentWinRate * expectedGainAtGsp - (1 - recentWinRate) * avgLossDrop;
      if (expectedStep <= 0) {
        // Decay + loss rate would stall or reverse progress entirely — no
        // finite projection is meaningful under this model.
        return null;
      }
      gsp += expectedStep;
      matches += 1;
    }
  } else {
    model = 'linear-average';
    assumptions.push(
      'Too few wins to fit a shrinking-gains curve yet, so this uses a simpler flat average of your recent per-win gain instead — cruder, and more likely to be optimistic as your GSP grows.',
    );
    const avgGain = average(winSteps.map((s) => s.delta)) ?? 0;
    const expectedStep = recentWinRate * avgGain - (1 - recentWinRate) * avgLossDrop;
    if (expectedStep <= 0) return null;
    while (gsp < threshold && matches < MAX_SIMULATED_MATCHES) {
      gsp += expectedStep;
      matches += 1;
    }
  }

  const capped = matches >= MAX_SIMULATED_MATCHES && gsp < threshold;
  return {
    matchesNeeded: capped ? null : matches,
    matchesNeededLabel: capped ? `more than ${MAX_SIMULATED_MATCHES}` : String(matches),
    model,
    assumptions,
  };
}
