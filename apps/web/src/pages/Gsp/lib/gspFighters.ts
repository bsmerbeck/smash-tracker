import type { Fighter, Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { sortFightersByLocalizedName } from '@/lib/fighterNames';

/**
 * Fighters offered by the GSP page's selector: every fighter with at least
 * one gsp-bearing match, PLUS the user's primary/secondary picks as
 * always-available suggestions (so a player who hasn't logged a GSP match
 * yet for their main still sees it in the list rather than an empty
 * selector). De-duplicated, sorted alphabetically by localized display name
 * like the rest of the app's fighter pickers (see `useAlphaFighters` in
 * `@/hooks/useFighterName`).
 *
 * `localizedName` defaults to the canonical English `SpriteList` name so
 * this stays usable without a live `t` (tests, non-component callers);
 * `GspPage` passes the real locale-aware resolver from
 * `useFighterNameResolver()`.
 */
export function getGspFighterOptions(
  matches: Match[],
  primaryIds: number[] = [],
  secondaryIds: number[] = [],
  localizedName: (id: number) => string = (id) => getFighterById(id)?.name ?? '',
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

  const fighters = [...ids]
    .map((id) => getFighterById(id))
    .filter((fighter): fighter is Fighter => fighter != null);
  return sortFightersByLocalizedName(fighters, localizedName);
}
