import type { TFunction } from 'i18next';
import { parseExternalId, trimmedEventKey, type Match } from '@smash-tracker/shared';

function formatDateRange(games: Match[]): string {
  const times = games.map((m) => m.time);
  const from = new Date(Math.min(...times)).toLocaleDateString();
  const to = new Date(Math.max(...times)).toLocaleDateString();
  return from !== to ? `${from} – ${to}` : from;
}

/**
 * WR-03 (39.1-REVIEW): the words the active-filter summary uses for an
 * `event=` axis. The axis value is an opaque host key — a start.gg/parry.gg
 * set id, `game:<matchId>` for a manual game, an event-anchor key, or a
 * trend `PeriodPoint.key` — so it must never be printed as-is. This
 * describes the GAMES the axis resolved to instead, from their own fields:
 *
 * 1. one game -> "Game vs <opponent> on <date>" — checked FIRST (WR-03,
 *    iteration 2): a game-grain trend point, or a one-game slice of a set,
 *    is one game, and the set sentence would name games the list does not
 *    show;
 * 2. one parsed set (2+ of its games) -> "Set vs <opponent> at <event>" (or
 *    without the event);
 * 3. games sharing one event name -> that name (`trimmedEventKey`, the one
 *    name-priority rule);
 * 4. anything else (a session, a calendar period) -> its date range.
 *
 * `undefined` for an empty set (a stale key) — the caller then shows the
 * localized "unknown" rather than the raw key.
 */
export function describeEventAxisGames(games: Match[], t: TFunction): string | undefined {
  const first = games[0];
  if (!first) return undefined;
  const opponent = first.opponent?.trim() || t('common.unknown');

  if (games.length === 1) {
    return t('shared.filteredMatchList.eventSummary.game', {
      opponent,
      date: new Date(first.time).toLocaleDateString(),
    });
  }

  const setIds = new Set(games.map((m) => parseExternalId(m.externalId)?.setId ?? null));
  if (setIds.size === 1 && !setIds.has(null)) {
    const event = trimmedEventKey(first);
    return event
      ? t('shared.filteredMatchList.eventSummary.set', { opponent, event })
      : t('shared.filteredMatchList.eventSummary.setUnnamed', { opponent });
  }

  const names = new Set(games.map((m) => trimmedEventKey(m)));
  const [onlyName] = names;
  if (names.size === 1 && onlyName != null) {
    return onlyName;
  }

  return formatDateRange(games);
}
