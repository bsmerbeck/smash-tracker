import type { Match } from '@smash-tracker/shared';
import { buildDrillDownSearch } from '@/lib/drillDownParams';

/** The games door's scroll target on Match Data (the same literal every host's terminus card carries). */
const GAMES_ANCHOR = '#games';

/**
 * The event's games as Match Data's inclusive `from`/`to` window, or `null` when that window,
 * over the games Match Data would actually list, would not be exactly the event's own (the
 * door's printed count must equal the rows).
 *
 * `terminusMatches` is Match Data's own population — the subject's games with the global source
 * and range filter applied (`useFilteredMatches().matches`), never all games (39.2-REVIEW
 * WEB-WR-03): a source filter that hides the event's games from Match Data drops the door rather
 * than promising rows the terminus will not show.
 */
export function buildGamesDoorHref(
  games: readonly Match[],
  terminusMatches: readonly Match[],
  subjectPath: (personalPath: string) => string,
): string | null {
  if (games.length === 0) return null;
  const listed = new Set(terminusMatches.map((match) => match.id));
  if (!games.every((game) => listed.has(game.id))) return null;
  const times = games.map((game) => game.time);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const inWindow = terminusMatches.filter((match) => match.time >= from && match.time <= to).length;
  if (inWindow !== games.length) return null;
  const search = buildDrillDownSearch({ from, to }).toString();
  return `${subjectPath('/match-data')}?${search}${GAMES_ANCHOR}`;
}
