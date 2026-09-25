import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  /**
   * WR-01 (39.1-REVIEW.md): the instant (ms) of this set's newest game. When
   * EVERY set carries one, the kit orders sets chronologically across all
   * events before the `limit` trim and the width fit (see
   * `orderSetsChronologically`), so "the most recent sets that fit" really
   * are the most recent — a host grouping by a recurring event name (every
   * start.gg tournament's "Ultimate Singles") can no longer bury this
   * year's sets inside a group that started years ago.
   */
  lastGameMs?: number;
}

export interface FormStripEvent {
  key: string;
  /** Event name — the row's single flexible truncating slot. */
  label: string;
  /*
   * WR-03 (39.1-REVIEW.md): no host-supplied `record` — the kit computes
   * each rendered group's W–L from the games it actually DRAWS, so a group
   * the limit trim or width fit shows only partly never states a record
   * for sets that are not on screen.
   */
  sets: FormStripSet[];
}

export interface FormStripLabels {
  /**
   * WR-03 (39.1-REVIEW.md): the row's `role="group"` accessible name — a
   * formatter of the games actually DRAWN (after `limit` and the width fit)
   * and the total in `events`, e.g. "Form strip, 11 of 77 games". It used to
   * be a host string stating the host total while far fewer were drawn.
   */
  summary: (counts: { shown: number; total: number }) => string;
  /** One-line legend, e.g. "up = win · down = loss · gap = new set · label = event". */
  legend: string;
  /**
   * Plan 39.1-33: a formatter, not a pre-formatted string — only the kit
   * knows how many games it actually drew after `limit` AND the measured-
   * width fit below, so the host can no longer compute `shown` itself (its
   * old "> limit" condition would print a stale count once the fit trims
   * further than `limit` alone). `shown` is the games actually drawn;
   * `total` is every game in `events` (before any trimming). Rendered only
   * when `shown` is less than `total`.
   */
  shownOfTotal?: (counts: { shown: number; total: number }) => string;
  /** Rendered in place of the strip at 0 games in scope. */
  empty: ReactNode;
  /** Rendered when games exist in scope but none fall in the recent window. */
  windowEmpty?: string;
}

export interface FormStripProps {
  events: FormStripEvent[];
  /**
   * The strip renders at most this many ticks, trimming from the oldest end
   * when the source holds more. `20` added in Phase 39.1 Plan 18 (UI-SPEC
   * §8.6) for the opponent hub's H2H trend strip, alongside the pre-existing
   * `30` (Matchups) and `60` (Fighter Analysis hero) call sites.
   */
  limit: 20 | 30 | 60;
  labels: FormStripLabels;
  onSelectSet?: (setKey: string) => void;
  /**
   * Plan 39.1-33 (D-04, mirrors `TrendLine.tsx`'s own explicit-`width`
   * affordance): when a number, the strip fits its row to EXACTLY this width
   * instead of its own measured `clientWidth` — the test/host affordance
   * that makes the width-fit deterministic under jsdom, whose zero-size
   * bounding rects never produce a real measured width. Omitted (or the
   * measured width is still 0, i.e. unmeasured) means no fit is applied —
   * only `limit` bounds the strip, same as before this plan.
   */
  availableWidthPx?: number;
}

/** The mark-role colour lookup — the ONE source this file reads a mark colour from (UIX-05). */
const MARK_COLOR = { win: CHART_TOKENS.win, loss: CHART_TOKENS.loss };

const TICK_BAR_RADIUS_PX = 2;
const DIMMED_OPACITY = 0.32;
/**
 * Plan 39.1-32 (item 11, UI-SPEC §3 exceptions / §6.6: 6x28 ticks below
 * 640px, spec text never previously implemented). The 8x32/14px sizes below
 * `sm` (640px) shrink to 6x28/12px via Tailwind classes — `alignItems`,
 * `opacity`, `backgroundColor` and `borderRadius` stay inline (read by this
 * file's own tests and the UIX-05 colour lookup).
 */
const TICK_SLOT_CLASS = 'inline-flex w-2 h-8 max-sm:w-1.5 max-sm:h-7';
const TICK_BAR_CLASS = 'w-2 h-3.5 max-sm:w-1.5 max-sm:h-3';
const SET_MIN_HIT_WIDTH_PX = 24;
const SET_MIN_HIT_HEIGHT_PX = 32;
const SET_STRIP_TICK_WIDTH_PX = 12;
const SET_STRIP_TICK_HEIGHT_PX = 24;
const SET_STRIP_TICK_BAR_HEIGHT_PX = 10;

/** UI-SPEC §5.2's separator (U+00B7 surrounded by spaces). */
const LEGEND_SEPARATOR = ' · ';

