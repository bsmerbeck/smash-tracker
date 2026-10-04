import type { ValueSeriesGrain } from '@smash-tracker/shared';
import { estimateTickLabelWidthPx } from './periodTicks';
import {
  PERIOD_REFERENCE_LABEL_CLEARANCE_PX,
  PERIOD_VALUE_LABEL_BELOW_OFFSET_PX,
  PERIOD_VALUE_LABEL_OFFSET_PX,
} from './trendGeometry';

/**
 * Plan 41-02 (UI-SPEC §7.1, DD-41-01 / DD-41-13 / DD-41-14): the pure geometry behind `TrendLine
 * mode="value"` — the fitted y domain and its hairline ticks, the measured y gutter, the honest
 * reference-line placement rule, the direct-label collision rule and the plot's chrome. No React and
 * no chart-library import: every rule is a function of plain numbers, unit-tested with no DOM
 * (`valueTrendGeometry.test.ts`), and the chart feeds it the geometry it renders with.
 */

/** UI-SPEC §7.1: the fitted domain's padding either side of the data, as a share of the data span. */
export const VALUE_DOMAIN_PADDING_SHARE = 0.04;
/** UI-SPEC §7.1: the snapped domain carries at least this many solid hairlines. */
export const VALUE_HAIRLINES_MIN = 4;
/** UI-SPEC §7.1: …and at most this many. */
export const VALUE_HAIRLINES_MAX = 6;
/** DD-41-14: a tick label's width allowance per character (px) — the kit's 12px axis-text estimate. */
export const GUTTER_CHAR_PX = 7;
/** DD-41-14: the gutter's clearance beyond its longest tick label (px). */
export const GUTTER_PAD_PX = 8;
/** DD-41-13: a reference value further than this many data spans from the nearest data edge is not drawn as a line. */
export const REFERENCE_NEAR_SPAN_FACTOR = 2;

/** UI-SPEC §7.1 / §3: the plot's top margin — room for a direct label above the peak. */
export const VALUE_MARGIN_TOP_PX = 16;
/** UI-SPEC §7.1: the plot's right margin — the last dot's ring stays whole. */
export const VALUE_MARGIN_RIGHT_PX = 12;
/** UI-SPEC §3: the x tick band under the LAST panel (and under a single plot). */
export const VALUE_X_AXIS_BAND_PX = 26;
/** UI-SPEC §3: the bottom margin of a plot that draws no x axis. */
export const VALUE_MARGIN_BOTTOM_PX = 6;
/** The x axis's inset on each side (px) — a dot on the first or last reading is never cut by the plot edge. */
export const VALUE_X_AXIS_PADDING_PX = 8;

/** UI-SPEC §7.1 marks (px). The last / close dot, the calibration diamond, its hit rect and the surface rings. */
export const VALUE_DOT_DIAMETER_PX = 5;
export const VALUE_DOT_RING_PX = 2;
export const VALUE_DIAMOND_DIAGONAL_PX = 9;
export const VALUE_DIAMOND_STROKE_PX = 1.5;
export const VALUE_HIT_RECT_PX = 24;

/** The SVG height of a value plot: its plot box (`plotPx`) plus the top margin and the bottom band / margin. */
export function valueChartHeight(plotPx: number, drawXAxis: boolean): number {
  return plotPx + VALUE_MARGIN_TOP_PX + (drawXAxis ? VALUE_X_AXIS_BAND_PX : VALUE_MARGIN_BOTTOM_PX);
}

/** Where a reference value sits relative to the plotted values (DD-41-13). */
export type ReferencePlacement = 'line' | 'above-range' | 'below-range';

/**
 * DD-41-13: a reference (an Elite threshold) is drawn as a line only when it lies within
 * `REFERENCE_NEAR_SPAN_FACTOR` x the data span of the nearest data edge — otherwise pulling it into the
 * domain would squash the readings into a sliver. A reference inside the data range is always a line.
 * Non-finite values are ignored; with no finite value there is nothing to compare, so the line stands.
 */
export function referencePlacement(
  values: readonly number[],
  referenceValue: number,
): ReferencePlacement {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0 || !Number.isFinite(referenceValue)) return 'line';
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const reach = (hi - lo) * REFERENCE_NEAR_SPAN_FACTOR;
  if (referenceValue > hi) return referenceValue - hi <= reach ? 'line' : 'above-range';
  if (referenceValue < lo) return lo - referenceValue <= reach ? 'line' : 'below-range';
  return 'line';
}

