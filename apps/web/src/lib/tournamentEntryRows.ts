import { matchesForEntry, type Match, type TournamentEntry } from '@smash-tracker/shared';
import { getWinLossRecord, type WinLossRecord } from '@/lib/stats';

export interface TournamentEntryRow {
  entry: TournamentEntry;
  record: WinLossRecord;
}

/**
 * Builds one row per tournament entry (the user's start.gg registry, Phase A
 * sync), each carrying the win/loss record computed by scoping matches to
 * that entry via `matchesForEntry` — the same name+window linkage the detail
 * page uses. Sorted recent-first, matching `useTournamentEntries`'s
 * newest-first API ordering (re-sorted here defensively by `lastSetAt`
 * descending in case callers pass an unsorted list). Exported as a pure
 * builder so the linkage/sort math is unit-testable without rendering.
 *
 * Phase 39.2 (F8): moved out of the Trends `Tournaments` component, which the
 * tier-aware `TournamentsTable` replaced; `RecentEvents` and the Tournaments
 * page both read the builder from here.
 */
export function buildTournamentEntryRows(
  entries: TournamentEntry[],
  matches: Match[],
): TournamentEntryRow[] {
  return [...entries]
    .sort((a, b) => b.lastSetAt - a.lastSetAt)
    .map((entry) => ({
      entry,
      record: getWinLossRecord(matchesForEntry(matches, entry)),
    }));
}
