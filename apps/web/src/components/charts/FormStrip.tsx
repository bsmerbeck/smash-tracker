import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/**
 * Plan 39.1-42 (sketch 003 `stripLegend`): the four legend items the head
 * renders — win and loss carry a swatch tick (position is the channel), the
 * other two are text only.
 */
export interface FormStripLegend {
  win: string;
  loss: string;
  setGap: string;
  eventLabel: string;
}

/** The drawn vs total game counts the kit's formatters receive. */
export interface FormStripCounts {
  shown: number;
  total: number;
}

export interface FormStripLabels {
  /**
   * WR-03 (39.1-REVIEW.md): the row's `role="group"` accessible name — a
   * formatter of the games actually DRAWN (after `limit` and the width fit)
   * and the total in `events`, e.g. "Form strip, 11 of 77 games".
   */
  summary: (counts: FormStripCounts) => string;
  /** Plan 39.1-42: the head's four legend items (rendered only with a `title`). */
  legend: FormStripLegend;
  /**
   * Plan 39.1-42 (sketch 003 `stripSection` / 001-C): the head's overline —
   * e.g. "Form · last 60 games, by event". A formatter of the DRAWN vs total
   * counts may return undefined (plan 35: the career timeline names "every
   * game" only when every game is drawn); no title -> no head at all.
   */
  title?: string | ((counts: FormStripCounts) => string | undefined);
  /**
   * The foot's statement when the kit drew fewer games than `events` hold
   * (the `limit` trim and / or the width fit): `shown` is the games actually
   * drawn, `total` every game in `events`.
   */
  shownOfTotal: (counts: FormStripCounts) => string;
  /** Plan 39.1-42: the foot's statement when every game is drawn. */
  allShown: (counts: { total: number }) => string;
  /** Rendered in place of the strip at 0 games in scope. */
  empty: ReactNode;
  /**
   * Plan 39.1-42 (sketch 003 `winNote`): the recent-window note on the foot
   * line — highlighted window, collapsed horizons or an empty window
   * (replaces `windowEmpty`).
   */
  windowNote?: string;
}

export interface FormStripProps {
  events: FormStripEvent[];
  /**
   * The strip renders at most this many ticks, trimming from the oldest end
   * when the source holds more. `20` (opponent hub), `60` (Matchups since
   * plan 39.1-42, the Fighter hero, the Trends thin strip); `30` stays a
   * valid limit.
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
   * only `limit` bounds the strip.
   */
  availableWidthPx?: number;
}

/** The mark-role colour lookup — the ONE source this file reads a mark colour from (UIX-05). */
const MARK_COLOR = { win: CHART_TOKENS.win, loss: CHART_TOKENS.loss };

const TICK_BAR_RADIUS_PX = 2;
const DIMMED_OPACITY = 0.32;
/**
 * Plan 39.1-32 (item 11) / plan 39.1-42 (PD-42-5, sketch 002-C
 * `.strip-set i`): 8x32px slots, 14px bars; below `sm` (640px) 5x28px slots
 * with 12px bars, so a 41-game casual strip fits a phone. `alignItems`,
 * `opacity`, `backgroundColor` and `borderRadius` stay inline (read by this
 * file's own tests and the UIX-05 colour lookup).
 */
const TICK_SLOT_CLASS = 'inline-flex w-2 h-8 max-sm:w-[5px] max-sm:h-7';
const TICK_BAR_CLASS = 'w-2 h-3.5 max-sm:w-[5px] max-sm:h-3';
/**
 * Plan 39.1-42 (deviation, sketch 003 `.mini-strip` precedent): games inside
 * one set sit 2px apart, 1px below `sm` — with the 24px set hit box
 * (UI-SPEC §14.5) this is what lets the casual account's 41 games in 10
 * session-sets fit a 324px phone strip. The fit reads the rendered gap.
 */
const TICK_RUN_CLASS = 'relative inline-flex items-center gap-0.5 max-sm:gap-px';
/** Plan 39.1-42 (sketch 003 `.strip-ev{min-width:80px}`, 76px below 640px; PD-42-1). */
const EVENT_COLUMN_CLASS = 'flex shrink-0 flex-col min-w-20 max-sm:min-w-[76px]';
const SET_MIN_HIT_WIDTH_PX = 24;
const SET_MIN_HIT_HEIGHT_PX = 32;
const SET_STRIP_TICK_WIDTH_PX = 12;
const SET_STRIP_TICK_HEIGHT_PX = 24;
const SET_STRIP_TICK_BAR_HEIGHT_PX = 10;

