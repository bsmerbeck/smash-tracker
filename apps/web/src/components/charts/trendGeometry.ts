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

/** The modelled line height (px) of an axis-size (12px) text label, used for every label box below. */
export const PERIOD_REFERENCE_LABEL_CLEARANCE_PX = 16;

/** How far (px) above its dot a period value label's baseline is drawn. */
export const PERIOD_VALUE_LABEL_OFFSET_PX = 12;

/** Recharts' default `Label` offset (px) — the gap between the reference line and its label. */
export const REFERENCE_LABEL_OFFSET_PX = 5;

/**
 * The three placements tried for the all-time reference label, in order,
 * named as Recharts 3 names them for a zero-height (horizontal) reference
 * line — verified against the rendered DOM: `insideTopRight` draws the text
 * right-aligned with its top `REFERENCE_LABEL_OFFSET_PX` BELOW the line
 * (sketch 001-C's `.ref-label { transform: translateY(3px) }` — the default),
 * `insideBottomRight` right-aligned with its bottom that far ABOVE the line,
 * `insideTopLeft` left-aligned below the line.
 */
export type ReferenceLabelPosition = 'insideTopRight' | 'insideBottomRight' | 'insideTopLeft';

const REFERENCE_LABEL_POSITIONS: readonly ReferenceLabelPosition[] = [
  'insideTopRight',
  'insideBottomRight',
  'insideTopLeft',
];

export interface LabelledPointPx {
  /** The dot's centre x (px, chart coordinates). */
  xPx: number;
  /** The dot's centre y (px, chart coordinates). */
  yPx: number;
  /** The value label's estimated width (px) — `estimateTickLabelWidthPx` of its text. */
  labelWidthPx: number;
}

export interface ReferenceLabelPlacementInput {
  /** The reference hairline's y (px, chart coordinates). */
  referenceYPx: number;
  /** The reference label's estimated width (px). */
  referenceLabelWidthPx: number;
  /** Every point that carries a direct value label. */
  labelledPoints: readonly LabelledPointPx[];
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
  if (position === 'insideTopLeft') {
    return {
      left: input.plotLeftPx + REFERENCE_LABEL_OFFSET_PX,
      right: input.plotLeftPx + REFERENCE_LABEL_OFFSET_PX + width,
      ...below,
    };
  }
  return position === 'insideBottomRight' ? { ...right, ...above } : { ...right, ...below };
}

/** A value label's box: centred on its dot, baseline `PERIOD_VALUE_LABEL_OFFSET_PX` above it. */
function valueLabelBox(point: LabelledPointPx): Box {
  const lineHeight = PERIOD_REFERENCE_LABEL_CLEARANCE_PX;
  const baseline = point.yPx - PERIOD_VALUE_LABEL_OFFSET_PX;
  return {
    left: point.xPx - point.labelWidthPx / 2,
    right: point.xPx + point.labelWidthPx / 2,
    top: baseline - lineHeight * 0.75,
    bottom: baseline + lineHeight * 0.25,
  };
}

/**
 * The reference-label collision rule (design-audit item 10): the first of
 * under-the-line right (the sketch), above-the-line right, then
 * under-the-line left whose modelled box meets no value label's box. When
 * every slot is taken the last candidate is returned — the layout oracle's
 * `reference-label-collision` check reports that case in a real browser.
 */
export function placeReferenceLabel(input: ReferenceLabelPlacementInput): ReferenceLabelPosition {
  const valueBoxes = input.labelledPoints.map(valueLabelBox);
  for (const position of REFERENCE_LABEL_POSITIONS) {
    const box = referenceLabelBox(position, input);
    if (!valueBoxes.some((valueBox) => boxesIntersect(box, valueBox))) {
      return position;
    }
  }
  return REFERENCE_LABEL_POSITIONS[REFERENCE_LABEL_POSITIONS.length - 1]!;
}
