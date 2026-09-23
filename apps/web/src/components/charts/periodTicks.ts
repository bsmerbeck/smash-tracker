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

function formatShortDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

function formatMonthYear(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

function formatYearOnly(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
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
const MIN_TICK_LABEL_GAP_PX = 8;

interface KeptTick {
  key: string;
  left: number;
  right: number;
}

/**
 * UI-SPEC §7.13/§11: chooses WHICH of the grain rule's candidate keys are
 * legible at the plotted pixel width — a pure, deterministic pass over
 * `grainRuleCandidateKeys`' output (never Recharts' own measurement-driven
 * thinning, unreachable under jsdom per `eventTicks.ts`'s doc comment).
 * Each candidate's anchored label span (start-anchored for the first
 * candidate, end-anchored for the last, centred otherwise — mirroring how
 * the axis actually renders each tick's text) is kept only when it clears
 * `MIN_TICK_LABEL_GAP_PX` from the previously KEPT span; the first candidate
 * is always kept. For a fine grain (game/set/eventSession), the series'
 * FINAL point is always appended too — even when it wasn't a `% 4` candidate
 * — dropping the previously kept tick first if the two would collide, so the
 * most recent period is always legible. Week/month/quarter/year grains never
 * append a point outside the grain rule — their own last candidate already
 * lands on (or near) the series end.
 */
export function selectPeriodTicks(
  points: PeriodPoint[],
  opts: { plotWidthPx: number; locale: string },
): string[] {
  if (points.length === 0) return [];
  const { plotWidthPx, locale } = opts;

  const candidateKeys = grainRuleCandidateKeys(points);
  const byKey = new Map(points.map((point) => [point.key, point]));
  const n = points.length;
  const xForKey = new Map(
    points.map((point, i) => [point.key, n > 1 ? (i * plotWidthPx) / (n - 1) : 0]),
  );

  function labelSpanFor(
    key: string,
    isFirst: boolean,
    isLast: boolean,
  ): { left: number; right: number } {
    const point = byKey.get(key)!;
    const label = formatPeriodTickLabel(point, locale);
    const w = estimateTickLabelWidthPx(label);
    const x = xForKey.get(key)!;
    if (isFirst) return { left: x, right: x + w };
    if (isLast) return { left: x - w, right: x };
    return { left: x - w / 2, right: x + w / 2 };
  }

  const kept: KeptTick[] = [];
  candidateKeys.forEach((key, i) => {
    const isFirst = i === 0;
    const isLast = i === candidateKeys.length - 1;
    const span = labelSpanFor(key, isFirst, isLast);
    if (kept.length === 0) {
      kept.push({ key, ...span });
      return;
    }
    const prev = kept[kept.length - 1]!;
    if (span.left - prev.right >= MIN_TICK_LABEL_GAP_PX) {
      kept.push({ key, ...span });
    }
  });

  const grain: PeriodGrain | undefined = points[0]?.grain;
  const appendsFinalPoint = grain !== undefined && isFineGrain(grain);
  if (appendsFinalPoint) {
    const lastPoint = points[points.length - 1]!;
    const lastKey = lastPoint.key;
    if (kept.length === 0 || kept[kept.length - 1]!.key !== lastKey) {
      const lastSpan = labelSpanFor(lastKey, false, true);
      const prev = kept[kept.length - 1];
      if (prev && lastSpan.left - prev.right < MIN_TICK_LABEL_GAP_PX) {
        kept.pop();
      }
      kept.push({ key: lastKey, ...lastSpan });
    }
  }

  return kept.map((tick) => tick.key);
}