/** UI-SPEC §5.2's separator (U+00B7 surrounded by spaces). */
const LABEL_SEPARATOR = ' · ';

/**
 * The fit's geometry until the real one is measured (jsdom's zero-size rects
 * always use these): the tick slot, the gap between ticks of one set and the
 * minimum event column follow the viewport class exactly like the CSS above.
 */
const FALLBACK_GEOMETRY = {
  wide: { tickWidthPx: 8, tickGapPx: 2, minEventWidthPx: 80 },
  phone: { tickWidthPx: 5, tickGapPx: 1, minEventWidthPx: 76 },
} as const;
/** Tailwind's `max-sm` (`width < 40rem`). */
const PHONE_MEDIA_QUERY = '(max-width: 639.98px)';
/** Mirrors the event's tick row `gap-1` (4px) between the sets of one event. */
const FORM_STRIP_SET_GAP_PX = 4;
/** Mirrors the row's `gap-4` (16px) between events (UI-SPEC §7.10). */
const FORM_STRIP_EVENT_GAP_PX = 16;
/** Sub-pixel safety subtracted from the effective width before the fit compares against it. */
const FORM_STRIP_ROW_SAFETY_PX = 1;

interface FitGeometry {
  tickWidthPx: number;
  tickGapPx: number;
  minEventWidthPx: number;
}

function isPhoneViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(PHONE_MEDIA_QUERY).matches
  );
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
 * WR-01 (39.1-REVIEW.md): when every set carries `lastGameMs`, this
 * flattens every (event, set) pair, stable-sorts them by that instant, and
 * regroups CONSECUTIVE runs of the same event: a name that recurs around
 * other groups becomes one display group per contiguous run (a later run's
 * key gets a `#<n>` suffix so React keys stay unique). Without `lastGameMs`
 * on every set the host's own order is kept unchanged.
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

/** An event of the ordered strip with its index in that order (`data-event-order`). */
interface OrderedEvent {
  event: FormStripEvent;
  order: number;
}

/**
 * Trims the oldest-first events down to at most `limit` games, dropping from
 * the OLDEST end and preserving grouping structure — an event or set that
 * becomes empty is dropped; a set only partially trimmed keeps its most
 * recent games. Each kept event keeps its order index.
 */
function trimToLimit(events: OrderedEvent[], limit: number): OrderedEvent[] {
  const total = countGames(events.map(({ event }) => event));
  if (total <= limit) {
    return events;
  }
  let toDrop = total - limit;
  const result: OrderedEvent[] = [];
  for (const { event, order } of events) {
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
      result.push({ event: { ...event, sets: keptSets }, order });
    }
  }
  return result;
}

/** A set's drawn width: its tick run, never below the 24px hit box (the minimum applies to the SET, never per game). */
function setWidthPx(set: FormStripSet, geometry: FitGeometry): number {
  const n = set.games.length;
  return Math.max(SET_MIN_HIT_WIDTH_PX, n * geometry.tickWidthPx + (n - 1) * geometry.tickGapPx);
}

function tickRunWidthPx(event: FormStripEvent, geometry: FitGeometry): number {
  return (
    event.sets.reduce((sum, set) => sum + setWidthPx(set, geometry), 0) +
    Math.max(0, event.sets.length - 1) * FORM_STRIP_SET_GAP_PX
  );
}

function eventWidthPx(event: FormStripEvent, geometry: FitGeometry): number {
  return Math.max(geometry.minEventWidthPx, tickRunWidthPx(event, geometry));
}

/**
 * Plan 39.1-42 fallback (was plan 33's whole fit): the newest event alone is
 * wider than the row — keep its newest SETS that fit (the newest set always;
 * a set is the drill unit). A newest set that alone overflows keeps its
 * newest games that fit, so the row never clips (its label states only the
 * W–L drawn).
 */
function fitSetsInsideEvent(
  event: FormStripEvent,
  budgetPx: number,
  geometry: FitGeometry,
): FormStripEvent {
  const kept: FormStripSet[] = [];
  let runningPx = 0;
  for (let index = event.sets.length - 1; index >= 0; index -= 1) {
    const set = event.sets[index]!;
    const widthPx = setWidthPx(set, geometry);
    if (kept.length === 0) {
      if (widthPx > budgetPx) {
        const fitGames = Math.max(
          1,
          Math.floor((budgetPx + geometry.tickGapPx) / (geometry.tickWidthPx + geometry.tickGapPx)),
        );
        kept.unshift({ ...set, games: set.games.slice(-fitGames) });
        break;
      }
      kept.unshift(set);
      runningPx = widthPx;
      continue;
    }
    if (runningPx + FORM_STRIP_SET_GAP_PX + widthPx > budgetPx) {
      break;
    }
    kept.unshift(set);
    runningPx += FORM_STRIP_SET_GAP_PX + widthPx;
  }
  return { ...event, sets: kept };
}

