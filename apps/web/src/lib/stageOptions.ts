import type { Match, Stage } from '@smash-tracker/shared';
import { stagesById, NO_SELECTION_STAGE } from '@/data/stages';
import { getStageUsage } from '@/lib/stats';

/** Every real stage (excluding the id-0 "no selection" sentinel), deduped by id, alphabetical. */
export const alphaStageList: Stage[] = [...stagesById.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** `alphaStageList` with the "no selection" sentinel prepended — the flat option list used by non-grouped consumers (e.g. form validation, id lookups). `NO_SELECTION_STAGE` has no `url` (it's a `MatchStage`, not a full `Stage`), so this list intentionally isn't typed as `Stage[]`. */
export const stageOptions = [NO_SELECTION_STAGE, ...alphaStageList];

const MOST_PLAYED_LIMIT = 8;

export interface GroupedStageOptions {
  /** Top stages by usage (count > 0), most-used first, capped at `MOST_PLAYED_LIMIT`. */
  mostPlayed: Stage[];
  /** Every real stage, alphabetical — intentionally repeats entries already in `mostPlayed` for scannability. */
  all: Stage[];
}

/**
 * Builds the "Most played" (usage-ordered, from the user's unfiltered
 * matches) + "All stages" (alphabetical) grouping shown in stage pickers.
 * `matches` should be the user's full, unfiltered match history — usage
 * ordering isn't meant to react to the global analytics filter.
 */
export function getGroupedStageOptions(matches: Match[]): GroupedStageOptions {
  const usage = getStageUsage(matches);
  const mostPlayed = alphaStageList
    .map((stage) => ({ stage, count: usage.get(stage.id) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MOST_PLAYED_LIMIT)
    .map((entry) => entry.stage);

  return { mostPlayed, all: alphaStageList };
}
