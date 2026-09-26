import type { TFunction } from 'i18next';
import {
  EVENT_BIN_GRAINS,
  eventBinKey,
  type EventAnchor,
  type EventBin,
  type EventSeries,
  type Match,
} from '@smash-tracker/shared';
import type { TrendEventPoint } from '@/components/charts/TrendLine';
import { formatEventAnchorLabel } from '@/components/charts/periodTicks';
import { formStripSessionLabel } from '@/lib/formStripEvents';

/**
 * Plan 39.1-39 (VIZ-03, UI-SPEC §10.2; the kit rule "tooltip fields are
 * pre-resolved on the point object"): the ONE host mapper from an event
 * series — anchors, or `binEventSeries` bins — to `TrendLine` event points,
 * shared by the opponent hub and stage detail (their own mappers deleted).
 * `context.eventLabel` is readable, never an engine key or ISO string:
 * a session anchor reads "Session · <locale date>" through the one
 * session-label helper (`formStripSessionLabel`); a bin its calendar period
 * and a tournament its name, both through `formatEventAnchorLabel`
 * (`periodTicks.ts`, the helper 39.1-37's axis already builds on).
 */
export function readableEventLabel({
  point,
  t,
  locale,
}: {
  point: EventAnchor | EventBin;
  t: TFunction;
  locale: string;
}): string {
  if (point.kind === 'session') {
    return formStripSessionLabel({ firstGameMs: point.startMs, t, locale });
  }
  return formatEventAnchorLabel(
    { eventKey: point.key, eventLabel: point.label, dateMs: point.startMs },
    locale,
  );
}

export function buildEventTrendPoints({
  series,
  opponentTag,
  t,
  locale,
}: {
  series: ReadonlyArray<EventAnchor | EventBin>;
  opponentTag: string;
  t: TFunction;
  locale: string;
}): TrendEventPoint[] {
  return series.map((point) => ({
    eventKey: point.key,
    cumulativeWinRate: point.cumulativeWinRate,
    wins: point.wins,
    losses: point.losses,
    context: {
      opponentTag,
      eventLabel: readableEventLabel({ point, t, locale }),
      dateMs: point.startMs,
    },
  }));
}

/**
 * Plan 39.1-39: the games terminus's multi-key resolver (39.1-25's
 * `FilteredMatchList` `string[]` precedent). A game resolves to its anchor's
 * key AND the bin key of that anchor at every grain, so a tournament link's
 * `event=<anchor key>` and a bin click's `event=bin:<grain>:<ms>` both list
 * exactly their own games — whatever grain the plotted series used (a
 * from/to window can re-grain it). Built over the FULL (unbinned) series; a
 * game outside it resolves to no key.
 */
export function buildEventKeysForMatch(series: EventSeries): (match: Match) => string[] {
  const keysByMatchId = new Map<string, string[]>();
  for (const anchor of series) {
    const keys = [
      anchor.key,
      ...EVENT_BIN_GRAINS.map((grain) => eventBinKey(grain, anchor.startMs)),
    ];
    for (const id of anchor.matchIds) {
      keysByMatchId.set(id, keys);
    }
  }
  return (match) => keysByMatchId.get(match.id) ?? [];
}
