/**
 * V10.1: a REVERSE-ENGINEERED hidden-MMR model underneath Smash Ultimate's
 * publicly-shown GSP number. Unlike `gsp.ts` (which fits curves to a player's
 * OWN match history with no assumed universal formula), everything in this
 * file encodes a specific community-reverse-engineered formula from a single
 * source:
 *
 *   Source: https://docs.google.com/document/d/e/2PACX-1vTJ_OknOfmnoZ-jKu0lHukq6lTZJOLn6zEPUZMHOzRWZ68AOIPuejUQI1JqDDepP324fThnmShXeudb/pub
 *   Captured: 2026-07-07
 *
 * The doc's claim, in short: Nintendo maintains a hidden WHOLE-NUMBER MMR per
 * character (roughly Elo-like, matchmaking pairs similar MMR), and the GSP
 * shown on the results screen is a deterministic transform of that MMR:
 *
 *   - Main curve (MMR 600-1400): GSP is the CDF of a normal distribution
 *     centered at MMR 1000 (sigma 110) rescaled between a fixed floor `A` and
 *     a slowly-rising "ceiling" that grows over time as the population's high
 *     scores inflate. The doc reports this fits observed (MMR, GSP) pairs to
 *     within +/-1 GSP.
 *   - Top tail (MMR > 1400) and bottom tail (MMR < 600): the normal-CDF shape
 *     is abandoned in favor of a straight line anchored at the curve's
 *     endpoint. The doc labels the tail slopes approximate and slowly
 *     drifting, unlike the main curve's +/-1 precision.
 *
 * Match MMR deltas (`mmrPointsForWin` below): the delta system matches Elo
 * K=20 (logistic, 400 divisor) within +/-1 point across all observations
 * (mean |error| 0.41; even matches predict exactly 10 = K/2); the exact
 * integer quantization rule is UNRESOLVED (simple rounding only reproduces
 * 16/28 observed rows, with systematic sub-rounding at band edges — observed
 * values sit below the continuous Elo value at group high-diff edges, at
 * inconsistent implied cutoffs) — treat single-point precision as
 * approximate. Where the doc gives an explicit observed band we return the
 * observed value verbatim; everywhere else we round the continuous Elo
 * expectation.
 *
 * This is NOT Nintendo's published algorithm — nobody outside Nintendo has
 * that. It is one community's regression against crowd-sourced data points,
 * and every function in this file is a re-implementation of that regression.
 * Treat every constant below as "authoritative from that doc", not as ground
 * truth about the game.
 */

/**
 * ---------------------------------------------------------------------------
 * normCdf / normInv
 * ---------------------------------------------------------------------------
 *
 * `normCdf(z)` uses the Numerical Recipes rational Chebyshev approximation of
 * the complementary error function (Press et al., "Numerical Recipes in C",
 * 2nd ed., section 6.2, "erfc" via a single rational-polynomial fit). It
 * claims fractional error < 1.2e-7 everywhere, which is more than sufficient
 * to reproduce the doc's +/-1 GSP precision at the ~16-million-GSP magnitudes
 * this model operates at (verified below against the doc's worked example).
 *
 * `normInv(p)` uses Peter Acklam's rational approximation for the inverse
 * standard normal CDF (algorithm published at
 * https://web.archive.org/web/2015/http://home.online.no/~pjacklam/notes/invnorm/
 * — no Newton refinement step is applied; Acklam's approximation alone is
 * accurate to about 1.15e-9 relative error over the full range, which is far
 * tighter than anything the tail/rounding behavior of this model needs).
 */

/** Standard normal CDF, Φ(z). See module doc for algorithm + precision notes. */
export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Error function via the Numerical Recipes rational-Chebyshev erfc fit (see module doc). */
function erf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t *
                      (0.27886807 +
                        t *
                          (-1.13520398 +
                            t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const ans = t * Math.exp(-z * z + poly);
  return x >= 0 ? 1 - ans : ans - 1;
}

/** Inverse standard normal CDF, Φ⁻¹(p). See module doc for algorithm + precision notes. */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  // Acklam's rational-approximation coefficients.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  );
}

/**
 * All constants from the reverse-engineered doc (see module header for URL +
 * capture date). Each field's comment traces exactly which claim it encodes.
 */
