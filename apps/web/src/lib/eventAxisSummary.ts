import type { TFunction } from 'i18next';
import {
  eventDisplayName,
  parseExternalId,
  trimmedEventKey,
  type Match,
} from '@smash-tracker/shared';
import { formatDate, formatDaySpan } from '@/lib/format';
import { calendarPeriodLabel } from '@/lib/periodKeyLabel';

/** I18N-01: the span prints in the app language through the one formatter module (one date when both ends share a day). */
function formatDateRange(games: Match[], locale: string): string {
  const times = games.map((m) => m.time);
  return formatDaySpan(Math.min(...times), Math.max(...times), locale);
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
 * 3. games sharing one event name (`trimmedEventKey`, the one name-priority
 *    rule) -> their display name (`eventDisplayName`, 41-13: "Genesis 9 ·
 *    Ultimate Singles" when every game shares that tournament, else the event
 *    name). Step 2's event is the same display name;
 * 4. anything else (a session, a calendar period) -> its date range.
 *
 * `undefined` for an empty set (a stale key) — the caller then shows the
 * localized "unknown" rather than the raw key.
 *
 * UAT 39.1-27a (F4): when the axis `eventKey` is a calendar-period key
 * (`week:`/`month:`/`quarter:`/`year:`) the period itself names the drill
 * ("2024 Q2") — the games of a quarter may well share one event name, and
 * printing it would describe the drill as that event.
 */
export function describeEventAxisGames(
  games: Match[],
  t: TFunction,
  locale: string,
  eventKey?: string,
): string | undefined {
  const first = games[0];
  if (!first) return undefined;
  const period = eventKey != null ? calendarPeriodLabel(eventKey, t, locale) : undefined;
  if (period) return period;
  const opponent = first.opponent?.trim() || t('common.unknown');

  if (games.length === 1) {
    return t('shared.filteredMatchList.eventSummary.game', {
      opponent,
      date: formatDate(first.time, locale),
    });
  }

  const setIds = new Set(games.map((m) => parseExternalId(m.externalId)?.setId ?? null));
  if (setIds.size === 1 && !setIds.has(null)) {
    const event = trimmedEventKey(first) != null ? eventDisplayName(games) : null;
    return event
      ? t('shared.filteredMatchList.eventSummary.set', { opponent, event })
      : t('shared.filteredMatchList.eventSummary.setUnnamed', { opponent });
  }

  const names = new Set(games.map((m) => trimmedEventKey(m)));
  const [onlyName] = names;
  if (names.size === 1 && onlyName != null) {
    return eventDisplayName(games) ?? onlyName;
  }

  return formatDateRange(games, locale);
}
