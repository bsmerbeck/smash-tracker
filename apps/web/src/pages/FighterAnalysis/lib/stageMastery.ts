import type { Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { rankStagesByEvidence, type RankedStage } from '@/lib/stats';

/**
 * Phase 38-06 (ADV-03/D-13): the bespoke `buildStageMasteryCaption` wrapper
 * (and its re-export of `MASTERY_CAPTION_MIN_GAMES`, which had no other
 * consumer) is retired — `StageMastery.tsx` now builds its caption from
 * `buildStageEvidence` (`packages/shared/src/evidence/stageEvidence.ts`),
 * the SAME gated engine call `MatchupStageGuide.tsx` already reads, so both
 * surfaces share one claim shape, one abstention message and one sample
 * cue. `MASTERY_CAPTION_MIN_GAMES` is imported directly from
 * `@smash-tracker/shared` at the one remaining call site. This was NOT a
 * duplicate-computation bug: the retired wrapper already delegated to
 * `rankStagesByEvidence` and applied a (currently equal) threshold constant
 * — this retirement collapses two code paths into one shared shape, it does
 * not correct a numeric discrepancy.
 */

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
