import {
  CHART_H_TIMELINE,
  CHART_H_TIMELINE_NARROW,
  CHART_NARROW_PLOT_PX,
  CHART_TOKENS,
} from './tokens';

/**
 * Plan 39.1-34: the career timeline's pure geometry and derived fills — no
 * React, no Recharts. Every number is sketch 002-C's `drawRating` (the
 * binding visual, UI-SPEC §12.1): `mT = 20`, `mL = 38`, `mR = compact ? 40 :
 * 60`, `stripH = 48`, `axisH = 26`, strip rows 15px at `y1 + 10` and
 * `y1 + 29`, row labels 8px left of the plot, cells inset 0.5px with a 1.5px
 * radius.
 */
export const CAREER_TIMELINE_MARGIN_TOP_PX = 20;
export const CAREER_TIMELINE_MARGIN_LEFT_PX = 38;
export const CAREER_TIMELINE_MARGIN_RIGHT_PX = 60;
export const CAREER_TIMELINE_MARGIN_RIGHT_NARROW_PX = 40;
/** The reserved band under the plot holding the two strips. */
export const CAREER_TIMELINE_STRIP_BAND_PX = 48;
/** The reserved band at the very bottom holding the time-axis labels. */
export const CAREER_TIMELINE_AXIS_BAND_PX = 26;
export const CAREER_TIMELINE_STRIP_ROW_HEIGHT_PX = 15;
/** The rate row's top, below the plot bottom. */
export const CAREER_TIMELINE_RATE_ROW_OFFSET_PX = 10;
/** The games row's top, below the plot bottom (4px under the rate row). */
export const CAREER_TIMELINE_GAMES_ROW_OFFSET_PX = 29;
/** Row labels ("rate" / "games") and y tick labels sit this far left of the plot, right-aligned. */
export const CAREER_TIMELINE_LABEL_GAP_PX = 8;
/** Each strip cell is drawn this far inside its period on both sides. */
export const CAREER_TIMELINE_CELL_INSET_PX = 0.5;
export const CAREER_TIMELINE_CELL_RADIUS_PX = 1.5;

/**
 * UI-SPEC §11/§12.1: the timeline is narrow when its plot — measured with
 * the wide right margin — is below `CHART_NARROW_PLOT_PX`. The plot width, not
 * the container width, is what the strips' cells are drawn across.
 */
export function careerTimelineIsNarrow(containerWidth: number): boolean {
  return (
    containerWidth - CAREER_TIMELINE_MARGIN_LEFT_PX - CAREER_TIMELINE_MARGIN_RIGHT_PX <
    CHART_NARROW_PLOT_PX
  );
}

export interface CareerTimelineGeometry {
  narrow: boolean;
  marginTop: number;
  marginLeft: number;
  marginRight: number;
  /** The plot's bottom edge, px from the SVG top (sketch `ph`). */
  plotBottom: number;
  stripBand: number;
  axisBand: number;
  /** The whole SVG height. */
  height: number;
}

/** The sketch's SVG height: `ph + stripH + axisH` (294 / 244 with strips, 246 / 196 without). */
export function careerTimelineSvgHeight(input: { narrow: boolean; strips: boolean }): number {
  return (
    (input.narrow ? CHART_H_TIMELINE_NARROW : CHART_H_TIMELINE) +
    (input.strips ? CAREER_TIMELINE_STRIP_BAND_PX : 0) +
    CAREER_TIMELINE_AXIS_BAND_PX
  );
}

export function careerTimelineGeometry(input: {
  narrow: boolean;
  strips: boolean;
}): CareerTimelineGeometry {
  const { narrow, strips } = input;
  return {
    narrow,
    marginTop: CAREER_TIMELINE_MARGIN_TOP_PX,
    marginLeft: CAREER_TIMELINE_MARGIN_LEFT_PX,
    marginRight: narrow ? CAREER_TIMELINE_MARGIN_RIGHT_NARROW_PX : CAREER_TIMELINE_MARGIN_RIGHT_PX,
    plotBottom: narrow ? CHART_H_TIMELINE_NARROW : CHART_H_TIMELINE,
    stripBand: strips ? CAREER_TIMELINE_STRIP_BAND_PX : 0,
    axisBand: CAREER_TIMELINE_AXIS_BAND_PX,
    height: careerTimelineSvgHeight({ narrow, strips }),
  };
}

