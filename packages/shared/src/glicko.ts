import type { Match } from './match.js';

/**
 * Glicko-2 rating system (Mark Glickman,
 * http://www.glicko.net/glicko/glicko2.pdf), implemented generally per the
 * paper's "Step" numbering in `updateRating` below, then applied to this
 * app's matches via a **session-based rating-period model** documented at
 * the bottom of this file.
 *
 * All internal math (the "glicko scale", `mu`/`phi`/`sigma`) is kept
 * unrounded; only the public "display" values (`rating`, `rd`) are rounded,
 * per Glickman's own recommendation to round only for presentation.
 *
 * Moved here from apps/web (V7-D) so the API can compute the same ratings
 * server-side for group leaderboards — there must be exactly one
 * implementation. `apps/web/src/lib/glicko.ts` re-exports these names
 * unchanged; `apps/web/src/lib/stats.ts`'s `getSessions` delegates to the
 * `splitIntoSessions` helper below rather than forking the split logic.
 */

// ---------------------------------------------------------------------------
// Constants (Glickman's paper, Step 1 / "Example")
// ---------------------------------------------------------------------------

/** System constant that limits volatility change; Glickman suggests 0.3-1.2, most implementations (and the paper's example) use 0.5. */
export const TAU = 0.5;
/** Default rating for a new/unrated player. */
export const DEFAULT_RATING = 1500;
/** Default rating deviation for a new/unrated player. */
export const DEFAULT_RD = 350;
/** Default volatility for a new/unrated player. */
export const DEFAULT_VOLATILITY = 0.06;
/** Glicko-1 -> Glicko-2 scale factor ("173.7178" in the paper). */
export const GLICKO_SCALE = 173.7178;

/** Convergence tolerance for the volatility-update iterative algorithm (Step 5, Illinois algorithm). */
const CONVERGENCE_EPSILON = 0.000001;

// ---------------------------------------------------------------------------
// Core Glicko-2 rating state and single-period update
// ---------------------------------------------------------------------------

export interface GlickoRating {
  /** Rating on the familiar Glicko/Elo-like scale (~1500-centered). */
  rating: number;
  /** Rating deviation on the same scale — the +/- uncertainty band. */
  rd: number;
  /** Volatility: expected fluctuation in the player's rating over time. */
  volatility: number;
}

/** Internal Glicko-2 scale representation of a `GlickoRating` (Step 2). */
interface GlickoInternal {
  mu: number;
  phi: number;
  sigma: number;
}

function toInternal(r: GlickoRating): GlickoInternal {
  return {
    mu: (r.rating - DEFAULT_RATING) / GLICKO_SCALE,
    phi: r.rd / GLICKO_SCALE,
    sigma: r.volatility,
  };
}

function toExternal(g: GlickoInternal): GlickoRating {
  return {
    rating: DEFAULT_RATING + GLICKO_SCALE * g.mu,
    rd: GLICKO_SCALE * g.phi,
    volatility: g.sigma,
  };
}

/** A single game result within a rating period, from the perspective of the player being rated. */
export interface GlickoOpponentResult {
  /** The opponent's rating at the start of the period (Glicko scale). */
  opponentRating: number;
  /** The opponent's rating deviation at the start of the period (Glicko scale). */
  opponentRd: number;
  /** 1 = win, 0.5 = draw, 0 = loss (Step 3's `s`). */
  score: 0 | 0.5 | 1;
}

/** Glicko-2's `g(phi)` (Step 3): de-weights an opponent's rating by their uncertainty. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Glicko-2's `E(mu, mu_j, phi_j)` (Step 3): expected score against an opponent. */
function E(mu: number, muOpponent: number, phiOpponent: number): number {
  return 1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent)));
}

/**
 * Applies one Glicko-2 rating period update (Steps 3-8 of Glickman's paper)
 * for a single player against zero or more opponent results in that period.
 *
 * With zero games, only Step 6 (RD growth for not having competed) applies —
 * rating and volatility are unchanged, RD grows toward the uncertainty
 * ceiling. This matches the paper's guidance for players who sit out a
 * rating period.
 */
