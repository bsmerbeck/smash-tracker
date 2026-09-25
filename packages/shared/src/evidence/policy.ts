import type { ConfidenceTier, RecencyTreatment } from './types.js';

/**
 * The ONE threshold source for the evidence engine (D-05, D-24). Every
 * ranking/gating function in this package imports its numbers from here
 * rather than hardcoding them — a threshold that drifts between two call
 * sites is exactly the SS5 "Town and City 2-0" defect class this module
 * exists to close. If you're about to write a bare `3`, a bare `8`, or a
 * bare `20` anywhere under `evidence/`, it belongs here instead.
 *
 * `CONFIDENCE_TIER_BOUNDS.medium` (8) and `matchupAdvisor.ts`'s
 * `CONFIDENCE_HALF_SAMPLE` (8) carry the same value deliberately — plan
 * 36-02 Task 2 makes that alignment MECHANICAL by having `matchupAdvisor.ts`
 * import `CONFIDENCE_TIER_BOUNDS.medium` directly. A comment alone would not
 * enforce that alignment (R1-LOW-2) — this comment states the intent, the
 * import in 36-02 is what actually enforces it.
 */
export const EVIDENCE_POLICY_VERSION = 1;

/** D-07: no ranked/recommended claim may rest on fewer than this many countable games, no matter what a caller passes. */
export const ABSTENTION_FLOOR_GAMES = 3;

/** Countable-game thresholds for each confidence tier (inclusive lower bounds). Below `low` is no tier at all — abstained. */
export const CONFIDENCE_TIER_BOUNDS = { low: 3, medium: 8, high: 20 } as const;

/** D-11: the min-matches-per-stage options offered at the storage boundary (see `clampMinStageMatches`). */
export const MIN_STAGE_MATCHES_OPTIONS = [3, 5, 10] as const;
export const DEFAULT_MIN_STAGE_MATCHES = 3;

/** D-24: the legacy `getMatchupStats`/`getBestWorstMatchup` default, preserved byte-for-byte — that legacy-faithful ranking is intentionally NOT evidence-gated by this policy. */
export const LEGACY_BEST_WORST_MATCHUP_MIN_GAMES = 5;

/**
 * D-24 (plan 36-02 Task 3): every remaining scattered sample-size literal,
 * relocated here with its value preserved byte-for-byte at 3+ or raised to
 * `ABSTENTION_FLOOR_GAMES` when it gated a stage/matchup RECOMMENDATION
 * below the floor. Originally spelled inline at:
 * `apps/web/src/pages/FighterAnalysis/lib/matchupCoverage.ts` (all four),
 * `apps/web/src/pages/FighterAnalysis/lib/stageMastery.ts` (as
 * `MASTERY_CAPTION_MIN_GAMES`, raised 2 -> 3 — a per-stage mastery caption IS
 * a Wilson-bound claim, same class as D-07).
 */
/** A coverage cell reads "thin data" (not "covered") below this many games — a display cutoff, NOT a recommendation gate, so its pre-Phase-36 value of 2 is unchanged. */
export const THIN_DATA_MAX_GAMES = 2;
/** A "struggling vs X" practice recommendation needs at least this many games in the matchup. */
export const PRACTICE_MATCHUP_MIN_GAMES = 3;
/** A "you keep playing on Z" stage-habit recommendation needs at least this many games on the stage. */
export const PRACTICE_STAGE_MIN_GAMES = 3;
/** A "no games vs Y — you face them often" coverage-gap recommendation only fires once the meta opponent has been faced at least this many times account-wide. */
export const COVERAGE_GAP_MIN_META_GAMES = 3;
/** A Stage Mastery "Best pick"/"Ban-worthy" caption needs at least this many games — raised from 2 (pre-Phase-36) because the caption is a per-stage Wilson-bound claim about the user's play, the same class D-07 floors. */
export const MASTERY_CAPTION_MIN_GAMES = 3;

/** EVID-02: the inclusive minority-share threshold at which a cohort composition is flagged `mixedContext`. */
export const MIXED_CONTEXT_THRESHOLD = 0.25;

/** D-08: every claim this phase produces carries this literal — see `types.ts`'s `RecencyTreatment` doc comment. */
export const RECENCY_TREATMENT: RecencyTreatment = 'unweighted';

/**
 * Confidence tier for a countable-game count, or `null` below the abstention
 * floor — there is no confidence below the floor, only a gap.
 */
export function confidenceTierFor(games: number): ConfidenceTier | null {
  if (games >= CONFIDENCE_TIER_BOUNDS.high) {
    return 'high';
  }
  if (games >= CONFIDENCE_TIER_BOUNDS.medium) {
    return 'medium';
  }
  if (games >= CONFIDENCE_TIER_BOUNDS.low) {
    return 'low';
  }
  return null;
}

/**
 * Guards the ONE persisted `minStageMatches` value against a stored value
 * that isn't a member of `MIN_STAGE_MATCHES_OPTIONS` (mirrors
 * `apps/web/src/lib/analyticsSelection.ts`'s `isValidMinStageMatches`,
 * applied at the storage read boundary). This is NOT the engine-level floor
 * enforcement — see `effectiveFloor` below for that; a value can pass this
 * guard (e.g. `1` before plan 36-02 trims the option list) and still be
 * raised further by `effectiveFloor` before it ever reaches a ranking.
 */
export function clampMinStageMatches(value: number): number {
  return (MIN_STAGE_MATCHES_OPTIONS as readonly number[]).includes(value)
    ? value
    : DEFAULT_MIN_STAGE_MATCHES;
}

/**
 * R1-HIGH-1: the load-bearing floor enforcement. Every ranking entry point
 * in this package routes its `minMatches`/`minGames` parameter through this
 * function, so a persisted value, a query parameter, or an inline literal
 * below the floor is always raised to it — a caller can loosen the floor
 * upward (asking for MORE evidence than the floor requires) but can never
 * weaken it below `ABSTENTION_FLOOR_GAMES`. See this plan's `T-36-01-03`
 * threat entry for why the storage-level `clampMinStageMatches` above is
 * not sufficient on its own: it guards only the ONE persisted value, and
 * only at the moment it's read from storage, not at the engine boundary
 * every ranking call actually goes through.
 */
export function effectiveFloor(callerMinimum?: number): number {
  return Math.max(callerMinimum ?? ABSTENTION_FLOOR_GAMES, ABSTENTION_FLOOR_GAMES);
}