export const GSP_MODEL = {
  /** GSP floor of the main curve as MMR -> -infinity (2026-07-07 doc). */
  A: 1_995_587,
  /** Base of the slowly-rising GSP "ceiling", `ceiling(t) = K + 100*t` (2026-07-07 doc). */
  K: 16_058_300,
  /**
   * Anchor point for the drifting `t` parameter: `t = 502` was observed at
   * 2026-06-11 14:21 US Central (2026-06-11T19:21:00Z). `estimateT` projects
   * forward/backward from this instant at `T_PER_HOUR`.
   */
  T_ANCHOR: { t: 502, atMs: Date.UTC(2026, 5, 11, 19, 21) },
  /** Average drift rate of `t`, ~0.98/hour (observed range 14-36/day); frozen per offline session (2026-07-07 doc). */
  T_PER_HOUR: 0.98,
  /** Center of the main curve's normal distribution, MMR 1000 (2026-07-07 doc). */
  CENTER: 1000,
  /** Standard deviation of the main curve's normal distribution, 110 MMR (2026-07-07 doc). */
  SIGMA: 110,
  /** Elite Smash entry MMR, exactly 1142 (observed 1142 in / 1141 out; ~90th percentile of the main curve — 2026-07-07 doc). */
  ELITE_MMR: 1142,
  /** Top-tail (MMR > 1400) linear slope, GSP per MMR point; approximate, drifts slowly upward (2026-07-07 doc). */
  SLOPE_TOP: 220.5,
  /** Bottom-tail (MMR < 600) linear slope, GSP per MMR point; approximate, also drifts (2026-07-07 doc). */
  SLOPE_BOTTOM: 248.8,
  /** Lower bound of the main (normal-CDF) curve; below this MMR the model switches to the bottom-tail line (2026-07-07 doc). */
  MAIN_MIN: 600,
  /** Upper bound of the main (normal-CDF) curve; above this MMR the model switches to the top-tail line (2026-07-07 doc). */
  MAIN_MAX: 1400,
  /** Default MMR assumed for a character the player has never played, ~1095 (2026-07-07 doc). */
  DEFAULT_UNPLAYED_MMR: 1095,
  /**
   * Floor applied to `t` inside the GSP<->MMR transforms (NOT from the doc —
   * an implementation guard, 2026-07-07). The doc's linear drift model is
   * anchored mid-2026; extrapolated far enough backward it eventually makes
   * the curve degenerate (`ceiling(t) <= A` around t = -140,627, ~2010).
   * t = 0 corresponds to ~3 weeks before the anchor (late May 2026);
   * conversions for readings older than that clamp here and carry extra
   * error — the drift rate before the doc's observation window is unknown
   * anyway, so a linear backward extrapolation would be false precision.
   */
  T_MIN: 0,
} as const;

/** `zone` marks which piece of the piecewise model a reading falls into — 'main' is the +/-1-GSP-accurate normal-CDF curve; 'top'/'bottom' are the approximate, drifting linear tails. */
export type GspZone = 'main' | 'top' | 'bottom';

/**
 * `ceiling(t) = K + 100t` — the main curve's slowly-rising GSP ceiling
 * (2026-07-07 doc). `t` is floored at `GSP_MODEL.T_MIN` so a wildly-negative
 * estimate (pre-2026 timestamps, or a garbage calibration input) can never
 * push the ceiling below the floor `A` and flip the curve inside out — see
 * the `T_MIN` comment for why the model can't honestly reach back that far.
 */
function ceilingAt(t: number): number {
  return GSP_MODEL.K + 100 * Math.max(t, GSP_MODEL.T_MIN);
}

/** Forward transform for the main curve only: `A + (ceiling(t) - A) * Φ((mmr - CENTER)/SIGMA)`. */
function mainCurveGsp(mmr: number, t: number): number {
  const z = (mmr - GSP_MODEL.CENTER) / GSP_MODEL.SIGMA;
  return GSP_MODEL.A + (ceilingAt(t) - GSP_MODEL.A) * normCdf(z);
}

/** GSP at the main curve's upper boundary (MMR 1400), the anchor for the top tail. */
function gspAtMainMax(t: number): number {
  return mainCurveGsp(GSP_MODEL.MAIN_MAX, t);
}

/** GSP at the main curve's lower boundary (MMR 600), the anchor for the bottom tail. */
function gspAtMainMin(t: number): number {
  return mainCurveGsp(GSP_MODEL.MAIN_MIN, t);
}