export function updateRating(
  before: GlickoRating,
  results: GlickoOpponentResult[],
  tau = TAU,
): GlickoRating {
  const player = toInternal(before);

  if (results.length === 0) {
    // Step 6: no games played this period — only phi grows.
    const phiStar = Math.sqrt(player.phi * player.phi + player.sigma * player.sigma);
    return toExternal({ mu: player.mu, phi: phiStar, sigma: player.sigma });
  }

  const opponents = results.map((r) => ({
    ...toInternal({ rating: r.opponentRating, rd: r.opponentRd, volatility: 0 }),
    score: r.score,
  }));

  // Step 3: estimated variance of the rating from the game outcomes, `v`.
  let vInv = 0;
  for (const opp of opponents) {
    const gPhi = g(opp.phi);
    const e = E(player.mu, opp.mu, opp.phi);
    vInv += gPhi * gPhi * e * (1 - e);
  }
  const v = 1 / vInv;

  // Step 4: estimated improvement in rating, `delta`.
  let deltaSum = 0;
  for (const opp of opponents) {
    const gPhi = g(opp.phi);
    const e = E(player.mu, opp.mu, opp.phi);
    deltaSum += gPhi * (opp.score - e);
  }
  const delta = v * deltaSum;

  // Step 5: new volatility sigma', via the paper's iterative (Illinois) algorithm.
  const a = Math.log(player.sigma * player.sigma);
  const deltaSq = delta * delta;
  const phiSq = player.phi * player.phi;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (deltaSq - phiSq - v - ex);
    const den = 2 * (phiSq + v + ex) * (phiSq + v + ex);
    return num / den - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE_EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  // Step 6: new pre-rating-period value, phiStar.
  const phiStar = Math.sqrt(phiSq + sigmaNew * sigmaNew);

  // Step 7: new phi and mu.
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = player.mu + phiNew * phiNew * deltaSum;

  return toExternal({ mu: muNew, phi: phiNew, sigma: sigmaNew });
}

// ---------------------------------------------------------------------------
// Session splitting — extracted from web's stats.ts `getSessions`, which
// delegates to `splitIntoSessions` below so there is exactly one
// session-splitting implementation shared between the Dashboard/Trends UI
// and this module's `computeRatingHistory`. Kept minimal here (chronological
// grouping only) — `getSessions`'s richer `SessionStats` (win/loss/streak
// aggregates) stays in web's stats.ts, built on top of these groups.
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * Groups matches into play sessions: a gap of more than `gapMs` (default 3h)
 * between consecutive matches starts a new session. Chronological order.
 * Returns each session as its own chronologically-sorted `Match[]`.
 */
