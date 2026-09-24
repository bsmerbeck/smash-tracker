import type { PeriodGrain, PeriodPoint } from '@smash-tracker/shared';
import { formatEventTickLabel } from './eventTicks';

/**
 * VIZ-01/VIZ-03 (UI-SPEC §7.13, §11 — plan 39.1-30 Task 1): the ONLY place
 * `TrendLine.tsx`'s period mode gets human-readable axis-tick and table-row
 * text from. `periodSeries.ts` (the shared engine) hands over a
 * locale-independent `label`, a `startMs`, and a `grain` — the engine never
 * localises and never formats a date (its own doc comment). This module is
 * pure: no React import, no chart-library import, no date-bucketing helper
 * of the kind `periodSeries.ts` owns (`isoWeekKey`/`monthKey`/`quarterKey`/
 * `yearKey`/`splitIntoSessions`/`buildSetTimeline`/`buildEventSessionPoints`)
 * — it only FORMATS and SELECTS what the engine already computed, mirroring
 * `eventTicks.ts`'s own "density/format, never bucket" boundary.
 */

/**
 * Tournament blocks are recognised by the engine key prefix, not by grain
 * alone — `eventSession` also carries plain SESSION points (the fallback for
 * non-tournament games), which format as a date like every other fine-grain
 * point. `periodSeries.ts`'s `tournamentBlockToPoint` is the sole producer of
 * this prefix.
 */
const TOURNAMENT_BLOCK_KEY_PREFIX = 'eventSession:tournament:';

function isTournamentBlock(point: PeriodPoint): boolean {
  return point.key.startsWith(TOURNAMENT_BLOCK_KEY_PREFIX);
}

/** `game`/`set`/`eventSession`(session) points share one fine grain: a specific instant worth naming as a date. */
function isFineGrain(grain: PeriodGrain): boolean {
  return grain === 'game' || grain === 'set' || grain === 'eventSession';
}

