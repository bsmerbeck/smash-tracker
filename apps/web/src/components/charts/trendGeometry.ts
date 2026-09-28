import { confidenceTierFor } from '@smash-tracker/shared';

/**
 * Plan 39.1-37 (VIZ-01, UI-SPEC §7.13, sketch 001-C `trend()`): the pure
 * geometry behind the trend plots — the fitted rate domain, its hairline
 * ticks, the period dot diameters and the all-time reference-label placement
 * rule. No React and no chart-library import: every rule here is a function
 * of plain numbers, unit-tested with no DOM (`trendGeometry.test.ts`), and
 * `TrendLine.tsx` feeds it the same plot-geometry model its tick layout uses.
 */

/** UI-SPEC §7.13: the fitted domain's padding either side of the data, in rate points. */
export const RATE_DOMAIN_PADDING_POINTS = 4;
/** UI-SPEC §7.13: the domain snaps to multiples of this many rate points. */
export const RATE_DOMAIN_SNAP_POINTS = 10;
/** UI-SPEC §7.13: the fitted domain never spans fewer than this many rate points. */
export const RATE_DOMAIN_MIN_SPAN_POINTS = 20;

/**
 * UI-SPEC §7.13's fitted y-domain, exactly sketch 001-C's rule: the data
 * (0-100 rates) ± 4 points, floored/ceiled to 10s, clamped to [0, 100]; a
 * span under 20 widens DOWNWARD first (the sketch's `lo - 10`), then upward
 * when the floor is already 0. An empty input returns the full [0, 100].
 *
 * Callers decide WHAT is fitted — the period trend passes its joined (3+
 * game) periods plus the all-time reference rate, never a sub-floor period
 * (owner decision 2026-09-25: an off-domain sub-floor period is pinned to
 * the edge instead of stretching the axis).
 */
export function fitRateDomain(values: readonly number[]): [number, number] {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return [0, 100];
  }
  const clamped = finite.map((value) => Math.min(100, Math.max(0, value)));
  const snap = RATE_DOMAIN_SNAP_POINTS;
  let lo = Math.max(
    0,
    Math.floor((Math.min(...clamped) - RATE_DOMAIN_PADDING_POINTS) / snap) * snap,
  );
  let hi = Math.min(
    100,
    Math.ceil((Math.max(...clamped) + RATE_DOMAIN_PADDING_POINTS) / snap) * snap,
  );
  if (hi - lo < RATE_DOMAIN_MIN_SPAN_POINTS) {
    lo = Math.max(0, hi - RATE_DOMAIN_MIN_SPAN_POINTS);
  }
  if (hi - lo < RATE_DOMAIN_MIN_SPAN_POINTS) {
    hi = Math.min(100, lo + RATE_DOMAIN_MIN_SPAN_POINTS);
  }
  return [lo, hi];
}

/**
 * Plan 39.1-43 (moved from TrendLine.tsx, plan 37's plot model): the period
 * chart's vertical chrome. The chart's outer margin (Recharts' 5px default,
 * passed explicitly), the y-axis's own top / bottom padding (the room plan
 * 37 keeps for value labels above a top dot and an edge dot's half), and the
 * x-axis band the tick labels occupy (Recharts' default 30px).
 */
export const PERIOD_CHART_MARGIN_PX = 5;
export const PERIOD_Y_AXIS_PADDING_TOP_PX = 24;
export const PERIOD_Y_AXIS_PADDING_BOTTOM_PX = 16;
export const PERIOD_X_AXIS_HEIGHT_PX = 30;

/** Everything a period chart draws outside its value range (px): 5 + 24 above, 16 + 30 + 5 below. */
const PERIOD_VALUE_RANGE_CHROME_PX =
  PERIOD_CHART_MARGIN_PX * 2 +
  PERIOD_Y_AXIS_PADDING_TOP_PX +
  PERIOD_Y_AXIS_PADDING_BOTTOM_PX +
  PERIOD_X_AXIS_HEIGHT_PX;

/**
 * PD-43-3 (sketch 001-C `trend()` and sketch 003 `trend(d, { height: 160 })`):
 * the sketches' 160px trend box IS the value range — the fitted domain's
 * lowest and highest hairlines sit 160px apart, the axis labels, the
 * value-label room and the x-axis band outside it. The Fighter hero and
 * Matchups draw their period trend at this value range.
 */
export const PERIOD_HERO_VALUE_RANGE_PX = 160;

export interface PeriodPlotVerticalModel {
  /** The y (px, chart coordinates) of the fitted domain's top — its highest hairline. */
  valueTopPx: number;
  /** The y (px) of the fitted domain's bottom — its lowest hairline. */
  valueBottomPx: number;
  /** `valueBottomPx - valueTopPx`: the span the domain's values are drawn across. */
  valueRangePx: number;
}

