import type { Match, TournamentEntry } from '@smash-tracker/shared';

const WINDOW_PAD_MS = 24 * 60 * 60 * 1000;

/**
 * Matches carry no `eventId` (start.gg sync enriches them with name fields
 * only — see docs on `MatchRecord`), so a match is attributed to a
 * `TournamentEntry` by:
 *
 *  1. `match.eventName === entry.eventName` (required — entries always have
 *     an event name).
 *  2. `entry.tournamentName == null || match.tournamentName === entry.tournamentName`
 *     — when the entry has no tournament name, any (or no) match
 *     tournamentName is accepted; when it does, the match must match
 *     exactly. This disambiguates same-named events run at different
 *     tournaments (e.g. two different weeklies both hosting "Ultimate
 *     Singles").
 *  3. `match.time` falls within `[entry.firstSetAt - 24h, entry.lastSetAt + 24h]`
 *     — a padded window around the entry's known set range, to tolerate
 *     clock skew / grouping edge cases without accidentally spanning into an
 *     unrelated same-named event weeks apart.
 *
 * Pure and side-effect free so it's usable both for building the per-entry
 * timeline and for computing per-entry records in the Trends tournaments
 * table.
 */
export function matchesForEntry(matches: Match[], entry: TournamentEntry): Match[] {
  const windowStart = entry.firstSetAt - WINDOW_PAD_MS;
  const windowEnd = entry.lastSetAt + WINDOW_PAD_MS;

  return matches.filter((match) => {
    if (match.eventName !== entry.eventName) {
      return false;
    }
    if (entry.tournamentName != null && match.tournamentName !== entry.tournamentName) {
      return false;
    }
    return match.time >= windowStart && match.time <= windowEnd;
  });
}
