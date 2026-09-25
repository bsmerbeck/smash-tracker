import { estimateTickLabelWidthPx, MIN_TICK_LABEL_GAP_PX } from './periodTicks';

/**
 * Plan 39.1-34 (UI-SPEC §12.1 "x ticks = years", sketch 002-C `drawRating`):
 * the career timeline's pure time-axis tick selection. Gridlines sit on
 * calendar boundaries — UTC year / month starts (the engine buckets calendar
 * periods in UTC, `calendarBucketBounds`), local midnights for a days-long
 * span (WR-02: a fine-grain date is the host's local day, like every other
 * game/session label). Labels are drawn `TIME_AXIS_LABEL_OFFSET_PX` right of
 * their gridline (anchor start, like the sketch) and thinned with
 * `periodTicks`' own width estimate and gap — one estimate, never a second.
 */

/** Sketch 002-C: a year label is drawn 4px right of its gridline. */
export const TIME_AXIS_LABEL_OFFSET_PX = 4;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** At or above this span the axis ticks years (sketch 002-C's quarter-grain account). */
const YEAR_MODE_MIN_SPAN_MS = 730 * MS_PER_DAY;
/** At or above this span (and below the year span) the axis ticks month starts. */
const MONTH_MODE_MIN_SPAN_MS = 60 * MS_PER_DAY;

/** Label strides tried in order — the smallest that clears the gap wins. */
const YEAR_LABEL_STRIDES = [1, 2, 5, 10] as const;
const MONTH_LABEL_STRIDES = [1, 2, 3, 6, 12] as const;
const DAY_LABEL_STRIDES = [1, 2, 7, 14, 28] as const;

export interface TimeAxisLabel {
  ms: number;
  text: string;
  anchor: 'start';
}

export interface TimeAxisTicks {
  /** Every gridline position, in ms — a label may be thinned away, a gridline never is. */
  gridlines: number[];
  labels: TimeAxisLabel[];
}

/**
 * `Intl.DateTimeFormat` construction is far costlier than `format()` — one
 * cached formatter per (kind, locale), the `periodTicks.ts` pattern.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(
  kind: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cacheKey = `${kind}|${locale}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

function yearGridlines(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  const first = new Date(startMs).getUTCFullYear();
  const last = new Date(endMs).getUTCFullYear();
  for (let year = first; year <= last; year++) {
    const ms = Date.UTC(year, 0, 1);
    if (ms > startMs && ms <= endMs) out.push(ms);
  }
  return out;
}

function monthGridlines(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  const start = new Date(startMs);
  for (let i = 1; ; i++) {
    const ms = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1);
    if (ms > endMs) break;
    if (ms > startMs) out.push(ms);
  }
  return out;
}

function dayGridlines(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  const start = new Date(startMs);
  for (let i = 1; ; i++) {
    const ms = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime();
    if (ms > endMs) break;
    if (ms > startMs) out.push(ms);
  }
  return out;
}

/** The first stride whose labels' estimated spans keep at least `MIN_TICK_LABEL_GAP_PX` apart. */
function thinLabels(
  candidates: TimeAxisLabel[],
  strides: readonly number[],
  xOf: (ms: number) => number,
): TimeAxisLabel[] {
  let chosen = candidates;
  for (const stride of strides) {
    chosen = candidates.filter((_, i) => i % stride === 0);
    const clears = chosen.every((label, i) => {
      if (i === 0) return true;
      const previous = chosen[i - 1]!;
      const previousRight =
        xOf(previous.ms) + TIME_AXIS_LABEL_OFFSET_PX + estimateTickLabelWidthPx(previous.text);
      return xOf(label.ms) + TIME_AXIS_LABEL_OFFSET_PX - previousRight >= MIN_TICK_LABEL_GAP_PX;
    });
    if (clears) return chosen;
  }
  return chosen;
}

/**
 * Picks the timeline's time-axis ticks for a `[startMs, endMs]` domain drawn
 * across `plotWidthPx`: years from a two-year span, month starts from 60
 * days (short month; January carries its year), local midnights below.
 */
export function selectTimeAxisTicks(input: {
  startMs: number;
  endMs: number;
  plotWidthPx: number;
  locale: string;
}): TimeAxisTicks {
  const { startMs, endMs, plotWidthPx, locale } = input;
  const span = endMs - startMs;
  if (span <= 0 || plotWidthPx <= 0) return { gridlines: [], labels: [] };
  const xOf = (ms: number) => ((ms - startMs) / span) * plotWidthPx;

  let gridlines: number[];
  let candidates: TimeAxisLabel[];
  let strides: readonly number[];
  if (span >= YEAR_MODE_MIN_SPAN_MS) {
    gridlines = yearGridlines(startMs, endMs);
    const year = cachedFormatter('year', locale, { year: 'numeric', timeZone: 'UTC' });
    candidates = gridlines.map((ms) => ({ ms, text: year.format(ms), anchor: 'start' }));
    strides = YEAR_LABEL_STRIDES;
  } else if (span >= MONTH_MODE_MIN_SPAN_MS) {
    gridlines = monthGridlines(startMs, endMs);
    const month = cachedFormatter('month', locale, { month: 'short', timeZone: 'UTC' });
    const monthYear = cachedFormatter('monthYear', locale, {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    candidates = gridlines.map((ms) => ({
      ms,
      text: new Date(ms).getUTCMonth() === 0 ? monthYear.format(ms) : month.format(ms),
      anchor: 'start',
    }));
    strides = MONTH_LABEL_STRIDES;
  } else {
    gridlines = dayGridlines(startMs, endMs);
    const day = cachedFormatter('day', locale, { month: 'short', day: 'numeric' });
    candidates = gridlines.map((ms) => ({ ms, text: day.format(ms), anchor: 'start' }));
    strides = DAY_LABEL_STRIDES;
  }
  return { gridlines, labels: thinLabels(candidates, strides, xOf) };
}