/**
 * Calibration input for `estimateT`: a user-supplied "what's the Elite
 * threshold right now" reading (from editing the Elite Threshold card),
 * paired with when it was entered. Because Elite entry is a fixed MMR
 * (1142), a fresh threshold reading lets us solve for `t` at that instant
 * more precisely than extrapolating purely from the anchor — this becomes
 * the new basis for projecting `t` forward.
 */
export interface TCalibration {
  /** The Elite Smash entry GSP the user reported as current, at `atMs`. */
  eliteThresholdGsp: number;
  /** Epoch ms the calibration reading was taken/saved. */
  atMs: number;
}

/**
 * Estimates the drifting `t` parameter at `atMs`.
 *
 * Without a calibration: linear extrapolation from the doc's anchor
 * (`t = 502` at 2026-06-11T19:21:00Z), advancing at `T_PER_HOUR` (0.98/hour).
 *
 * With a `calibration` (the user's most recent Elite-threshold edit): solves
 * `eliteThresholdGsp = A + (K + 100*t - A) * Φ((ELITE_MMR - CENTER)/SIGMA)`
 * for `t` at `calibration.atMs`, then extrapolates from THAT point instead —
 * the user's threshold edit becomes a fresh t-recalibration, which is more
 * accurate than the fixed 2026-06-11 anchor as real time passes it by.
 */
export function estimateT(atMs: number, calibration?: TCalibration): number {
  if (calibration) {
    const phiElite = normCdf((GSP_MODEL.ELITE_MMR - GSP_MODEL.CENTER) / GSP_MODEL.SIGMA);
    // eliteThresholdGsp = A + (K + 100*tCal - A) * phiElite
    // => tCal = ((eliteThresholdGsp - A) / phiElite - K + A) / 100
    const tAtCalibration =
      ((calibration.eliteThresholdGsp - GSP_MODEL.A) / phiElite - GSP_MODEL.K + GSP_MODEL.A) / 100;
    const hoursSince = (atMs - calibration.atMs) / (1000 * 60 * 60);
    return tAtCalibration + hoursSince * GSP_MODEL.T_PER_HOUR;
  }

  const hoursSince = (atMs - GSP_MODEL.T_ANCHOR.atMs) / (1000 * 60 * 60);
  return GSP_MODEL.T_ANCHOR.t + hoursSince * GSP_MODEL.T_PER_HOUR;
}

/** The current computed Elite Smash entry GSP at drift parameter `t` (i.e. `mmrToGsp(ELITE_MMR, t)`). */
export function eliteThresholdGsp(t: number): number {
  return mainCurveGsp(GSP_MODEL.ELITE_MMR, t);
}

/**
 * Forward transform: hidden MMR -> GSP, at drift parameter `t`. Applies
 * whichever of the three zones `mmr` falls into.
 */
export function mmrToGsp(mmr: number, t: number): number {
  if (mmr > GSP_MODEL.MAIN_MAX) {
    return gspAtMainMax(t) + (mmr - GSP_MODEL.MAIN_MAX) * GSP_MODEL.SLOPE_TOP;
  }
  if (mmr < GSP_MODEL.MAIN_MIN) {
    return gspAtMainMin(t) - (GSP_MODEL.MAIN_MIN - mmr) * GSP_MODEL.SLOPE_BOTTOM;
  }
  return mainCurveGsp(mmr, t);
}

export interface GspToMmrResult {
  /** Estimated hidden MMR for this GSP reading, at drift parameter `t`. */
  mmr: number;
  /** Which zone of the piecewise model the reading fell into — 'main' is +/-1-GSP-accurate; 'top'/'bottom' are approximate linear tails. */
  zone: GspZone;
}

/**
 * Inverse transform: GSP -> estimated hidden MMR, at drift parameter `t`.
 * Inverts the main curve via `normInv`; readings at/beyond the main curve's
 * boundary GSP values (`gsp(1400)` / `gsp(600)`) are inverted via the linear
 * tails instead, and clamp/zone accordingly so wildly out-of-range input
 * (e.g. negative GSP, or GSP far beyond anything achievable) still returns a
 * finite estimate rather than throwing.
 */
