import type { Match } from '@smash-tracker/shared';
import { buildDrillDownSearch } from '@/lib/drillDownParams';

/** The games door's scroll target on Match Data (the same literal every host's terminus card carries). */
const GAMES_ANCHOR = '#games';

/**
 * The event's games as Match Data's inclusive `from`/`to` window, or `null` when that window
 * would hold any game besides the event's own (the door's printed count must equal the rows).
 */
export function buildGamesDoorHref(
  games: readonly Match[],
  allMatches: readonly Match[],
  subjectPath: (personalPath: string) => string,
): string | null {
  if (games.length === 0) return null;
  const times = games.map((game) => game.time);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const inWindow = allMatches.filter((match) => match.time >= from && match.time <= to).length;
  if (inWindow !== games.length) return null;
  const search = buildDrillDownSearch({ from, to }).toString();
  return `${subjectPath('/match-data')}?${search}${GAMES_ANCHOR}`;
}