/**
 * Plan 39.1-33 (R1, UI-SPEC §7.10 as narrowed by this plan: one row, most
 * recent SETS that fit): the fallback tick width used until a real one has
 * been measured — mirrors `TICK_SLOT_CLASS`'s `w-2` (8px) slot. jsdom's
 * zero-size bounding rects mean a measured tick width is always 0 under
 * test, so this fallback is what the width-fit test cases below actually
 * exercise.
 */
const FORM_STRIP_FALLBACK_TICK_WIDTH_PX = 8;
/** Mirrors the tick-run's own `gap-0.5` (0.125rem = 2px) between ticks inside one set — the fit's per-set width formula must agree with this CSS gap. */
const FORM_STRIP_TICK_GAP_PX = 2;
/** Mirrors the row's `gap-1` (0.25rem = 4px) between sets that share one event — the fit's per-set cost when the previously kept (newer) set is the SAME event. */
const FORM_STRIP_SAME_EVENT_GAP_PX = 4;
/** Mirrors the row's `gap-4` (1rem = 16px) between events — the fit's per-set cost when the previously kept (newer) set is a DIFFERENT event. */
const FORM_STRIP_DIFFERENT_EVENT_GAP_PX = 16;
/** Sub-pixel safety subtracted from the effective width before the fit compares against it — never fit exactly flush with a fractional-pixel measured width. */
const FORM_STRIP_ROW_SAFETY_PX = 1;

/**
 * Plan 39.1-32 (item 11, UI-SPEC §7.10 legend, §6.5 rule 2): splits a legend
 * string on the spec's own ' · ' separator into trimmed, non-empty parts —
 * a legend without the separator (any future locale) returns exactly one
 * part, so the caller can render it as one normally-wrapping span instead
 * of a whole-token that could still overflow.
 */
