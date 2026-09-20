import type { ReactNode } from 'react';
import { CHART_TOKENS } from './tokens';

/**
 * The form-strip chart-kit vocabulary member (kit README, VIZ-02): the last
 * N games grouped event → set → game, one tick per game, bounded at `limit`
 * ticks regardless of how many games the source holds — this is what answers
 * "what has the last 30/60 games looked like" without drawing thousands of
 * marks.
 *
 * Plain DOM and inline SVG-free CSS boxes only, exactly like
 * `ComparisonBars.tsx`: this member never imports `recharts` and is
 * deliberately NOT a member of `chartKitBoundary.test.ts`'s
 * `KIT_CHART_PRIMITIVES` — that list enumerates kit files that render a
 * Recharts element for the structural frame rule; a CSS strip renders no
 * Recharts element, so it is outside that rule's scope.
 *
 * Every label, legend string and empty-state node is a prop — this component
 * localises nothing (Track B rule B1: no locale JSON is touched by this
 * plan). Colour is always secondary to POSITION: a win renders its 14px bar
 * in the top half of the 8×32px slot, a loss in the bottom half — the
 * colour (`CHART_TOKENS.win` / `.loss`) is read through one literal lookup
 * object below, never passed in as a prop, which is what makes UIX-05's
 * "a mark role resolves to a token" contract checkable.
 */

export interface FormStripGame {
  key: string;
  won: boolean;
  /** Pre-resolved pointer-tooltip text for this single game tick (`title` attribute). */
  label: string;
}

export interface FormStripSet {
  key: string;
  /** Pre-resolved accessible label for this set (UI-SPEC §7.10: "{{event}}, vs {{opponent}}, {{w}}–{{l}}"). */
  label: string;
  /** Whether this set falls inside the host's recent window. Sets outside it render at 32% opacity. */
  inRecentWindow: boolean;
  games: FormStripGame[];
}

export interface FormStripEvent {
  key: string;
  /** Event name — the row's single flexible truncating slot. */
  label: string;
  /** Pre-formatted W–L record shown as a non-shrinking token beside the label. */
  record: string;
  sets: FormStripSet[];
}

export interface FormStripLabels {
  /** Container `role="group"` aria-label, e.g. "Form, last 42 games: 30 wins, 12 losses, oldest first". */
  summary: string;
  /** One-line legend, e.g. "up = win · down = loss · gap = new set · label = event". */
  legend: string;
  /** "60 of 90 games shown" — rendered only when the host says the source held more than `limit`. */
  shownOfTotal?: string;
  /** Rendered in place of the strip at 0 games in scope. */
  empty: ReactNode;
  /** Rendered when games exist in scope but none fall in the recent window. */
  windowEmpty?: string;
}

export interface FormStripProps {
  events: FormStripEvent[];
  /** The strip renders at most this many ticks, trimming from the oldest end when the source holds more. */
  limit: 30 | 60;
  labels: FormStripLabels;
  onSelectSet?: (setKey: string) => void;
}

/** The mark-role colour lookup — the ONE source this file reads a mark colour from (UIX-05). */
const MARK_COLOR = { win: CHART_TOKENS.win, loss: CHART_TOKENS.loss };

const TICK_WIDTH_PX = 8;
const TICK_HEIGHT_PX = 32;
const TICK_BAR_HEIGHT_PX = 14;
const TICK_BAR_RADIUS_PX = 2;
const DIMMED_OPACITY = 0.32;
const EVENT_MIN_WIDTH_PX = 104;
const SET_MIN_HIT_WIDTH_PX = 24;
const SET_MIN_HIT_HEIGHT_PX = 32;
const SET_STRIP_TICK_WIDTH_PX = 12;
const SET_STRIP_TICK_HEIGHT_PX = 24;
const SET_STRIP_TICK_BAR_HEIGHT_PX = 10;

function countGames(events: FormStripEvent[]): number {
  return events.reduce(
    (sum, event) => sum + event.sets.reduce((setSum, set) => setSum + set.games.length, 0),
    0,
  );
}

/**
 * Trims the oldest-first event→set→game tree down to at most `limit` games,
 * dropping from the OLDEST end (the start of the array) and preserving
 * grouping structure — an event or set that becomes empty after trimming is
 * dropped entirely; a set that is only partially trimmed keeps its most
 * recent games.
 */
function trimToLimit(events: FormStripEvent[], limit: number): FormStripEvent[] {
  const total = countGames(events);
  if (total <= limit) {
    return events;
  }
  let toDrop = total - limit;
  const result: FormStripEvent[] = [];
  for (const event of events) {
    const keptSets: FormStripSet[] = [];
    for (const set of event.sets) {
      if (toDrop >= set.games.length) {
        toDrop -= set.games.length;
        continue;
      }
      if (toDrop > 0) {
        keptSets.push({ ...set, games: set.games.slice(toDrop) });
        toDrop = 0;
      } else {
        keptSets.push(set);
      }
    }
    if (keptSets.length > 0) {
      result.push({ ...event, sets: keptSets });
    }
  }
  return result;
}