/**
 * Plan 39.1-42 (sketch 003 `fitStrips`, UI-SPEC §7.10 as amended
 * 2026-09-25): ONE row that keeps the newest EVENTS that fit — an event
 * costs max(its minimum column, its tick run), events sit 16px apart, older
 * events drop first (whole, never a partial older group) and the newest is
 * always kept. When the newest alone is wider than the row, its newest sets
 * that fit are kept (`fitSetsInsideEvent`).
 */
function fitEventsToWidth(
  events: OrderedEvent[],
  effectiveWidthPx: number,
  geometry: FitGeometry,
): OrderedEvent[] {
  const budgetPx = effectiveWidthPx - FORM_STRIP_ROW_SAFETY_PX;
  const kept: OrderedEvent[] = [];
  let runningPx = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]!;
    const widthPx = eventWidthPx(entry.event, geometry);
    if (kept.length === 0) {
      kept.unshift(entry);
      runningPx = widthPx;
      continue;
    }
    if (runningPx + FORM_STRIP_EVENT_GAP_PX + widthPx > budgetPx) {
      break;
    }
    kept.unshift(entry);
    runningPx += FORM_STRIP_EVENT_GAP_PX + widthPx;
  }
  if (kept.length === 1 && runningPx > budgetPx) {
    const only = kept[0]!;
    return [{ ...only, event: fitSetsInsideEvent(only.event, budgetPx, geometry) }];
  }
  return kept;
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
      */}
      <span data-slot="form-strip-tick-run" className={TICK_RUN_CLASS}>
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

/** Sketch 003 `.lg-tk`: a 7x16px legend swatch — a win tick top-aligned, a loss tick bottom-aligned. */
function LegendSwatch({ won }: { won: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-slot="form-strip-legend-swatch"
      className="inline-flex h-4 w-[7px]"
      style={{ alignItems: won ? 'flex-start' : 'flex-end' }}
    >
      <span
        className="h-1.5 w-[7px]"
        style={{
          backgroundColor: won ? MARK_COLOR.win : MARK_COLOR.loss,
          borderRadius: TICK_BAR_RADIUS_PX,
        }}
      />
    </span>
  );
}