/**
 * The ONE period plot-geometry model (plan 37's, moved here by plan 39.1-43):
 * TrendLine's tick layout, value-label and reference-label placement and
 * `rateDomainTicks(domain, valueRangePx)` all read it. On CHART_H_COMPACT
 * (160px) it leaves an 80px value range — the flat hero trend PD-43-3 fixes.
 */
export function periodPlotModel(heightPx: number): PeriodPlotVerticalModel {
  const valueTopPx = PERIOD_CHART_MARGIN_PX + PERIOD_Y_AXIS_PADDING_TOP_PX;
  const valueBottomPx =
    heightPx - PERIOD_CHART_MARGIN_PX - PERIOD_X_AXIS_HEIGHT_PX - PERIOD_Y_AXIS_PADDING_BOTTOM_PX;
  return { valueTopPx, valueBottomPx, valueRangePx: valueBottomPx - valueTopPx };
}

/** The chart height (px) whose plot draws exactly `valueRangePx` (240px for the sketches' 160px). */
export function periodChartHeightForValueRange(valueRangePx: number): number {
  return valueRangePx + PERIOD_VALUE_RANGE_CHROME_PX;
}

/** The smallest vertical gap (px) two y-axis hairline ticks may sit apart before the step coarsens. */
export const MIN_RATE_TICK_GAP_PX = 14;

/** The candidate hairline steps, finest first — UI-SPEC §7.13's "every 10 pts" is the first. */
const RATE_TICK_STEPS = [10, 20, 25, 50] as const;

/**
 * UI-SPEC §7.13: a solid hairline every 10 rate points across a fitted
 * domain. When the plot's value range is too short for 10-point steps to sit
 * `MIN_RATE_TICK_GAP_PX` apart (a 0-100 domain on a compact plot), the step
 * coarsens rather than overprinting the tick labels.
 */