/** Sketch 002's `--heat-pos-N` / `--heat-neg-N` mix shares, steps 1..4. */
const RATE_STEP_MIX_PERCENT = [22, 42, 66, 94] as const;
/** Sketch 002's `--seq-N` mix shares, steps 1..5. */
const GAMES_STEP_MIX_PERCENT = [14, 30, 50, 72, 95] as const;
/**
 * Sketch 002's `--heat-zero` is the muted surface (L 0.27). UI-SPEC §4.1
 * "soft fills are derived, never new tokens": 27% of `deemphasisStrong`
 * (L 0.45) into `surface` (L 0.205) lands on that lightness.
 */
const NEUTRAL_MIX_PERCENT = 27;

function mix(token: string, percent: number): string {
  return `color-mix(in oklab, ${token} ${percent}%, ${CHART_TOKENS.surface})`;
}

/**
 * UI-SPEC §12.1: the rate strip's diverging fill — `series1` above the
 * account's own baseline, `series2` below, a neutral grey midpoint (step 0),
 * four steps per arm. Derived `color-mix` values of the frozen token map; no
 * new CSS token, no hex literal.
 */
export function careerStripFill(step: number): string {
  if (step === 0) return mix(CHART_TOKENS.deemphasisStrong, NEUTRAL_MIX_PERCENT);
  const magnitude = Math.min(RATE_STEP_MIX_PERCENT.length, Math.abs(step));
  return mix(
    step > 0 ? CHART_TOKENS.series1 : CHART_TOKENS.series2,
    RATE_STEP_MIX_PERCENT[magnitude - 1]!,
  );
}

/** UI-SPEC §12.1: the games strip's 5-step sequential blue. */
export function careerGamesFill(step: number): string {
  const clamped = Math.min(GAMES_STEP_MIX_PERCENT.length, Math.max(1, step));
  return mix(CHART_TOKENS.series1, GAMES_STEP_MIX_PERCENT[clamped - 1]!);
}

/** UI-SPEC §12.1: gridlines every 100 rating points ... */
const Y_STEP_DEFAULT = 100;
/** ... or every 200 when the fitted span exceeds 600 points, or on a narrow plot. */
const Y_STEP_WIDE_SPAN = 200;
const Y_WIDE_SPAN_THRESHOLD = 600;

export interface CareerTimelineYDomain {
  lo: number;
  hi: number;
  step: number;
  /** Hairline / label positions, `lo` to `hi` by `step` (sketch 002-C's `for (v = lo; v <= hi; v += step)`). */
  ticks: number[];
}

/**
 * UI-SPEC §12.1 / sketch 002-C: the y-domain fitted to the data plus its RD
 * band, rounded out to whole hundreds — never the old fixed 1,400-2,100 grid.
 */
export function careerTimelineYDomain(
  points: ReadonlyArray<{ rating: number; rd: number }>,
  options: { narrow: boolean },
): CareerTimelineYDomain {
  const lo =
    Math.floor(Math.min(...points.map((p) => p.rating - p.rd)) / Y_STEP_DEFAULT) * Y_STEP_DEFAULT;
  const rawHi =
    Math.ceil(Math.max(...points.map((p) => p.rating + p.rd)) / Y_STEP_DEFAULT) * Y_STEP_DEFAULT;
  const hi = rawHi > lo ? rawHi : lo + Y_STEP_DEFAULT;
  const step =
    hi - lo > Y_WIDE_SPAN_THRESHOLD || options.narrow ? Y_STEP_WIDE_SPAN : Y_STEP_DEFAULT;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  return { lo, hi, step, ticks };
}
