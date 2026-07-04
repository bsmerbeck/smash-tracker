import type { Match } from '@smash-tracker/shared';
import { rankStagesByEvidence, type RankedStage } from '@/lib/stats';

/** Minimum recorded matches on a stage before it can be called out as a "Best pick" or "Ban-worthy" caption — matches Matchup Lab's CounterpickAdvisor threshold (docs/analytics-vision.md). */
export const MASTERY_CAPTION_MIN_GAMES = 2;

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
 */
export function buildStageMasteryTiles(fighterMatches: Match[]): StageMasteryTile[] {
  return rankStagesByEvidence(fighterMatches, 1).map((stage) => ({
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
