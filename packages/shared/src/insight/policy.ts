import { ABSTENTION_FLOOR_GAMES, CONFIDENCE_TIER_BOUNDS } from '../evidence/policy.js';

/**
 * The ONE threshold source for the insight engine (D-06, D-07, D-15,
 * mirroring `evidence/policy.ts`'s own doc comment). Every gating/windowing
 * function under `packages/shared/src/insight/` imports its numbers from
 * here rather than hardcoding them. `ABSTENTION_FLOOR_GAMES` and
 * `CONFIDENCE_TIER_BOUNDS` are IMPORTED from `evidence/policy.ts`, never
 * re-declared, so the two engines can never silently drift on the same
 * numbers (mirrors `evidence/policy.ts:11-16`'s own alignment convention).
 */
export const INSIGHT_POLICY_VERSION = 1;

/** D-07: Trend only asserts a direction once the recent sample reaches the medium confidence tier. */
export const TREND_MIN_RECENT_GAMES = CONFIDENCE_TIER_BOUNDS.medium;

/** D-07: a Suggestion needs the claim it rests on to be high tier — no "early read" suggestions at medium. */
export const SUGGESTION_MIN_GAMES = CONFIDENCE_TIER_BOUNDS.high;

/** D-06: when the recent window covers this share of the baseline games (or more), the two horizons collapse into one figure with no delta chip. */
export const HORIZON_COLLAPSE_RATIO = 0.6;

/** D-15: for a scoped subject (one opponent character, one player, one stage) the recent window is additionally bounded to this many trailing months. */
export const SCOPED_RECENCY_MONTHS = 12;

/** D-06: the `last30` horizon's game count. */
export const RECENT_GAME_WINDOW = 30;

/** D-06: the `last90` horizon's day count. */
export const RECENT_DAY_WINDOW = 90;

/** D-07: at most this many cards per rail — the multiple-comparisons guard. */
export const RAIL_CARD_CAP = 3;

/** DD-08: at most this many meters inside one merged `UnlocksNext` result. */
export const UNLOCKS_NEXT_METER_CAP = 3;

/** The z-score for every two-sided Wilson interval this engine computes (≈95% — the same value `evidence/rank.ts`'s one-sided `wilsonLowerBound` defaults to). */
export const WILSON_Z = 1.96;

/**
 * DD-12 (UI-SPEC §17.4, plan A-01-1): the two-proportion z test for
 * non-recency cohort gaps (e.g. `SettingGap`'s online/offline comparison) is
 * the sketch designer's proposal, adopted here as a VERSIONED ENGINEERING
 * DEFAULT under `INSIGHT_POLICY_VERSION` — not an owner-locked decision. A
 * wrong constant here produces an over-conservative "steady" read, never a
 * false claim (RESEARCH.md Open Question 3). A later revision may retune it;
 * that revision bumps `INSIGHT_POLICY_VERSION`.
 */
export const COHORT_NOTABLE_Z = 1.96;
/** DD-12: both sides of a cohort comparison must reach at least this many games before a gap is ever tested. */
export const COHORT_MIN_SIDE_GAMES = CONFIDENCE_TIER_BOUNDS.medium;

/**
 * Salience scoring weights (`salience.ts`'s `scoreInsight`), documented here
 * as tunable engine policy rather than buried inline in the scoring
 * function. Retuning these changes card ORDER only, never a claim (plan
 * A-01-2) — salience is never rendered (UI-SPEC §7.8 rule 1).
 */
export const SALIENCE_WEIGHTS = {
  /** Weight applied to the absolute delta in points (0 when `deltaPoints` is null). */
  absDelta: 2,
  /** Weight applied to `Math.log(recentGames + 1)`. */
  logRecentSample: 3,
  /** Weight applied to the recent claim's confidence-tier rank (0 = none, 1 = low, 2 = medium, 3 = high). */
  confidenceTier: 5,
  /** Weight applied to the recency factor (`1 / (1 + ageInDays)`, derived from `window.toMs` vs. the caller's `nowMs`). */
  recency: 1,
} as const;

export { ABSTENTION_FLOOR_GAMES };
