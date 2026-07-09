import type { Match } from '@smash-tracker/shared';
import {
  ALL_FILTER_VALUE,
  applyMatchTableFilters,
  getMatchTableFilterOptions,
} from '@/pages/MatchData/lib/matchTableFilters';

/**
 * VOD Manager filter state: a thin composition over `MatchTableFilterState`
 * (fighter/opponentFighter/stage/tournament, delegated verbatim to
 * `applyMatchTableFilters`) plus a new `opponent` name filter. `matchType`
 * is intentionally NOT carried — it isn't a filter dimension for the VOD
 * Manager in Phase 1 (D-08).
 */
export interface VodManagerFilterState {
  fighter: string;
  opponentFighter: string;
  stage: string;
  tournament: string;
  opponent: string;
}

export const DEFAULT_VOD_MANAGER_FILTERS: VodManagerFilterState = {
  fighter: ALL_FILTER_VALUE,
  opponentFighter: ALL_FILTER_VALUE,
  stage: ALL_FILTER_VALUE,
  tournament: ALL_FILTER_VALUE,
  opponent: ALL_FILTER_VALUE,
};

/**
 * Filter option lists for every VOD Manager filter dimension: spreads
 * `getMatchTableFilterOptions` (fighters/opponentFighters/stages/tournaments)
 * and adds a sorted, deduped `opponents` list of non-empty canonical
 * `match.opponent` values.
 */
export function getVodManagerFilterOptions(matches: Match[]) {
  const opponents = new Set<string>();
  for (const match of matches) {
    if (match.opponent) {
      opponents.add(match.opponent);
    }
  }

  return {
    ...getMatchTableFilterOptions(matches),
    opponents: [...opponents].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Composes over `applyMatchTableFilters` for fighter/opponentFighter/stage/
 * tournament (delegation, not reimplementation — `matchType` is passed as
 * `ALL_FILTER_VALUE` so it never narrows the result), then AND-filters by
 * canonical opponent name when `filters.opponent` isn't the "all" sentinel.
 */
export function applyVodManagerFilters(matches: Match[], filters: VodManagerFilterState): Match[] {
  const delegated = applyMatchTableFilters(matches, {
    fighter: filters.fighter,
    opponentFighter: filters.opponentFighter,
    stage: filters.stage,
    tournament: filters.tournament,
    matchType: ALL_FILTER_VALUE,
  });

  if (filters.opponent === ALL_FILTER_VALUE) {
    return delegated;
  }
  return delegated.filter((match) => match.opponent === filters.opponent);
}

export type VodSortDirection = 'newest' | 'oldest';

/** Sorts a new array by `match.time` — descending (newest first) or ascending (oldest first). Never mutates the input. */
export function sortByRecency(matches: Match[], direction: VodSortDirection): Match[] {
  return [...matches].sort((a, b) => (direction === 'newest' ? b.time - a.time : a.time - b.time));
}
