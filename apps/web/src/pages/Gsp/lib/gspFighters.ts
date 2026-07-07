import type { Fighter, Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';

/**
 * Fighters offered by the GSP page's selector: every fighter with at least
 * one gsp-bearing match, PLUS the user's primary/secondary picks as
 * always-available suggestions (so a player who hasn't logged a GSP match
 * yet for their main still sees it in the list rather than an empty
 * selector). De-duplicated, sorted alphabetically like the rest of the app's
 * fighter pickers (see `alphaSpriteList` in MatchForm.tsx).
 */
export function getGspFighterOptions(
  matches: Match[],
  primaryIds: number[] = [],
  secondaryIds: number[] = [],
): Fighter[] {
  const ids = new Set<number>();
  for (const match of matches) {
    if (match.gsp !== undefined) {
      ids.add(match.fighter_id);
    }
  }
  for (const id of [...primaryIds, ...secondaryIds]) {
    ids.add(id);
  }

  return [...ids]
    .map((id) => getFighterById(id))
    .filter((fighter): fighter is Fighter => fighter != null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