function StripHead({ title, legend }: { title: string; legend: FormStripLegend }) {
  const items: { key: string; text: string; swatch?: boolean; won?: boolean }[] = [
    { key: 'win', text: legend.win, swatch: true, won: true },
    { key: 'loss', text: legend.loss, swatch: true, won: false },
    { key: 'setGap', text: legend.setGap },
    { key: 'eventLabel', text: legend.eventLabel },
  ];
  return (
    <div data-slot="form-strip-head" className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
      <p
        data-slot="form-strip-overline"
        className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
      >
        {title}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 text-xs leading-4 text-muted-foreground">
        {items.map((item) => (
          <span
            key={item.key}
            data-slot="form-strip-legend-item"
            className="inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            {item.swatch && <LegendSwatch won={item.won === true} />}
            {item.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Plan 39.1-42 (sketch 003 `formStrip` / `stripSection` / `fitStrips`,
 * sketch 001-C head, UI-SPEC §7.10 as amended 2026-09-25): ONE row of the
 * newest EVENTS that fit its measured width — older events drop first, and
 * every shown event keeps a label row ("label" truncating + the W–L it
 * draws). An optional title renders the head (overline + swatch legend);
 * the foot states "N of M games shown" or "all N games" with the window
 * note. Plan 33's first/last caption is gone.
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
  const [measuredGeometry, setMeasuredGeometry] = useState<Partial<FitGeometry>>({});
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
      const next: Partial<FitGeometry> = {};
      const tick = root.querySelector<HTMLElement>('[data-slot="form-strip-tick"]');
      const tickWidth = tick?.getBoundingClientRect().width ?? 0;
      if (tickWidth > 0) {
        next.tickWidthPx = tickWidth;
      }
      const run = root.querySelector<HTMLElement>('[data-slot="form-strip-tick-run"]');
      const gap = run ? parseFloat(getComputedStyle(run).columnGap) : Number.NaN;
      if (tickWidth > 0 && Number.isFinite(gap) && gap >= 0) {
        next.tickGapPx = gap;
      }
      const column = root.querySelector<HTMLElement>('[data-slot="form-strip-event"]');
      const minWidth = column ? parseFloat(getComputedStyle(column).minWidth) : Number.NaN;
      if (Number.isFinite(minWidth) && minWidth > 0) {
        next.minEventWidthPx = minWidth;
      }
      setMeasuredGeometry((previous) =>
        previous.tickWidthPx === next.tickWidthPx &&
        previous.tickGapPx === next.tickGapPx &&
        previous.minEventWidthPx === next.minEventWidthPx
          ? previous
          : next,
      );
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

  const ordered = orderSetsChronologically(events).map((event, order) => ({ event, order }));
  const trimmedEvents = trimToLimit(ordered, limit);

  // D-04: an explicit `availableWidthPx` wins outright; otherwise the
  // measured root width — 0 (unmeasured, the very first frame, or no
  // ResizeObserver) means NO fit is applied, only `limit` bounds the strip.
  const effectiveWidthPx = availableWidthPx ?? measuredWidthPx;
  const fallback = isPhoneViewport() ? FALLBACK_GEOMETRY.phone : FALLBACK_GEOMETRY.wide;
  const geometry: FitGeometry = {
    tickWidthPx: measuredGeometry.tickWidthPx ?? fallback.tickWidthPx,
    tickGapPx: measuredGeometry.tickGapPx ?? fallback.tickGapPx,
    minEventWidthPx: measuredGeometry.minEventWidthPx ?? fallback.minEventWidthPx,
  };
  const shownEvents =
    effectiveWidthPx > 0
      ? fitEventsToWidth(trimmedEvents, effectiveWidthPx, geometry)
      : trimmedEvents;
  const shownGames = countGames(shownEvents.map(({ event }) => event));
  const counts = { shown: shownGames, total: totalGames };
  const title = typeof labels.title === 'function' ? labels.title(counts) : labels.title;

  return (
    // Plan 39.1-20 Task 3 [Rule 1]: `min-w-0` on this flex-column root —
    // without it, a flex item that CONTAINS the row below computes its own
    // max-content size as if it had unlimited width and refuses to shrink
    // inside an ancestor flex/grid column.
    <div
      ref={rootRef}
      className="flex min-w-0 flex-col gap-2"
      data-slot="form-strip-root"
      data-event-count={ordered.length}
      data-game-count={totalGames}
    >
      {title && <StripHead title={title} legend={labels.legend} />}
      {/*
        Plan 39.1-33 (R1): `flex-nowrap` + `overflow-hidden` — the row never
        wraps; `overflow-hidden` guards only the first unmeasured frame,
        since the fit keeps the row within its measured width afterwards
        (guard:layout's form-strip-fit family).
      */}
      <div
        role="group"
        aria-label={labels.summary(counts)}
        className="flex min-w-0 flex-nowrap items-start gap-4 overflow-hidden"
      >
        {shownEvents.map(({ event, order }) => {
          const record = drawnRecord(event);
          const name = `${event.label}${LABEL_SEPARATOR}${record}`;
          return (
            <div
              key={event.key}
              data-slot="form-strip-event"
              data-event-order={order}
              role="group"
              aria-label={name}
              title={name}
              className={EVENT_COLUMN_CLASS}
            >
              <div data-slot="form-strip-event-ticks" className="flex gap-1">
                {event.sets.map((set) => (
                  <SetGroup key={set.key} set={set} onSelectSet={onSelectSet} />
                ))}
              </div>
              {/*
                Sketch 003 `.strip-label`: the label row never widens its
                column (`w-0 min-w-full`) — the column is max(its minimum,
                its ticks) and the label truncates inside it.
              */}
              <div
                data-slot="form-strip-event-label"
                className="mt-1 flex w-0 min-w-full gap-1.5 text-xs leading-4 text-muted-foreground"
              >
                <span data-truncate-guard className="min-w-0 truncate" title={event.label}>
                  {event.label}
                </span>
                <span className="tabular-nums whitespace-nowrap">{record}</span>
              </div>
            </div>
          );
        })}
      </div>
      {/* Sketch 003 `.strip-foot`: what the strip drew, then the window note. */}
      <div
        data-slot="form-strip-foot"
        className="flex flex-wrap items-center justify-between gap-x-3.5 gap-y-1 text-xs leading-4 text-muted-foreground"
      >
        {shownGames < totalGames ? (
          <span data-slot="form-strip-shown-of-total" className="whitespace-nowrap tabular-nums">
            {labels.shownOfTotal(counts)}
          </span>
        ) : (
          <span data-slot="form-strip-all-shown" className="tabular-nums">
            {labels.allShown({ total: totalGames })}
          </span>
        )}
        {labels.windowNote && <span data-slot="form-strip-window-note">{labels.windowNote}</span>}
      </div>
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
