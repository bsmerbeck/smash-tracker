import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';

/** Sentinel Select value meaning "no filter" — Radix `Select.Item` disallows an empty-string value, so column filter Selects use this instead of `''`. */
export const ALL_FILTER_VALUE = '__all__';

export interface MatchTableFilterState {
  fighter: string;
  opponentFighter: string;
  stage: string;
  matchType: string;
  tournament: string;
}

export const DEFAULT_MATCH_TABLE_FILTERS: MatchTableFilterState = {
  fighter: ALL_FILTER_VALUE,
  opponentFighter: ALL_FILTER_VALUE,
  stage: ALL_FILTER_VALUE,
  matchType: ALL_FILTER_VALUE,
  tournament: ALL_FILTER_VALUE,
};

/** A row's tournament label, matching the "Tournament" column's fallback rule: `tournamentName ?? eventName ?? '—'`. */
export function tournamentLabel(match: Match): string {
  return match.tournamentName ?? match.eventName ?? '—';
}

/** Sorted, deduped option lists for each column filter, derived from the current (already source/time/global-filtered) dataset — so a filter never offers a choice that would yield zero rows given the others. */
export function getMatchTableFilterOptions(matches: Match[]) {
  const fighters = new Set<string>();
  const opponentFighters = new Set<string>();
  const stages = new Set<string>();
  const matchTypes = new Set<string>();
  const tournaments = new Set<string>();

  for (const match of matches) {
    fighters.add(getFighterById(match.fighter_id)?.name ?? 'Unknown');
    opponentFighters.add(getFighterById(match.opponent_id)?.name ?? 'Unknown');
    stages.add(match.map?.name ?? 'unknown');
    matchTypes.add(match.matchType ?? '');
    tournaments.add(tournamentLabel(match));
  }

  const sortAlpha = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));

  return {
    fighters: sortAlpha(fighters),
    opponentFighters: sortAlpha(opponentFighters),
    stages: sortAlpha(stages),
    matchTypes: sortAlpha(matchTypes).filter((v) => v.length > 0),
    tournaments: sortAlpha(tournaments),
  };
}

/**
 * Applies the per-column filters, composing (AND) with each other. Callers
 * apply this ahead of (or via) TanStack's global text filter — this is a
 * plain array filter so it works the same whether wired through table state
 * or called directly in tests.
 */
export function applyMatchTableFilters(matches: Match[], filters: MatchTableFilterState): Match[] {
  return matches.filter((match) => {
    if (
      filters.fighter !== ALL_FILTER_VALUE &&
      (getFighterById(match.fighter_id)?.name ?? 'Unknown') !== filters.fighter
    ) {
      return false;
    }
    if (
      filters.opponentFighter !== ALL_FILTER_VALUE &&
      (getFighterById(match.opponent_id)?.name ?? 'Unknown') !== filters.opponentFighter
    ) {
      return false;
    }
    if (filters.stage !== ALL_FILTER_VALUE && (match.map?.name ?? 'unknown') !== filters.stage) {
      return false;
    }
    if (filters.matchType !== ALL_FILTER_VALUE && (match.matchType ?? '') !== filters.matchType) {
      return false;
    }
    if (filters.tournament !== ALL_FILTER_VALUE && tournamentLabel(match) !== filters.tournament) {
      return false;
    }
    return true;
  });
}
