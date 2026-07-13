import type { Match } from '@smash-tracker/shared';
import {
  ALL_FILTER_VALUE,
  applyMatchTableFilters,
  getMatchTableFilterOptions,
} from '@/pages/MatchData/lib/matchTableFilters';

/**
 * VOD Manager filter state: a thin composition over `MatchTableFilterState`
 * (fighter/opponentFighter/stage/tournament, delegated verbatim to
 * `applyMatchTableFilters`) plus a new `opponent` name filter and a `tags`
 * multi-select (TAG-05). `matchType` is intentionally NOT carried — it
 * isn't a filter dimension for the VOD Manager in Phase 1 (D-08). `tags`
 * defaults to `[]` (NOT the `ALL_FILTER_VALUE` sentinel used by the
 * single-select dimensions) because this is a multi-select where "no tags
 * selected" means "no tag narrowing" — the natural empty-array identity,
 * not a sentinel string.
 */
export interface VodManagerFilterState {
  fighter: string;
  opponentFighter: string;
  stage: string;
  tournament: string;
  opponent: string;
  tags: string[];
}

export const DEFAULT_VOD_MANAGER_FILTERS: VodManagerFilterState = {
  fighter: ALL_FILTER_VALUE,
  opponentFighter: ALL_FILTER_VALUE,
  stage: ALL_FILTER_VALUE,
  tournament: ALL_FILTER_VALUE,
  opponent: ALL_FILTER_VALUE,
  tags: [],
};

/**
 * Filter option lists for every VOD Manager filter dimension: spreads
 * `getMatchTableFilterOptions` (fighters/opponentFighters/stages/tournaments)
 * and adds a sorted, deduped `opponents` list of non-empty canonical
 * `match.opponent` values, plus a sorted, deduped `tagsInUse` list of every
 * tag actually applied — both match-level `tags` and every note-level
 * `vodTimestamps[].tags` — so a preset with zero uses never renders in the
 * filter chip row (TAG-05).
 */
export function getVodManagerFilterOptions(matches: Match[]) {
  const opponents = new Set<string>();
  const tagsInUse = new Set<string>();
  for (const match of matches) {
    if (match.opponent) {
      opponents.add(match.opponent);
    }
    for (const tag of match.tags ?? []) {
      tagsInUse.add(tag);
    }
    for (const stamp of match.vodTimestamps ?? []) {
      for (const tag of stamp.tags ?? []) {
        tagsInUse.add(tag);
      }
    }
  }

  return {
    ...getMatchTableFilterOptions(matches),
    opponents: [...opponents].sort((a, b) => a.localeCompare(b)),
    tagsInUse: [...tagsInUse].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Composes over `applyMatchTableFilters` for fighter/opponentFighter/stage/
 * tournament (delegation, not reimplementation — `matchType` is passed as
 * `ALL_FILTER_VALUE` so it never narrows the result), then AND-filters by
 * canonical opponent name when `filters.opponent` isn't the "all" sentinel,
 * then AND-filters by tags (TAG-05): a match surfaces when it carries ANY
 * of the selected tags (OR within `filters.tags`), checking both
 * match-level `tags` and every note-level `vodTimestamps[].tags` (a match
 * whose only hit is a note tag still surfaces). Runs last so a match
 * excluded by any dropdown dimension never reaches the tag check.
 */
export function applyVodManagerFilters(matches: Match[], filters: VodManagerFilterState): Match[] {
  const delegated = applyMatchTableFilters(matches, {
    fighter: filters.fighter,
    opponentFighter: filters.opponentFighter,
    stage: filters.stage,
    tournament: filters.tournament,
    matchType: ALL_FILTER_VALUE,
  });

  const opponentFiltered =
    filters.opponent === ALL_FILTER_VALUE
      ? delegated
      : delegated.filter((match) => match.opponent === filters.opponent);

  if (filters.tags.length === 0) {
    return opponentFiltered;
  }
  return opponentFiltered.filter((match) => {
    const allTags = [
      ...(match.tags ?? []),
      ...(match.vodTimestamps ?? []).flatMap((stamp) => stamp.tags ?? []),
    ];
    return filters.tags.some((selected) => allTags.includes(selected));
  });
}

export type VodSortDirection = 'newest' | 'oldest';

/** Sorts a new array by `match.time` — descending (newest first) or ascending (oldest first). Never mutates the input. */
export function sortByRecency(matches: Match[], direction: VodSortDirection): Match[] {
  return [...matches].sort((a, b) => (direction === 'newest' ? b.time - a.time : a.time - b.time));
}