export interface ValueDomainFit {
  /** The snapped `[lo, hi]` y domain. */
  domain: [number, number];
  /** One tick per solid hairline, ascending, each a multiple of `step`. */
  ticks: number[];
  /** The 1-2-5 step the ticks sit on. */
  step: number;
}

/** The 1-2-5 steps from a power of ten below `rangeOver6` upward. */
function nicenessSteps(rawStep: number): number[] {
  const base = 10 ** (Math.floor(Math.log10(rawStep)) - 1);
  const out: number[] = [];
  for (let exponent = 0; exponent < 4; exponent++) {
    for (const multiplier of [1, 2, 5]) out.push(multiplier * base * 10 ** exponent);
  }
  return out;
}

function snapToStep(
  lo: number,
  hi: number,
  step: number,
): { lo: number; hi: number; count: number } {
  const snappedLo = Math.floor(lo / step + 1e-9) * step;
  const snappedHi = Math.ceil(hi / step - 1e-9) * step;
  return { lo: snappedLo, hi: snappedHi, count: Math.round((snappedHi - snappedLo) / step) + 1 };
}

/**
 * UI-SPEC §7.1's fitted y domain: the data ± 4% of its span, snapped outward to a 1-2-5 step that
 * gives 4–6 solid hairlines. A reference joins the fit only when its placement is `'line'`
 * (DD-41-13). Non-finite values are ignored (T-41-05); with none left the result is `null` and the
 * chart renders its empty path rather than a NaN domain. A flat series (zero span) is widened to a
 * 2% band so the line still sits mid-plot.
 */
export function fitValueDomain(
  values: readonly number[],
  reference?: { value: number; placement: ReferencePlacement },
): ValueDomainFit | null {
  const fitted = values.filter((value) => Number.isFinite(value));
  if (fitted.length === 0) return null;
  if (reference && reference.placement === 'line' && Number.isFinite(reference.value)) {
    fitted.push(reference.value);
  }
  const min = Math.min(...fitted);
  const max = Math.max(...fitted);
  const span = max - min > 0 ? max - min : Math.max(Math.abs(max) * 0.02, 1);
  const lo = min - span * VALUE_DOMAIN_PADDING_SHARE;
  const hi = max + span * VALUE_DOMAIN_PADDING_SHARE;
  const range = hi - lo;

  // The finest step whose snapped domain carries at most 6 hairlines. When the next step up is so
  // coarse that the snap leaves fewer than 4 (data span 84 on a step of 50 spans 3), the domain is
  // widened by whole steps — alternately up and down — until 4 hairlines stand.
  let fit: { lo: number; hi: number; count: number; step: number } | null = null;
  for (const step of nicenessSteps(range / VALUE_HAIRLINES_MAX)) {
    const snapped = snapToStep(lo, hi, step);
    if (snapped.count <= VALUE_HAIRLINES_MAX) {
      fit = { ...snapped, step };
      break;
    }
  }
  if (!fit) return null;
  for (let widen = 0; fit.count < VALUE_HAIRLINES_MIN; widen++) {
    if (widen % 2 === 0) fit.hi += fit.step;
    else fit.lo -= fit.step;
    fit.count += 1;
  }
  const ticks = Array.from({ length: fit.count }, (_, i) => fit.lo + i * fit.step);
  return { domain: [fit.lo, fit.hi], ticks, step: fit.step };
}

/**
 * DD-41-14: the y gutter, measured from the formatted tick strings — never assumed. A compact
 * `1088万` (ja) is wider than `9.5M` (en); the widest string decides, plus `GUTTER_PAD_PX`. The width
 * estimate is `estimateTickLabelWidthPx` (7px per ASCII character, the `GUTTER_CHAR_PX` allowance, and
 * its wider CJK allowance), the kit's one text-width estimate.
 */
export function measureYGutterPx(tickStrings: readonly string[]): number {
  let widest = 0;
  for (const text of tickStrings) widest = Math.max(widest, estimateTickLabelWidthPx(text));
  return widest + GUTTER_PAD_PX;
}