export function rateDomainTicks(domain: readonly [number, number], valueRangePx: number): number[] {
  const [lo, hi] = domain;
  const span = hi - lo;
  if (!(span > 0)) {
    return [lo];
  }
  const step =
    RATE_TICK_STEPS.find(
      (candidate) => (valueRangePx * candidate) / span >= MIN_RATE_TICK_GAP_PX,
    ) ?? span;
  // Never an off-step top tick: appending `hi` when the step does not divide
  // the span put it closer than the gap this function exists to keep (the
  // hero's "80" / "90" overprint in the design-audit captures).
  const ticks: number[] = [];
  for (let value = lo; value <= hi + 1e-9; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return ticks;
}

/**
 * OWNER DECISION 2026-09-25: the period dots are DIAMETERS 5 / 7 / 9 px, the
 * way sketch 001-C draws them (`width/height = size`) — the earlier reading
 * of UI-SPEC §7.13's "5 / 7 / 9px" as radii drew 10 / 14 / 18px dots.
 */
export const PERIOD_DOT_DIAMETER_SMALL = 5;
export const PERIOD_DOT_DIAMETER_MEDIUM = 7;
export const PERIOD_DOT_DIAMETER_LARGE = 9;

/** UI-SPEC §7.13's sample-size thresholds for the three dot steps: under 50, 50-149, 150+. */
export const PERIOD_DOT_MEDIUM_MIN_GAMES = 50;
export const PERIOD_DOT_LARGE_MIN_GAMES = 150;

/** A period's dot diameter (px) by its game count. */
export function periodDotDiameter(total: number): number {
  if (total >= PERIOD_DOT_LARGE_MIN_GAMES) return PERIOD_DOT_DIAMETER_LARGE;
  if (total >= PERIOD_DOT_MEDIUM_MIN_GAMES) return PERIOD_DOT_DIAMETER_MEDIUM;
  return PERIOD_DOT_DIAMETER_SMALL;
}

/**
 * Plan 39.1-41 (PD-41-2, sketch 003 `dotSize`): a SCOPED trend's dot
 * diameter (px) by the period's confidence tier — the shared
 * `confidenceTierFor` thresholds (3-7 / 8-19 / 20+ games), never a second
 * threshold table: high -> large, medium -> medium, low or below the floor ->
 * small. The Fighter hero keeps `periodDotDiameter` (games) above.
 */
export function periodDotDiameterForTier(total: number): number {
  const tier = confidenceTierFor(total);
  if (tier === 'high') return PERIOD_DOT_DIAMETER_LARGE;
  if (tier === 'medium') return PERIOD_DOT_DIAMETER_MEDIUM;
  return PERIOD_DOT_DIAMETER_SMALL;
}

/** The modelled line height (px) of an axis-size (12px) text label, used for every label box below. */
export const PERIOD_REFERENCE_LABEL_CLEARANCE_PX = 16;

/** How far (px) above its dot a period value label's baseline is drawn. */
export const PERIOD_VALUE_LABEL_OFFSET_PX = 12;

/** Plan 39.1-41: how far (px) BELOW its dot a below-placed value label's baseline is drawn (sketch 003 `.val.below`). */
export const PERIOD_VALUE_LABEL_BELOW_OFFSET_PX = 16;

/**
 * Plan 39.1-41 (sketch 003 `trend()`: `y < 14` / `y > h - 14` on its 160px
 * box): a dot within this SHARE of the value range of its top or bottom flips
 * its label inward — 14px of the sketch's 160px, scaled to the plot's own
 * value range so the rule reads the same on an 80px or a 160px plot.
 */
export const PERIOD_VALUE_LABEL_EDGE_FLIP_SHARE = 14 / 160;

export interface PeriodValueLabelPlacementInput {
  /** The dot's centre y and the value range's top / bottom (px, chart coordinates). */
  yPx: number;
  valueTopPx: number;
  valueBottomPx: number;
  isMin: boolean;
  isMax: boolean;
  isLast: boolean;
}

export interface PeriodValueLabelPlacement {
  below: boolean;
}

/**
 * Plan 39.1-41 (sketch 003 `trend()` / `.val`, sketch 001-C `trend()`: "end
 * labels flip left so nothing collides"): the min label sits BELOW its dot
 * unless it is also the max or the last period (sketch 001-C keeps a last
 * min above); a dot within `PERIOD_VALUE_LABEL_EDGE_FLIP_SHARE` of the value
 * range's top flips its label below, within that of the bottom above.
 * Labels stay centred on their dots (see the note in the body).
 */
export function periodValueLabelPlacement(
  input: PeriodValueLabelPlacementInput,
): PeriodValueLabelPlacement {
  const flipPx = PERIOD_VALUE_LABEL_EDGE_FLIP_SHARE * (input.valueBottomPx - input.valueTopPx);
  let below = input.isMin && !input.isMax && !input.isLast;
  if (input.yPx - input.valueTopPx < flipPx) below = true;
  if (input.valueBottomPx - input.yPx < flipPx) below = false;
  // Sketch 003's `.val.end` right-aligns labels in its last two CALENDAR
  // slots; on the app's categorical periods that flipped a label across the
  // recent band's edge, and the 16px x-axis padding already keeps a centred
  // last label inside the plot — so labels stay centred (fidelity loop).
  return { below };
}

/** Recharts' default `Label` offset (px) — the gap between the reference line and its label. */
export const REFERENCE_LABEL_OFFSET_PX = 5;

/**
 * The four placements tried for the all-time reference label, in order,
 * named as Recharts 3 names them for a zero-height (horizontal) reference
 * line — verified against the rendered DOM: `insideTopRight` draws the text
 * right-aligned with its top `REFERENCE_LABEL_OFFSET_PX` BELOW the line
 * (sketch 001-C's `.ref-label { transform: translateY(3px) }` — the default),
 * `insideBottomRight` right-aligned with its bottom that far ABOVE the line,
 * `insideTopLeft` left-aligned below the line and (plan 39.1-43)
 * `insideBottomLeft` left-aligned above it.
 */
export type ReferenceLabelPosition =
  'insideTopRight' | 'insideBottomRight' | 'insideTopLeft' | 'insideBottomLeft';

/**
 * Plan 39.1-43 (OOS-6): the placement result — a slot, or `'none'` when all
 * four are taken; the host then draws no direct label and the trend head's
 * reference legend item ("NN% all time") carries the rate.
 */
export type ReferenceLabelPlacement = ReferenceLabelPosition | 'none';

const REFERENCE_LABEL_POSITIONS: readonly ReferenceLabelPosition[] = [
  'insideTopRight',
  'insideBottomRight',
  'insideTopLeft',
  'insideBottomLeft',
];

/**
 * Plan 39.1-43 (OOS-6): sketch 001-C / 003 draw every period dot with a 2px
 * card-surface halo (`.pt { box-shadow: 0 0 0 2px var(--color-surface) }`);
 * the reference label must clear the dot's box expanded by it.
 */
export const REFERENCE_LABEL_DOT_HALO_PX = 2;

/** A DRAWN period dot (filled or hollow, labelled or not) in chart coordinates. */
export interface PeriodDotPx {
  xPx: number;
  yPx: number;
  /** The diameter the chart actually renders (games or tier sizing). */
  diameterPx: number;
  /** A hollow sub-floor dot — it blocks a slot exactly like a filled one. */
  subFloor?: boolean;
}

export interface LabelledPointPx {
  /** The dot's centre x (px, chart coordinates). */
  xPx: number;
  /** The dot's centre y (px, chart coordinates). */
  yPx: number;
  /** The value label's estimated width (px) — `estimateTickLabelWidthPx` of its text. */
  labelWidthPx: number;
  /** Plan 39.1-41: the label sits below its dot (default above). */
  below?: boolean;
}

export interface ReferenceLabelPlacementInput {
  /** The reference hairline's y (px, chart coordinates). */
  referenceYPx: number;
  /** The reference label's estimated width (px). */
  referenceLabelWidthPx: number;
  /** Every point that carries a direct value label. */
  labelledPoints: readonly LabelledPointPx[];
  /** Plan 39.1-43 (OOS-6): every DRAWN dot — the label never sits over one. */
  dots?: readonly PeriodDotPx[];
  /** The plot area's left and right edges (px) — the reference line's own extent. */
  plotLeftPx: number;
  plotRightPx: number;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function referenceLabelBox(
  position: ReferenceLabelPosition,
  input: ReferenceLabelPlacementInput,
): Box {
  const lineHeight = PERIOD_REFERENCE_LABEL_CLEARANCE_PX;
  const width = input.referenceLabelWidthPx;
  const below = {
    top: input.referenceYPx + REFERENCE_LABEL_OFFSET_PX,
    bottom: input.referenceYPx + REFERENCE_LABEL_OFFSET_PX + lineHeight,
  };
  const above = {
    top: input.referenceYPx - REFERENCE_LABEL_OFFSET_PX - lineHeight,
    bottom: input.referenceYPx - REFERENCE_LABEL_OFFSET_PX,
  };
  const right = {
    left: input.plotRightPx - REFERENCE_LABEL_OFFSET_PX - width,
    right: input.plotRightPx - REFERENCE_LABEL_OFFSET_PX,
  };
  const left = {
    left: input.plotLeftPx + REFERENCE_LABEL_OFFSET_PX,
    right: input.plotLeftPx + REFERENCE_LABEL_OFFSET_PX + width,
  };
  if (position === 'insideTopLeft') {
    return { ...left, ...below };
  }
  if (position === 'insideBottomLeft') {
    return { ...left, ...above };
  }
  return position === 'insideBottomRight' ? { ...right, ...above } : { ...right, ...below };
}

/**
 * A value label's box: centred on its dot (or right-aligned to it), its
 * baseline `PERIOD_VALUE_LABEL_OFFSET_PX` above the dot (or
 * `PERIOD_VALUE_LABEL_BELOW_OFFSET_PX` below it).
 */
function valueLabelBox(point: LabelledPointPx): Box {
  const lineHeight = PERIOD_REFERENCE_LABEL_CLEARANCE_PX;
  const baseline = point.below
    ? point.yPx + PERIOD_VALUE_LABEL_BELOW_OFFSET_PX
    : point.yPx - PERIOD_VALUE_LABEL_OFFSET_PX;
  return {
    left: point.xPx - point.labelWidthPx / 2,
    right: point.xPx + point.labelWidthPx / 2,
    top: baseline - lineHeight * 0.75,
    bottom: baseline + lineHeight * 0.25,
  };
}

/** A drawn dot's box: its centre ± (diameter / 2 + the 2px surface halo). */
function dotBox(dot: PeriodDotPx): Box {
  const half = dot.diameterPx / 2 + REFERENCE_LABEL_DOT_HALO_PX;
  return {
    left: dot.xPx - half,
    right: dot.xPx + half,
    top: dot.yPx - half,
    bottom: dot.yPx + half,
  };
}

/**
 * The reference-label collision rule (design-audit item 10; plan 39.1-43
 * OOS-6): the first of under-the-line right (the sketch), above-the-line
 * right, under-the-line left, then above-the-line left whose modelled box
 * meets no value label's box AND no drawn dot's box (filled or hollow, with
 * its 2px halo). When every slot is taken the result is `'none'`: the host
 * draws no direct label, and the trend head's reference legend item states
 * the same rate. The layout oracle's `reference-label-collision` and
 * `reference-label-dot-collision` checks verify the rendered result.
 */
export function placeReferenceLabel(input: ReferenceLabelPlacementInput): ReferenceLabelPlacement {
  const blockers = [...input.labelledPoints.map(valueLabelBox), ...(input.dots ?? []).map(dotBox)];
  for (const position of REFERENCE_LABEL_POSITIONS) {
    const box = referenceLabelBox(position, input);
    if (!blockers.some((blocker) => boxesIntersect(box, blocker))) {
      return position;
    }
  }
  return 'none';
}