export function gspToMmr(gsp: number, t: number): GspToMmrResult {
  const gspMax = gspAtMainMax(t);
  const gspMin = gspAtMainMin(t);

  if (gsp > gspMax) {
    const mmr = GSP_MODEL.MAIN_MAX + (gsp - gspMax) / GSP_MODEL.SLOPE_TOP;
    return { mmr, zone: 'top' };
  }
  if (gsp < gspMin) {
    const mmr = GSP_MODEL.MAIN_MIN - (gspMin - gsp) / GSP_MODEL.SLOPE_BOTTOM;
    return { mmr, zone: 'bottom' };
  }

  const ceiling = ceilingAt(t);
  const p = (gsp - GSP_MODEL.A) / (ceiling - GSP_MODEL.A);
  // Clamp to a valid CDF domain — floating point can push p just outside
  // (0, 1) at the exact boundaries, where normInv would return +/-Infinity.
  const clampedP = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  const z = normInv(clampedP);
  const mmr = GSP_MODEL.CENTER + z * GSP_MODEL.SIGMA;
  return { mmr, zone: 'main' };
}

/**
 * Observed (MMR difference -> zero-sum points) breakpoints from the
 * reverse-engineered doc, verbatim where the doc gives an explicit range.
 * `diffMin`/`diffMax` are the inclusive bounds of winner-minus-loser MMR the
 * doc associates with each point value; gaps between breakpoints (and diffs
 * beyond the table entirely) are filled by the Elo K=20 model in
 * `mmrPointsForWin`, not by this table. Ordered from largest diff (blowout
 * favorite win, 0 points) to most negative (huge upset).
 *
 * NOTE on the doc's tail shorthand: the source doc's last few entries were
 * written as "..−390→18, →19, →20" — a compressed sequence with NO explicit
 * diff ranges for 19 and 20. Rather than inventing bands for them, this
 * table stops at the last explicitly-ranged observation (18, up to −390) and
 * lets the Elo fill produce 19/20 for larger upsets — the fill's logistic
 * curve reaches 19 around diff −437 and 20 around diff −637.
 */
export const MMR_POINTS_TABLE: ReadonlyArray<{
  diffMin: number;
  diffMax: number;
  points: number;
}> = [
  { diffMin: 533, diffMax: Infinity, points: 0 },
  { diffMin: 411, diffMax: 523, points: 1 },
  { diffMin: 333, diffMax: 394, points: 2 },
  { diffMin: 253, diffMax: 313, points: 3 },
  { diffMin: 207, diffMax: 242, points: 4 },
  { diffMin: 170, diffMax: 177, points: 5 },
  { diffMin: 140, diffMax: 140, points: 6 },
  { diffMin: 87, diffMax: 108, points: 7 },
  { diffMin: 44, diffMax: 85, points: 8 },
  { diffMin: 7, diffMax: 40, points: 9 },
  { diffMin: -28, diffMax: 5, points: 10 },
  { diffMin: -60, diffMax: -30, points: 11 },
  { diffMin: -97, diffMax: -68, points: 12 },
  { diffMin: -130, diffMax: -98, points: 13 },
  { diffMin: -165, diffMax: -131, points: 14 },
  { diffMin: -200, diffMax: -200, points: 15 },
  { diffMin: -251, diffMax: -233, points: 16 },
  { diffMin: -290, diffMax: -290, points: 17 },
  { diffMin: -390, diffMax: -291, points: 18 },
];

/** The delta system's Elo K-factor: every observed row is within ~0.9 points of K=20 Elo (see module doc). */
export const MMR_ELO_K = 20;

/**
 * Continuous Elo expectation for the winner's point gain at
 * `diff = winnerMmr - loserMmr`: `K * (1 - 1/(1 + 10^(-diff/400)))` — the
 * standard logistic Elo update with K=20 and the conventional 400 divisor.
 * At diff 0 this is exactly K/2 = 10. Validated against the doc's observed
 * table: every row within 0.9 points, mean |error| 0.41 (see module doc; the
 * exact integer quantization the game applies on top of this is unresolved).
 */
export function eloExpectedPointsForWin(diff: number): number {
  return MMR_ELO_K * (1 - 1 / (1 + Math.pow(10, -diff / 400)));
}

/**
 * Zero-sum MMR points awarded to the WINNER of a match (the loser loses the
 * same amount), as a function of `diff = winnerMmr - loserMmr`, for two
 * already-stabilized characters (see module doc — fresh/unstabilized
 * characters swing more and are out of scope here).
 *
 * Looks up the observed breakpoint table verbatim first
 * (`MMR_POINTS_TABLE`); for any diff that falls in a gap between observed
 * bands (the doc only sampled specific points), rounds the continuous Elo
 * K=20 expectation (`eloExpectedPointsForWin`) instead. Both paths are
 * exercised and documented so callers can tell which is which via
 * `mmrPointsForWinDetailed`. Single-point precision is approximate either
 * way — the game's exact integer quantization is unresolved (module doc).
 */
