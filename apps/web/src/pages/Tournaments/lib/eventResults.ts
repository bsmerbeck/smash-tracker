import type { EventStanding, Match, TournamentEntry } from '@smash-tracker/shared';
import { buildStartggUrl } from './startggLinks';

export interface EventResultRow {
  standing: EventStanding;
  /** Display name — `gamerTag` when it differs from `name` (e.g. "Sponsor | Tag" -> "Tag"), otherwise just `name`. */
  displayName: string;
  /** The raw entrant name, shown as a sub-label only when it differs from `displayName`. */
  subLabel: string | null;
  /** True when this standings row matches an opponent tag actually played at this event (case-insensitive). */
  playedAtEvent: boolean;
  /** start.gg profile URL, when the standing carries a `userSlug`. */
  profileUrl: string | null;
}

/**
 * Collects the distinct opponent tags (`match.opponent`, already lowercased
 * at write time — see `normalizeOpponentTag` in the sync service) the user
 * actually played across the matches attributed to this event, as a Set for
 * O(1) case-insensitive lookup. Manual matches with no `opponent` are
 * skipped (nothing to match against).
 */
export function opponentTagsPlayedAtEvent(entryMatches: Match[]): Set<string> {
  const tags = new Set<string>();
  for (const match of entryMatches) {
    if (match.opponent) {
      tags.add(match.opponent.toLowerCase());
    }
  }
  return tags;
}

/**
 * True when a standings entry's `gamerTag` OR `name` matches (case
 * insensitive) an opponent tag actually played at this event. Checking both
 * fields covers start.gg's "Sponsor | Tag" display name convention, since
 * the tracked opponent tag is normalized from whichever of the two matches.
 */
export function standingMatchesPlayedOpponent(
  standing: Pick<EventStanding, 'name' | 'gamerTag'>,
  playedTags: Set<string>,
): boolean {
  const candidates = [standing.name, standing.gamerTag].filter((v): v is string => v != null);
  return candidates.some((candidate) => playedTags.has(candidate.toLowerCase()));
}

/**
 * Builds the top-8 standings table rows for the Event Results card: display
 * name (gamerTag when it differs from the raw name), the "you played them"
 * highlight flag, and a start.gg profile link when available. Returns `[]`
 * when `topStandings` is absent — callers render the resync-hint empty state
 * in that case.
 */
export function buildEventResultRows(
  entry: Pick<TournamentEntry, 'topStandings'>,
  entryMatches: Match[],
): EventResultRow[] {
  const standings = entry.topStandings ?? [];
  const playedTags = opponentTagsPlayedAtEvent(entryMatches);

  return standings.map((standing) => {
    const displayName =
      standing.gamerTag && standing.gamerTag !== standing.name ? standing.gamerTag : standing.name;
    const subLabel = displayName !== standing.name ? standing.name : null;

    return {
      standing,
      displayName,
      subLabel,
      playedAtEvent: standingMatchesPlayedOpponent(standing, playedTags),
      profileUrl: buildStartggUrl(standing.userSlug),
    };
  });
}