function Tick({ game, dimmed }: { game: FormStripGame; dimmed: boolean }) {
  const color = game.won ? MARK_COLOR.win : MARK_COLOR.loss;
  return (
    <span
      data-slot="form-strip-tick"
      title={game.label}
      style={{
        display: 'inline-flex',
        width: TICK_WIDTH_PX,
        height: TICK_HEIGHT_PX,
        alignItems: game.won ? 'flex-start' : 'flex-end',
        opacity: dimmed ? DIMMED_OPACITY : 1,
      }}
    >
      <span
        data-slot={game.won ? 'form-strip-tick-win' : 'form-strip-tick-loss'}
        style={{
          width: TICK_WIDTH_PX,
          height: TICK_BAR_HEIGHT_PX,
          backgroundColor: color,
          borderRadius: TICK_BAR_RADIUS_PX,
        }}
      />
    </span>
  );
}

function SetGroup({
  set,
  onSelectSet,
}: {
  set: FormStripSet;
  onSelectSet?: (setKey: string) => void;
}) {
  const activate = () => onSelectSet?.(set.key);
  return (
    <div
      data-slot="form-strip-set"
      tabIndex={0}
      aria-label={set.label}
      className="relative flex items-center gap-0.5 rounded-sm hover:bg-muted/40 focus:bg-muted/40"
      style={{ minWidth: SET_MIN_HIT_WIDTH_PX, minHeight: SET_MIN_HIT_HEIGHT_PX }}
      onClick={onSelectSet ? activate : undefined}
      onKeyDown={
        onSelectSet
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }
          : undefined
      }
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2"
        style={{ height: 1, backgroundColor: CHART_TOKENS.deemphasisStrong }}
      />
      {set.games.map((game) => (
        <Tick key={game.key} game={game} dimmed={!set.inRecentWindow} />
      ))}
    </div>
  );
}

export function FormStrip({ events, limit, labels, onSelectSet }: FormStripProps) {
  const totalGames = countGames(events);

  if (totalGames === 0) {
    return <div data-slot="form-strip-empty">{labels.empty}</div>;
  }

  const trimmedEvents = trimToLimit(events, limit);

  return (
    <div className="flex flex-col gap-2" data-slot="form-strip-root">
      <div role="group" aria-label={labels.summary} className="flex flex-wrap gap-4">
        {trimmedEvents.map((event) => (
          <div
            key={event.key}
            data-slot="form-strip-event"
            className="flex flex-col gap-1"
            style={{ minWidth: EVENT_MIN_WIDTH_PX }}
          >
            <div className="flex flex-wrap gap-1">
              {event.sets.map((set) => (
                <SetGroup key={set.key} set={set} onSelectSet={onSelectSet} />
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate" title={event.label}>
                {event.label}
              </span>
              <span className="shrink-0 tabular-nums">{event.record}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{labels.legend}</span>
        {labels.shownOfTotal && <span>{labels.shownOfTotal}</span>}
      </div>
      {labels.windowEmpty && <p className="text-xs text-muted-foreground">{labels.windowEmpty}</p>}
    </div>
  );
}

export interface SetStripItem {
  key: string;
  won: boolean;
  /** Pre-resolved pointer-tooltip text for this set tick. */
  label: string;
}

/**
 * `SetStrip` — one 12×24px tick per SET (up = set won), for the post-event
 * recap card. At 0 sets it renders nothing at all (never an empty frame).
 */
export function SetStrip({ sets, ariaLabel }: { sets: SetStripItem[]; ariaLabel: string }) {
  if (sets.length === 0) {
    return null;
  }
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5"
      data-slot="set-strip"
    >
      {sets.map((set) => (
        <span
          key={set.key}
          title={set.label}
          style={{
            display: 'inline-flex',
            width: SET_STRIP_TICK_WIDTH_PX,
            height: SET_STRIP_TICK_HEIGHT_PX,
            alignItems: set.won ? 'flex-start' : 'flex-end',
          }}
        >
          <span
            data-slot={set.won ? 'set-strip-tick-win' : 'set-strip-tick-loss'}
            style={{
              width: SET_STRIP_TICK_WIDTH_PX,
              height: SET_STRIP_TICK_BAR_HEIGHT_PX,
              backgroundColor: set.won ? MARK_COLOR.win : MARK_COLOR.loss,
              borderRadius: TICK_BAR_RADIUS_PX,
            }}
          />
        </span>
      ))}
    </span>
  );
}