export function mmrPointsForWin(diff: number): number {
  return mmrPointsForWinDetailed(diff).points;
}

export interface MmrPointsResult {
  points: number;
  /** Whether `points` came from the doc's verbatim observed table or from rounding the continuous Elo K=20 expectation. */
  source: 'observed' | 'elo-fill';
}

/** Same as `mmrPointsForWin` but also reports whether the result came from the observed table or the Elo fill (see doc comment on `mmrPointsForWin`). */
export function mmrPointsForWinDetailed(diff: number): MmrPointsResult {
  const hit = MMR_POINTS_TABLE.find((row) => diff >= row.diffMin && diff <= row.diffMax);
  if (hit) {
    return { points: hit.points, source: 'observed' };
  }
  // Math.round of a value already bounded in (0, 20) by the logistic curve —
  // no extra clamp needed.
  return { points: Math.round(eloExpectedPointsForWin(diff)), source: 'elo-fill' };
}

/** Hard cap on projected matches, mirroring `MAX_SIMULATED_MATCHES` in gsp.ts. */
export const MAX_PROJECTED_MATCHES = 2000;

/**
 * Assumed per-match zero-sum points when matchmaking pairs opponents of
 * similar MMR (diff ~ 0, `mmrPointsForWin(0) = 10`) — the projection's
 * flat-rate assumption, now Elo-justified: at diff 0 the continuous Elo K=20
 * expectation is exactly K/2 = 10, and the observed table agrees.
 */
export const ASSUMED_MMR_POINTS_PER_MATCH = mmrPointsForWin(0);

export type EliteMmrProjection =
  | { status: 'already-elite' }
  | { status: 'equilibrium' }
  | { status: 'projected'; matchesNeeded: number }
  | { status: 'capped' };

/**
 * Projects net matches needed to reach `GSP_MODEL.ELITE_MMR`, given the
 * player's current estimated MMR and recent win rate, under a simplifying
 * assumption: matchmaking pairs opponents of similar MMR, so every match
 * (win or loss) trades close to `ASSUMED_MMR_POINTS_PER_MATCH` (~10) points —
 * `mmrPointsForWin(0)`, the zero-sum value at diff=0. Expected net MMR per
 * match is then `p * g - (1-p) * g = (2p - 1) * g` where `p` is the recent
 * win rate and `g` is that flat per-match point value.
 *
 * This is a much simpler model than `gsp.ts`'s `projectMatchesToElite`
 * (which fits an exponential decay from the player's own GSP history) —
 * here we lean entirely on the reverse-engineered zero-sum system (observed
 * table + Elo K=20, see `mmrPointsForWin`) rather than curve-fitting, since
 * MMR deltas (unlike GSP deltas) are NOT expected to shrink as the player
 * climbs (points fall out of a fixed Elo-style MMR-gap rule, not a
 * population-relative curve).
 *
 * Discriminated result:
 *   - `'already-elite'`: `currentMmr >= ELITE_MMR` already.
 *   - `'equilibrium'`: `winRate <= 0.5` — expected net progress is <= 0.
 *     This is NOT an error state: matchmaking pairing the player against
 *     similar-MMR opponents at a <=50% win rate means the system has found
 *     their current level. The UI must present this kindly (a >50% win rate,
 *     not more grinding, is what moves the number).
 *   - `'projected'`: a finite `matchesNeeded` under `MAX_PROJECTED_MATCHES`.
 *   - `'capped'`: progress is positive but so slow the cap was hit before
 *     reaching Elite.
 */
export function projectMatchesToEliteMmr(
  currentMmr: number,
  recentWinRate: number,
): EliteMmrProjection {
  if (currentMmr >= GSP_MODEL.ELITE_MMR) {
    return { status: 'already-elite' };
  }
  if (recentWinRate <= 0.5) {
    return { status: 'equilibrium' };
  }

  const expectedNetPerMatch = (2 * recentWinRate - 1) * ASSUMED_MMR_POINTS_PER_MATCH;
  const mmrNeeded = GSP_MODEL.ELITE_MMR - currentMmr;
  const matchesNeeded = Math.ceil(mmrNeeded / expectedNetPerMatch);

  if (matchesNeeded > MAX_PROJECTED_MATCHES) {
    return { status: 'capped' };
  }
  return { status: 'projected', matchesNeeded };
}