function splitLegendParts(legend: string): string[] {
  return legend
    .split(LEGEND_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** WR-03: a rendered group's W–L over the games it actually draws. */
function drawnRecord(event: FormStripEvent): string {
  let wins = 0;
  let losses = 0;
  for (const set of event.sets) {
    for (const game of set.games) {
      if (game.won) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
  }
  return `${wins}–${losses}`;
}

function countGames(events: FormStripEvent[]): number {
  return events.reduce(
    (sum, event) => sum + event.sets.reduce((setSum, set) => setSum + set.games.length, 0),
    0,
  );
}

/**
 * WR-01 (39.1-REVIEW.md): the hosts group by event NAME and order groups by
 * their FIRST game, so a recurring name (start.gg writes the same "Ultimate
 * Singles" at every tournament) collects sets years apart into one group
 * placed at its oldest game — and the trim/fit below, which walk the array
 * from its end as "newest", then kept an older manual session over this
 * year's sets. When every set carries `lastGameMs`, this flattens every
 * (event, set) pair, stable-sorts them by that instant, and regroups
 * CONSECUTIVE runs of the same event: a name that recurs around other
 * groups becomes one display group per contiguous run (a later run's key
 * gets a `#<n>` suffix so React keys stay unique). Without `lastGameMs` on
 * every set the host's own order is kept unchanged.
 */
function orderSetsChronologically(events: FormStripEvent[]): FormStripEvent[] {
  const pairs = events.flatMap((event) => event.sets.map((set) => ({ event, set })));
  if (pairs.some(({ set }) => set.lastGameMs === undefined)) {
    return events;
  }
  pairs.sort((a, b) => a.set.lastGameMs! - b.set.lastGameMs!);
  const result: FormStripEvent[] = [];
  const sourceKeys: string[] = [];
  const runsByKey = new Map<string, number>();
  for (const { event, set } of pairs) {
    const last = result[result.length - 1];
    if (last && sourceKeys[sourceKeys.length - 1] === event.key) {
      last.sets.push(set);
      continue;
    }
    const run = (runsByKey.get(event.key) ?? 0) + 1;
    runsByKey.set(event.key, run);
    result.push({ ...event, key: run === 1 ? event.key : `${event.key}#${run}`, sets: [set] });
    sourceKeys.push(event.key);
  }
  return result;
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

/**
 * Plan 39.1-33 (R1, UI-SPEC §7.10 as narrowed by this plan): fits the
 * already limit-trimmed oldest-first event→set→game tree to a single row of
 * at most `effectiveWidthPx`, keeping the most recent whole SETS (never
 * splitting a set — a set is the drill unit, CR-02/CR-03). Walks sets
 * newest-to-oldest across every event; the newest set overall is ALWAYS
 * kept regardless of width (a strip must show at least one set); each
 * further set is kept only while the running total plus its own width and
 * its gap to the previously kept (newer) set stays within
 * `effectiveWidthPx - FORM_STRIP_ROW_SAFETY_PX` — stopping at the first set
 * that would push the total over budget, never skipping ahead to a cheaper
 * later one. A single-game set costs `SET_MIN_HIT_WIDTH_PX` (24px, its
 * minimum hit box); a multi-game set costs
 * `games.length * tickWidthPx + (games.length - 1) * FORM_STRIP_TICK_GAP_PX`
 * when that exceeds the minimum (a manual session of several games can be
 * wider than 24px). Rebuilds events oldest-first with only the kept sets,
 * preserving each surviving event's own set order and dropping any event
 * left with none.
 */
function fitEventsToWidth(
  events: FormStripEvent[],
  effectiveWidthPx: number,
  tickWidthPx: number,
): FormStripEvent[] {
  const keptSetKeys = new Set<string>();
  let runningWidthPx = 0;
  let previousEventKey: string | null = null;

  outer: for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex]!;
    for (let setIndex = event.sets.length - 1; setIndex >= 0; setIndex -= 1) {
      const set = event.sets[setIndex]!;
      const setWidthPx = Math.max(
        SET_MIN_HIT_WIDTH_PX,
        set.games.length * tickWidthPx + (set.games.length - 1) * FORM_STRIP_TICK_GAP_PX,
      );
      if (keptSetKeys.size === 0) {
        // The newest set overall — always kept, unconditionally.
        keptSetKeys.add(set.key);
        runningWidthPx = setWidthPx;
        previousEventKey = event.key;
        continue;
      }
      const gapPx =
        event.key === previousEventKey
          ? FORM_STRIP_SAME_EVENT_GAP_PX
          : FORM_STRIP_DIFFERENT_EVENT_GAP_PX;
      const costPx = setWidthPx + gapPx;
      if (runningWidthPx + costPx > effectiveWidthPx - FORM_STRIP_ROW_SAFETY_PX) {
        break outer;
      }
      keptSetKeys.add(set.key);
      runningWidthPx += costPx;
      previousEventKey = event.key;
    }
  }

  const result: FormStripEvent[] = [];
  for (const event of events) {
    const keptSets = event.sets.filter((set) => keptSetKeys.has(set.key));
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
      className={TICK_SLOT_CLASS}
      style={{
        alignItems: game.won ? 'flex-start' : 'flex-end',
        opacity: dimmed ? DIMMED_OPACITY : 1,
      }}
    >
      <span
        data-slot={game.won ? 'form-strip-tick-win' : 'form-strip-tick-loss'}
        className={TICK_BAR_CLASS}
        style={{
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
      className="relative flex items-center justify-center gap-0.5 rounded-sm hover:bg-muted/40 focus:bg-muted/40"
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
      {/*
        Plan 39.1-32 (item 11, UI-SPEC §7.10 rule through the middle of each
        set, §14.6 pads the HIT box not the set): the tick-run holds ONLY the
        ticks and the rule that spans them — the SetGroup above stays the
        (larger) focusable/hoverable hit box, centred via `justify-center`.
        A single-game set now shows a centred tick on its own short rule
        instead of a left-hugging tick trailing an over-wide rule stub, and
        a wrapped strip reads as an evenly spaced sequence.
      */}
      <span data-slot="form-strip-tick-run" className="relative inline-flex items-center gap-0.5">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2"
          style={{ height: 1, backgroundColor: CHART_TOKENS.deemphasisStrong }}
        />
        {set.games.map((game) => (
          <Tick key={game.key} game={game} dimmed={!set.inRecentWindow} />
        ))}
      </span>
    </div>
  );
}

/**
 * Plan 39.1-33 (R1, UI-SPEC §7.10 as narrowed by this plan): one row because
 * plan 39.1-33's R1 regression closed here — the previous per-event 104px
 * labelled minimum width stacked nine session groups into nine labelled rows
 * on a phone (a 1204px Win Rate Trend card at 390x844). The strip now fits
 * to its own measured width and keeps the most recent whole SETS that fit,
 * captioned once at each end instead of a label under every event.
 */
export function FormStrip({
  events,
  limit,
  labels,
  onSelectSet,
  availableWidthPx,
}: FormStripProps) {
  const totalGames = countGames(events);

  // Every hook lives ABOVE the 0-games early return below — a rerender from
  // N games to 0 and back must never change hook order.
  const rootRef = useRef<HTMLDivElement>(null);
  const [measuredWidthPx, setMeasuredWidthPx] = useState(0);
  const [measuredTickWidthPx, setMeasuredTickWidthPx] = useState(0);
  const hasGames = totalGames > 0;
  useLayoutEffect(() => {
    if (!hasGames) {
      return undefined;
    }
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }
    function measure() {
      if (!root) {
        return;
      }
      setMeasuredWidthPx(root.clientWidth);
      const tick = root.querySelector<HTMLElement>('[data-slot="form-strip-tick"]');
      if (tick) {
        setMeasuredTickWidthPx(tick.getBoundingClientRect().width);
      }
    }
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [hasGames]);

  if (totalGames === 0) {
    return <div data-slot="form-strip-empty">{labels.empty}</div>;
  }

  const trimmedEvents = trimToLimit(orderSetsChronologically(events), limit);
  const legendParts = splitLegendParts(labels.legend);

  // D-04: an explicit `availableWidthPx` wins outright; otherwise the
  // measured root width — 0 (unmeasured, the very first frame, or no
  // ResizeObserver) means NO fit is applied, only `limit` bounds the strip.
  const effectiveWidthPx = availableWidthPx ?? measuredWidthPx;
  const tickWidthPx =
    measuredTickWidthPx > 0 ? measuredTickWidthPx : FORM_STRIP_FALLBACK_TICK_WIDTH_PX;
  const shownEvents =
    effectiveWidthPx > 0
      ? fitEventsToWidth(trimmedEvents, effectiveWidthPx, tickWidthPx)
      : trimmedEvents;
  const shownGames = countGames(shownEvents);
  const oldestShownEvent = shownEvents[0];
  const newestShownEvent = shownEvents[shownEvents.length - 1];

  return (
    // Plan 39.1-20 Task 3 [Rule 1]: `min-w-0` on this flex-column root —
    // without it, a flex item that CONTAINS the row below computes its own
    // max-content size as if it had unlimited width and refuses to shrink
    // inside an ancestor flex/grid column.
    <div ref={rootRef} className="flex min-w-0 flex-col gap-2" data-slot="form-strip-root">
      {/*
        Plan 39.1-33 (R1): `flex-nowrap` + `overflow-hidden` — the row no
        longer wraps onto multiple labelled lines (the 39.1-31/32 regression
        this plan closes); `overflow-hidden` guards only the first
        unmeasured frame (effectiveWidthPx === 0, before the layout effect
        below has measured), since the fit above already keeps the row
        within its own measured width on every subsequent render — proven by
        guard:layout's form-strip-overflow check.
      */}
      <div
        role="group"
        aria-label={labels.summary({ shown: shownGames, total: totalGames })}
        className="flex min-w-0 flex-nowrap gap-4 overflow-hidden"
      >
        {shownEvents.map((event) => {
          const name = `${event.label}${LEGEND_SEPARATOR}${drawnRecord(event)}`;
          return (
            <div
              key={event.key}
              data-slot="form-strip-event"
              role="group"
              aria-label={name}
              title={name}
              className="flex shrink-0 gap-1"
            >
              {event.sets.map((set) => (
                <SetGroup key={set.key} set={set} onSelectSet={onSelectSet} />
              ))}
            </div>
          );
        })}
      </div>
      {/*
        Plan 39.1-33 (R1): one caption line, first/last shown event only —
        replaces the per-event label/record line the row above used to
        carry. Two or more shown events -> a two-column grid (oldest at the
        start, newest at the end); exactly one shown event -> caption-first
        only (there is no "last" distinct from "first").
      */}
      {oldestShownEvent && (
        <div
          data-slot="form-strip-caption"
          className={
            shownEvents.length >= 2
              ? 'grid grid-cols-2 gap-2 text-xs leading-4 text-muted-foreground'
              : 'text-xs leading-4 text-muted-foreground'
          }
        >
          <span
            data-slot="form-strip-caption-first"
            data-truncate-guard
            className="min-w-0 truncate text-start"
            title={oldestShownEvent.label}
          >
            {oldestShownEvent.label}
          </span>
          {shownEvents.length >= 2 && newestShownEvent && (
            <span
              data-slot="form-strip-caption-last"
              data-truncate-guard
              className="min-w-0 truncate text-end"
              title={newestShownEvent.label}
            >
              {newestShownEvent.label}
            </span>
          )}
        </div>
      )}
      {/*
        Plan 39.1-32 (item 11, UI-SPEC §7.10 legend, §6.5 rule 2): a
        `justify-between` two-item row squeezes the legend into whatever
        space the shown-of-total token leaves. `flex-wrap` lets the legend's
        own whole-token parts (never mid-word) wrap onto their own lines
        while shown-of-total keeps `ms-auto` to stay right-aligned when it
        fits on the legend's line.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground">
        {legendParts.length >= 2 ? (
          legendParts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <span aria-hidden="true">{'·'}</span>}
              <span data-slot="form-strip-legend-item" className="whitespace-nowrap">
                {part}
              </span>
            </Fragment>
          ))
        ) : (
          <span data-slot="form-strip-legend-item">{labels.legend}</span>
        )}
        {labels.shownOfTotal && shownGames < totalGames && (
          <span
            data-slot="form-strip-shown-of-total"
            className="ms-auto whitespace-nowrap tabular-nums"
          >
            {labels.shownOfTotal({ shown: shownGames, total: totalGames })}
          </span>
        )}
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
