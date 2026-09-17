import type { Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES, MASTERY_CAPTION_MIN_GAMES } from '@smash-tracker/shared';
import { rankStagesByEvidence, type RankedStage } from '@/lib/stats';

/**
 * Phase 36 (D-24, R1-MEDIUM-2): `MASTERY_CAPTION_MIN_GAMES` is now sourced
 * from `packages/shared/src/evidence/policy.ts` (raised 2 -> 3) rather than
 * declared here — a Best-pick/Ban-worthy caption is a per-stage Wilson-bound
 * claim about the user's play, the same class of claim D-07's floor governs.
 */
export { MASTERY_CAPTION_MIN_GAMES };

/** Wilson lower-bound buckets driving the tile tint, mirroring the red -> grey -> emerald convention from the Matchups matrix (implemented locally per the Fighter Analysis spec, not imported). */
export type MasteryTintBucket = 'weak' | 'even' | 'strong';

/** Below this Wilson score a stage tile reads as "weak" (red-leaning); at/above `STRONG_THRESHOLD` it reads as "strong" (emerald-leaning); in between it's "even" (neutral grey). */
export const WEAK_THRESHOLD = 0.4;
export const STRONG_THRESHOLD = 0.6;

/** Buckets a Wilson lower bound (0-1) into the tint bucket used for the Stage Mastery tile color. */
export function tintBucketForWilson(wilson: number): MasteryTintBucket {
  if (wilson < WEAK_THRESHOLD) {
    return 'weak';
  }
  if (wilson >= STRONG_THRESHOLD) {
    return 'strong';
  }
  return 'even';
}

export interface StageMasteryTile extends RankedStage {
  tint: MasteryTintBucket;
}

/**
 * Every stage with at least one recorded game for this fighter, Wilson-ranked
 * best first (via `rankStagesByEvidence`), each tagged with its tint bucket
 * for the art-tile grid.
 *
 * Phase 36 (D-05, R1-MEDIUM-2): each tile is tinted from its Wilson lower
 * bound (`tintBucketForWilson`) — a claim about the user's play on that
 * stage — so the argument here is `ABSTENTION_FLOOR_GAMES`, not an inline
 * `1`. `rankStagesByEvidence` floors any argument to at least this value
 * anyway (R1-HIGH-1), so this is the honest source, not a behavior change.
 */
export function buildStageMasteryTiles(fighterMatches: Match[]): StageMasteryTile[] {
  return rankStagesByEvidence(fighterMatches, ABSTENTION_FLOOR_GAMES).map((stage) => ({
    ...stage,
    tint: tintBucketForWilson(stage.wilson),
  }));
}

export interface StageMasteryCaption {
  bestPick: RankedStage | null;
  banWorthy: RankedStage | null;
}

/**
 * "Best pick / Ban-worthy" caption row for Stage Mastery: the top and bottom
 * evidence-ranked stages, each requiring at least `MASTERY_CAPTION_MIN_GAMES`
 * recorded matches (folds in the legacy BestWorstMap threshold semantics via
 * the evidence-aware ranking instead of raw win rate). When only one stage
 * qualifies it's reported as `bestPick` only, matching `getBestWorstStages`'s
 * "can't be both the recommendation and the warning" rule.
 */
export function buildStageMasteryCaption(fighterMatches: Match[]): StageMasteryCaption {
  const qualifying = rankStagesByEvidence(fighterMatches, MASTERY_CAPTION_MIN_GAMES);
  if (qualifying.length === 0) {
    return { bestPick: null, banWorthy: null };
  }
  const bestPick = qualifying[0] ?? null;
  const banWorthy = qualifying.length > 1 ? (qualifying[qualifying.length - 1] ?? null) : null;
  return { bestPick, banWorthy };
}