/** The fitted y axis a value plot draws: domain, ticks, their host-formatted strings and the measured gutter. */
export interface ValueYAxis extends ValueDomainFit {
  tickLabels: string[];
  gutterPx: number;
}

/**
 * One call for everything the y axis needs. A multiples grid calls it per panel and takes the widest
 * `gutterPx` so every panel's plot starts at the same x and a shared crosshair lands on one vertical.
 */
export function buildValueYAxis(
  values: readonly number[],
  formatTick: (n: number, step: number) => string,
  reference?: { value: number; placement: ReferencePlacement },
): ValueYAxis | null {
  const fit = fitValueDomain(values, reference);
  if (!fit) return null;
  // The step travels with every tick so a host can print enough digits to keep neighbours distinct (CR-02).
  const tickLabels = fit.ticks.map((tick) => formatTick(tick, fit.step));
  return { ...fit, tickLabels, gutterPx: measureYGutterPx(tickLabels) };
}

export type ValueLabelRole = 'last' | 'peak' | 'low';

export interface ValueLabelCandidate {
  role: ValueLabelRole;
  /** The dot's centre (px, chart coordinates). */
  xPx: number;
  yPx: number;
  text: string;
}

export interface PlacedValueLabel extends ValueLabelCandidate {
  /** The text's anchor x, clamped inside the plot. */
  labelXPx: number;
  /** The text's baseline y. */
  baselineYPx: number;
  below: boolean;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** A value label's box for a baseline: 12px text, cap height above the baseline, descent below. */
function labelBox(labelXPx: number, baselineYPx: number, widthPx: number): LabelBox {
  const lineHeight = PERIOD_REFERENCE_LABEL_CLEARANCE_PX;
  return {
    left: labelXPx - widthPx / 2,
    right: labelXPx + widthPx / 2,
    top: baselineYPx - lineHeight * 0.75,
    bottom: baselineYPx + lineHeight * 0.25,
  };
}

export interface PlaceValueLabelsInput {
  candidates: readonly ValueLabelCandidate[];
  plotLeftPx: number;
  plotRightPx: number;
  /** Labels never run below this y (the plot's bottom edge, so a label never lands on the x tick band). */
  plotBottomPx: number;
  /** Every drawn mark's centre and half extent — a label never sits over one it does not name. */
  marks?: readonly { xPx: number; yPx: number; halfPx: number }[];
}

/**
 * UI-SPEC §7.1 / parent §7.13 direct-label rule: labels are placed in priority order (last, peak,
 * low); each tries its preferred slot (above for last and peak, below for low) then the other, centred
 * on its dot and clamped inside the plot. A label whose every slot meets an already placed label, a
 * drawn mark of another point, or leaves the chart is DROPPED — never overlapped.
 */
export function placeValueLabels(input: PlaceValueLabelsInput): PlacedValueLabel[] {
  const { plotLeftPx, plotRightPx, plotBottomPx } = input;
  const placed: PlacedValueLabel[] = [];
  const taken: LabelBox[] = [];
  for (const candidate of input.candidates) {
    const widthPx = estimateTickLabelWidthPx(candidate.text);
    const half = widthPx / 2;
    const labelXPx = Math.min(Math.max(candidate.xPx, plotLeftPx + half), plotRightPx - half);
    const slots: boolean[] = candidate.role === 'low' ? [true, false] : [false, true];
    for (const below of slots) {
      const baselineYPx = below
        ? candidate.yPx + PERIOD_VALUE_LABEL_BELOW_OFFSET_PX
        : candidate.yPx - PERIOD_VALUE_LABEL_OFFSET_PX;
      const box = labelBox(labelXPx, baselineYPx, widthPx);
      if (box.top < 0 || box.bottom > plotBottomPx) continue;
      const overMark = (input.marks ?? []).some(
        (mark) =>
          !(mark.xPx === candidate.xPx && mark.yPx === candidate.yPx) &&
          overlaps(box, {
            left: mark.xPx - mark.halfPx,
            right: mark.xPx + mark.halfPx,
            top: mark.yPx - mark.halfPx,
            bottom: mark.yPx + mark.halfPx,
          }),
      );
      if (overMark || taken.some((other) => overlaps(box, other))) continue;
      taken.push(box);
      placed.push({ ...candidate, labelXPx, baselineYPx, below });
      break;
    }
  }
  return placed;
}

/**
 * The roles that earn a label: the last point always; the peak and the low only when each is distinct
 * from the last and the series has at least three points. Ties keep the first (earlier) occurrence.
 */
export function valueLabelRoles(
  values: readonly number[],
  mode: 'last' | 'last-peak-low',
): { role: ValueLabelRole; index: number }[] {
  if (values.length === 0) return [];
  const last = values.length - 1;
  const roles: { role: ValueLabelRole; index: number }[] = [{ role: 'last', index: last }];
  if (mode === 'last' || values.length < 3) return roles;
  let peak = 0;
  let low = 0;
  values.forEach((value, i) => {
    if (value > values[peak]!) peak = i;
    if (value < values[low]!) low = i;
  });
  if (peak !== last) roles.push({ role: 'peak', index: peak });
  if (low !== last && low !== peak) roles.push({ role: 'low', index: low });
  return roles;
}

export type ValueMarkKind = 'dot' | 'diamond';

/**
 * UI-SPEC §7.1 marks. At reading grain no dot sits on an ordinary reading — only the LAST point
 * (a 5px ringed dot) and a calibration reading (a 9px diamond, "set manually"). At a coarser grain
 * every close carries its 5px dot, and a close that contains a calibration reading draws the diamond
 * instead. `null` = nothing drawn for this point.
 */
export function valueMarkKind(
  point: { kind: 'reading' | 'calibration' | 'close'; containsCalibration: boolean },
  options: { isLast: boolean; grain: string },
): ValueMarkKind | null {
  if (point.containsCalibration) return 'diamond';
  if (options.grain !== 'reading') return 'dot';
  return options.isLast ? 'dot' : null;
}

/** The index of the point whose `xMs` is nearest `ms` (ties keep the earlier point); -1 for no points. */
export function nearestPointIndex(points: readonly { xMs: number }[], ms: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, i) => {
    const distance = Math.abs(point.xMs - ms);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return best;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far (ms) a point may sit from a shared crosshair and still be "at" it: one bucket of the grain
 * the panels share. A `reading` grain has no bucket, so it gets the day the GSP log dates readings by.
 * Month and quarter use the longest calendar span (31 and 92 days), so a real neighbour is never refused.
 */
export const VALUE_GRAIN_BUCKET_MS: Record<ValueSeriesGrain, number> = {
  reading: DAY_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 31 * DAY_MS,
  quarter: 92 * DAY_MS,
};

/**
 * The point nearest `ms`, or `undefined` when there is none within one bucket of `grain` (WR-03): a
 * shared crosshair never reads a value from a different season as if it stood at the cursor.
 */
export function nearestPointWithinGrain<P extends { xMs: number }>(
  points: readonly P[],
  ms: number,
  grain: ValueSeriesGrain,
): P | undefined {
  const index = nearestPointIndex(points, ms);
  const point = points[index];
  if (!point) return undefined;
  return Math.abs(point.xMs - ms) <= VALUE_GRAIN_BUCKET_MS[grain] ? point : undefined;
}

export type ValueTrendHeadKind = 'series' | 'calibration' | 'reference' | 'reference-range';

export interface ValueTrendHeadItem {
  kind: ValueTrendHeadKind;
  text: string;
}

/**
 * The legend a drawn value trend carries: the series always; the calibration diamond only when one is
 * drawn; the reference only when the host supplied its string — the dashed swatch for a line, the
 * host's out-of-range wording (no swatch) when the reference is not drawn as one.
 */
export function valueLegendItems(input: {
  legend: { series: string; calibration?: string; reference?: string } | undefined;
  hasCalibration: boolean;
  referencePlacement: ReferencePlacement | undefined;
}): ValueTrendHeadItem[] {
  const { legend, hasCalibration, referencePlacement: placement } = input;
  if (!legend) return [];
  const items: ValueTrendHeadItem[] = [{ kind: 'series', text: legend.series }];
  if (hasCalibration && legend.calibration) {
    items.push({ kind: 'calibration', text: legend.calibration });
  }
  if (placement !== undefined && legend.reference) {
    items.push({
      kind: placement === 'line' ? 'reference' : 'reference-range',
      text: legend.reference,
    });
  }
  return items;
}