/**
 * `Intl.DateTimeFormat` construction is far costlier than `format()`, and
 * the tick selector formats every candidate on every render — one cached
 * formatter per (kind, locale).
 */
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(
  kind: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cacheKey = `${kind}|${locale}`;
  let formatter = dateFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

/**
 * WR-02 (39.1-REVIEW.md): a fine-grain point (game/set/session) names a real
 * game instant, so it is labelled in the host's LOCAL time zone — the same
 * rule as the results list (`toLocaleDateString(i18n.language)`), the
 * form-strip tick titles and the session captions on the same page. (It was
 * UTC, which put an evening game in the Americas on the next day.) Coarse
 * grains below stay UTC because `periodSeries.ts` buckets them in UTC.
 * The cached formatter captures the host zone on first use.
 */
function formatShortDate(ms: number, locale: string): string {
  return cachedFormatter('shortDate', locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}

function formatMonthYear(ms: number, locale: string): string {
  return cachedFormatter('monthYear', locale, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

function formatYearOnly(ms: number, locale: string): string {
  return cachedFormatter('year', locale, { year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
}

/**
 * UI-SPEC §7.13's axis tick text: a tournament block truncates through the
 * kit's existing `formatEventTickLabel` (never a second truncation rule); a
 * fine-grain point (game/set/eventSession-session) is a short date; week and
 * month grains read as month-year (their own individual date would be
 * noise); quarter and year grains read as the year alone.
 */
export function formatPeriodTickLabel(point: PeriodPoint, locale: string): string {
  if (point.grain === 'eventSession' && isTournamentBlock(point)) {
    return formatEventTickLabel(point.label);
  }
  if (isFineGrain(point.grain)) {
    return formatShortDate(point.startMs, locale);
  }
  if (point.grain === 'week' || point.grain === 'month') {
    return formatMonthYear(point.startMs, locale);
  }
  return formatYearOnly(point.startMs, locale);
}

/**
 * UI-SPEC §7.13's table-twin row text: a fine-grain point (whose engine
 * `label` is an opaque ISO string or a set id) formats to the same short
 * date the axis uses; every coarser grain's engine `label` is ALREADY the
 * grain-appropriate human-legible key (`2024-Q3`, `2024-W12`, `2024-11`,
 * `2024`) and is kept unchanged — reformatting it would only paraphrase what
 * the engine already produced.
 */
export function formatPeriodRowLabel(point: PeriodPoint, locale: string): string {
  if (point.grain === 'eventSession' && isTournamentBlock(point)) {
    return formatEventTickLabel(point.label);
  }
  if (isFineGrain(point.grain)) {
    return formatShortDate(point.startMs, locale);
  }
  return point.label;
}

/** CHART_AXIS_FONT_SIZE (12px) sibling constant — the per-character pixel allowance a legible tick label needs, ASCII vs. wide (CJK et al.) characters. */
const ASCII_TICK_CHAR_WIDTH_PX = 7;
const WIDE_TICK_CHAR_WIDTH_PX = 12;

/**
 * A conservative, DOM-free estimate of a tick label's rendered pixel width —
 * `selectPeriodTicks` below needs SOME width estimate to decide collisions
 * without measuring text in a browser (the same problem `eventTicks.ts`'s
 * doc comment describes jsdom being unable to solve via
 * `getBoundingClientRect`). ASCII characters (`\x00-\x7F`) get the kit's
 * documented 7px/character axis-text allowance; anything else (CJK, accented
 * Latin, etc.) gets a wider 12px/character allowance.
 */
export function estimateTickLabelWidthPx(label: string): number {
  let width = 0;
  for (const ch of label) {
    // Code-point comparison, not a `\x00-\x7F` regex class — ESLint's
    // `no-control-regex` rejects any regex containing a raw control-character
    // escape, which a 0x00-anchored ASCII range necessarily does.
    const isAscii = (ch.codePointAt(0) ?? 0) <= 0x7f;
    width += isAscii ? ASCII_TICK_CHAR_WIDTH_PX : WIDE_TICK_CHAR_WIDTH_PX;
  }
  return width;
}

/**
 * Today's grain rule — moved out of `TrendLine.tsx` UNCHANGED (byte-for-byte
 * the same candidate selection its retired `selectPeriodXAxisTicks` used):
 * years only (quarter/year grain, one candidate per distinct UTC year),
 * month starts (week grain, one candidate per distinct UTC year-month), every
 * 4th point otherwise (game/set/eventSession).
 */
function grainRuleCandidateKeys(points: PeriodPoint[]): string[] {
  const grain: PeriodGrain | undefined = points[0]?.grain;
  if (grain === 'quarter' || grain === 'year') {
    const seenYears = new Set<string>();
    return points
      .filter((point) => {
        const year = String(new Date(point.startMs).getUTCFullYear());
        if (seenYears.has(year)) return false;
        seenYears.add(year);
        return true;
      })
      .map((point) => point.key);
  }
  if (grain === 'week') {
    const seenMonths = new Set<string>();
    return points
      .filter((point) => {
        const d = new Date(point.startMs);
        const tickMonthGroup = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        if (seenMonths.has(tickMonthGroup)) return false;
        seenMonths.add(tickMonthGroup);
        return true;
      })
      .map((point) => point.key);
  }
  return points.filter((_, i) => i % 4 === 0).map((point) => point.key);
}

/**
 * The gap SELECTION requires internally, strictly larger than the oracle's
 * own `MIN_TICK_GAP_PX` (4px, `guardLayoutCore.mjs`) by design: this
 * selector decides collisions from `estimateTickLabelWidthPx`'s conservative
 * per-character PIXEL ESTIMATE, not the real rendered glyph width a browser
 * measures — a candidate pair whose ESTIMATED spans clear the oracle's bare
 * 4px floor by only a hair can still collide once real font metrics (kerning,
 * proportional glyph widths the flat per-character estimate can't capture)
 * are in play. Proven empirically against the real Matchups page (39.1-30
 * Task 1 GREEN iteration 1): two daily date labels ("Nov 14, 2023" / "Nov
 * 15, 2023") that this selector kept at the 4px floor measured only 1.9px
 * apart in real Chrome — a genuine tick-overlap. Doubling the internal floor
 * gives this estimate-vs-reality gap enough headroom that it no longer
 * crosses the oracle's own threshold in practice.
 */
export const MIN_TICK_LABEL_GAP_PX = 8;

export type PeriodTickAnchor = 'start' | 'middle' | 'end';

/** One SELECTED tick exactly as the axis draws it: its text, x, SVG `text-anchor`, and estimated span. */
export interface PeriodTickLayout {
  key: string;
  label: string;
  x: number;
  anchor: PeriodTickAnchor;
  left: number;
  right: number;
}

/**
 * CR-01 (39.1-REVIEW.md): THE period axis's anchor rule, used by both the
 * selector below and `TrendLine.tsx`'s tick renderer (which reads each
 * tick's `anchor` off `layoutPeriodTicks`' output — it never derives one
 * itself). Anchors are decided by position among the SELECTED ticks, never
 * among the grain rule's candidates: the first selected tick is
 * start-anchored, the last end-anchored, every other centred. A lone tick
 * anchors towards whichever plot edge it sits nearer, so it stays inside
 * the plot.
 */
function periodTickAnchor(
  index: number,
  count: number,
  x: number,
  plotWidthPx: number,
): PeriodTickAnchor {
  if (count === 1) return x > plotWidthPx / 2 ? 'end' : 'start';
  if (index === 0) return 'start';
  if (index === count - 1) return 'end';
  return 'middle';
}

function spanFor(x: number, w: number, anchor: PeriodTickAnchor): { left: number; right: number } {
  if (anchor === 'start') return { left: x, right: x + w };
  if (anchor === 'end') return { left: x - w, right: x };
  return { left: x - w / 2, right: x + w / 2 };
}

/** Point-scale x of every key across the plot width — the same placement Recharts gives a padded category axis. */
function xPositions(points: PeriodPoint[], plotWidthPx: number): Map<string, number> {
  const n = points.length;
  return new Map(points.map((point, i) => [point.key, n > 1 ? (i * plotWidthPx) / (n - 1) : 0]));
}

/**
 * Lays a SELECTED tick set out exactly as the axis renders it — label text
 * (`formatPeriodTickLabel`), x, anchor (`periodTickAnchor`) and estimated
 * span (`estimateTickLabelWidthPx`). The single source of both the
 * selector's final collision pass and the renderer's per-tick text/anchor.
 */
export function layoutPeriodTicks(
  points: PeriodPoint[],
  tickKeys: string[],
  opts: { plotWidthPx: number; locale: string },
): PeriodTickLayout[] {
  const { plotWidthPx, locale } = opts;
  const byKey = new Map(points.map((point) => [point.key, point]));
  const xForKey = xPositions(points, plotWidthPx);
  return tickKeys.flatMap((key, index) => {
    const point = byKey.get(key);
    const x = xForKey.get(key);
    if (!point || x === undefined) return [];
    const label = formatPeriodTickLabel(point, locale);
    const anchor = periodTickAnchor(index, tickKeys.length, x, plotWidthPx);
    return [{ key, label, x, anchor, ...spanFor(x, estimateTickLabelWidthPx(label), anchor) }];
  });
}

/** Index of the first adjacent pair whose laid-out spans sit closer than the selection gap, or -1. */
function firstCollision(layout: PeriodTickLayout[]): number {
  for (let j = 0; j + 1 < layout.length; j += 1) {
    if (layout[j + 1]!.left - layout[j]!.right < MIN_TICK_LABEL_GAP_PX) return j;
  }
  return -1;
}

/**
 * UI-SPEC §7.13/§11: chooses WHICH of the grain rule's candidate keys are
 * legible at the plotted pixel width — a pure, deterministic pass over
 * `grainRuleCandidateKeys`' output (never Recharts' own measurement-driven
 * thinning, unreachable under jsdom per `eventTicks.ts`'s doc comment).
 *
 * 1. Greedy thinning: each candidate is kept when its estimated span clears
 *    `MIN_TICK_LABEL_GAP_PX` from the previously kept span; the first
 *    candidate is always kept. For a fine grain (game/set/eventSession) the
 *    series' FINAL point is then appended — even when it wasn't a `% 4`
 *    candidate — so the most recent period is always legible. Week/month/
 *    quarter/year grains never append a point outside the grain rule.
 * 2. CR-01 settle pass: the greedy pass can only guess each tick's final
 *    anchor (the last kept tick renders end-anchored, not centred; a
 *    candidate estimated end-anchored renders centred once a final point is
 *    appended after it). So the kept set is re-laid out with
 *    `layoutPeriodTicks` — the renderer's own anchors — and, while any
 *    adjacent pair collides, a MIDDLE tick of that pair is dropped (never
 *    the first or last, which are the series' anchoring edges). If only two
 *    ticks remain and still collide, a fine grain keeps the last (most
 *    recent) and a coarse grain keeps the first. Dropping a middle tick
 *    never changes any other tick's anchor, so each step only widens gaps
 *    and the pass terminates.
 */
export function selectPeriodTickLayout(
  points: PeriodPoint[],
  opts: { plotWidthPx: number; locale: string },
): PeriodTickLayout[] {
  if (points.length === 0) return [];
  const { plotWidthPx, locale } = opts;

  const candidateKeys = grainRuleCandidateKeys(points);
  const byKey = new Map(points.map((point) => [point.key, point]));
  const xForKey = xPositions(points, plotWidthPx);

  function estimatedSpan(key: string, anchor: PeriodTickAnchor): { left: number; right: number } {
    const label = formatPeriodTickLabel(byKey.get(key)!, locale);
    return spanFor(xForKey.get(key)!, estimateTickLabelWidthPx(label), anchor);
  }

  const kept: { key: string; right: number }[] = [];
  candidateKeys.forEach((key, i) => {
    const anchor = periodTickAnchor(i, candidateKeys.length, xForKey.get(key)!, plotWidthPx);
    const span = estimatedSpan(key, anchor);
    const prev = kept[kept.length - 1];
    if (!prev || span.left - prev.right >= MIN_TICK_LABEL_GAP_PX) {
      kept.push({ key, right: span.right });
    }
  });

  const grain: PeriodGrain | undefined = points[0]?.grain;
  const fine = grain !== undefined && isFineGrain(grain);
  const keptKeys = kept.map((tick) => tick.key);
  if (fine) {
    const lastKey = points[points.length - 1]!.key;
    if (keptKeys[keptKeys.length - 1] !== lastKey) keptKeys.push(lastKey);
  }

  let layout = layoutPeriodTicks(points, keptKeys, opts);
  for (let j = firstCollision(layout); j !== -1; j = firstCollision(layout)) {
    if (keptKeys.length === 2) {
      keptKeys.splice(fine ? 0 : 1, 1);
    } else {
      // j + 1 is the last tick only when j is a middle tick (length >= 3).
      keptKeys.splice(j + 1 === keptKeys.length - 1 ? j : j + 1, 1);
    }
    layout = layoutPeriodTicks(points, keptKeys, opts);
  }
  return layout;
}

/** The selected tick keys alone — `selectPeriodTickLayout(...).map((tick) => tick.key)`. */
export function selectPeriodTicks(
  points: PeriodPoint[],
  opts: { plotWidthPx: number; locale: string },
): string[] {
  return selectPeriodTickLayout(points, opts).map((tick) => tick.key);
}