export function splitIntoSessions(matches: Match[], gapMs = DEFAULT_SESSION_GAP_MS): Match[][] {
  const sorted = [...matches].sort((a, b) => a.time - b.time);
  const groups: Match[][] = [];
  for (const match of sorted) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (current && previous && match.time - previous.time <= gapMs) {
      current.push(match);
    } else {
      groups.push([match]);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Session-based rating history for this app's matches
//
// MODEL (documented per the task spec): start.gg opponents are transient,
// unrated "pools" we have no persistent rating for — there is no stable
// opponent-rating population to run a conventional two-sided Glicko-2
// ladder against. Instead, each RATING PERIOD is one play session (grouped
// via `splitIntoSessions`'s default gap, matching the "Sessions" model
// already used elsewhere in the dashboard). Within a period, every game is
// modeled as a game against a SYNTHETIC opponent whose rating equals the
// player's OWN pre-period rating and whose RD is the maximal uncertainty
// value (`DEFAULT_RD`, 350) — an "uncertainty-maximal opponent proxy".
// Playing this synthetic mirror-opponent means:
//   - a period with more wins than losses raises the rating (self-referential
//     overperformance is rewarded), a losing period lowers it;
//   - the proxy's high RD (350) keeps each period's rating swing modest —
//     it never treats the self-match as a high-information game the way a
//     precisely-known opponent would;
//   - RD still shrinks with consistent play (Step 7).
// Additionally, the gap BETWEEN sessions matters: if more than one
// rating-period's worth of time (`gapMs`, the same threshold used to split
// sessions) elapses between the end of one session and the start of the
// next, we synthesize that many "no games played" periods (Step 6 only —
// rating and volatility held fixed, RD grows toward the ceiling) before
// scoring the next session. This is standard Glicko practice for players who
// sit out whole rating periods, and is what makes RD grow across long
// inactivity gaps rather than only ever shrinking. The synthetic idle-period
// count is capped (`MAX_IDLE_PERIODS`) since RD saturates at `DEFAULT_RD`
// well before that and there's no value in looping further for huge gaps
// (e.g. a year of inactivity).
// This is intentionally a proxy/self-referential rating, not a competitive
// ladder rating comparable across players — the "unofficial" caption on the
// Dashboard card reflects that.
// ---------------------------------------------------------------------------

/** Upper bound on synthesized idle (zero-game) periods between two sessions; RD saturates at DEFAULT_RD long before this. */
const MAX_IDLE_PERIODS = 50;

/**
 * Default rating-period length, in ms — the same "how long counts as a
 * break" threshold used by session grouping.
 */
const DEFAULT_RD_GAP_MS = 3 * 60 * 60 * 1000;

export interface RatingPeriodResult {
  start: number;
  end: number;
  games: number;
  /** Rounded display rating as of the end of this period. */
  rating: number;
  /** Rounded display RD as of the end of this period. */
  rd: number;
  /** Volatility as of the end of this period (unrounded — small by design). */
  volatility: number;
}

export interface RatingHistory {
  periods: RatingPeriodResult[];
  current: { rating: number; rd: number; volatility: number } | null;
}

/**
 * Computes a Glicko-2 rating history over `matches`, treating each play
 * session (via `splitIntoSessions(matches, gapMs)`) as one rating period. See
 * the model documentation above for how within-period games are scored.
 *
 * Sessions are processed in chronological order. Returns an empty `periods`
 * array and `current: null` when there are no matches.
 */
export function computeRatingHistory(matches: Match[], gapMs?: number): RatingHistory {
  const effectiveGapMs = gapMs ?? DEFAULT_RD_GAP_MS;
  const sessions = splitIntoSessions(matches, effectiveGapMs);

  if (sessions.length === 0) {
    return { periods: [], current: null };
  }

  let current: GlickoRating = {
    rating: DEFAULT_RATING,
    rd: DEFAULT_RD,
    volatility: DEFAULT_VOLATILITY,
  };

  const periods: RatingPeriodResult[] = [];
  let previousEnd: number | null = null;

  for (const session of sessions) {
    const start = session[0]!.time;
    const end = session[session.length - 1]!.time;

    // Synthesize idle (zero-game) rating periods for the gap since the
    // previous session, so RD grows across inactivity (Step 6) rather than
    // only ever shrinking. One idle period per `effectiveGapMs` elapsed,
    // capped at MAX_IDLE_PERIODS.
    if (previousEnd !== null) {
      const idleMs = start - previousEnd;
      const idlePeriods = Math.min(MAX_IDLE_PERIODS, Math.floor(idleMs / effectiveGapMs));
      for (let i = 0; i < idlePeriods; i++) {
        current = updateRating(current, []);
      }
    }

    const wins = session.filter((m) => m.win).length;
    const losses = session.length - wins;
    const games = wins + losses;
    const preRating = current.rating;
    const results: GlickoOpponentResult[] = Array.from({ length: games }, (_, i) => {
      // Reconstruct win/loss order isn't preserved by the session grouping,
      // but Glicko-2's period update is order-independent (Steps 3-4 only
      // sum over the period's games), so any per-game breakdown that yields
      // the right win/loss counts is mathematically equivalent.
      const isWin = i < wins;
      return {
        opponentRating: preRating,
        opponentRd: DEFAULT_RD,
        score: isWin ? 1 : 0,
      };
    });

    current = updateRating(current, results);
    previousEnd = end;
    periods.push({
      start,
      end,
      games,
      rating: Math.round(current.rating),
      rd: Math.round(current.rd),
      volatility: current.volatility,
    });
  }

  return {
    periods,
    current: {
      rating: Math.round(current.rating),
      rd: Math.round(current.rd),
      volatility: current.volatility,
    },
  };
}
