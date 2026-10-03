import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  DefaultZIndexes,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  ZIndexLayer,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from 'recharts';
import { XAxis, YAxis, type MouseHandlerDataParam } from 'recharts';
import type { PeriodPoint, ValueSeriesGrain, ValueSeriesPoint } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES, PERIOD_TREND_MIN_PERIODS } from '@smash-tracker/shared';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  CHART_AXIS_FONT_SIZE,
  CHART_BODY_HEIGHT_PX,
  CHART_H_COMPACT,
  CHART_DOT_RADIUS,
  CHART_LINE_WIDTH,
  CHART_TOKENS,
} from './tokens';
import { ChartTooltip } from './ChartTooltip';
import { selectEventLabelKeys } from './eventTicks';
import {
  estimateTickLabelWidthPx,
  formatPeriodRowLabel,
  selectEventAnchorTickLayout,
  selectPeriodTickLayout,
  type PeriodTickLayout,
} from './periodTicks';
import {
  PERIOD_CHART_MARGIN_PX,
  PERIOD_DOT_DIAMETER_LARGE,
  PERIOD_DOT_DIAMETER_MEDIUM,
  PERIOD_DOT_DIAMETER_SMALL,
  PERIOD_VALUE_LABEL_BELOW_OFFSET_PX,
  PERIOD_VALUE_LABEL_OFFSET_PX,
  PERIOD_AXIS_FONT_SIZE_PX,
  PERIOD_Y_AXIS_PADDING_BOTTOM_PX,
  PERIOD_Y_AXIS_PADDING_TOP_PX,
  PERIOD_Y_GUTTER_PX,
  PERIOD_Y_TICK_GAP_PX,
  fitRateDomain,
  periodChartHeightForValueRange,
  periodDotDiameter,
  periodDotDiameterForTier,
  periodPlotModel,
  periodRateTicks,
  periodValueLabelPlacement,
  placeReferenceLabel,
  rateDomainTicks,
  type PeriodValueLabelPlacement,
  type ReferenceLabelPlacement,
} from './trendGeometry';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { CAREER_TIMELINE_READOUT_MAX_WIDTH_PX, clampReadoutLeft } from './careerTimelineLayout';
import { TIME_AXIS_LABEL_OFFSET_PX, selectTimeAxisTicks } from './timeAxisTicks';
import {
  VALUE_DIAMOND_DIAGONAL_PX,
  VALUE_DIAMOND_STROKE_PX,
  VALUE_DOT_DIAMETER_PX,
  VALUE_DOT_RING_PX,
  VALUE_MARGIN_RIGHT_PX,
  VALUE_MARGIN_TOP_PX,
  VALUE_X_AXIS_BAND_PX,
  VALUE_MARGIN_BOTTOM_PX,
  buildValueYAxis,
  nearestPointIndex,
  valueMarkKind,
  type ReferencePlacement,
  type ValueYAxis,
} from './valueTrendGeometry';

/**
 * Deliberately NOT named `TrendPoint`: `MatchupChart.tsx` already declares a
 * module-local `type TrendPoint = RollingWinRatePoint | RunningWinRatePoint`
 * (the return type of `buildTrendSeries`), and this kit type must not shadow
 * or force a rename of that existing union.
 */
export interface TrendChartPointContext {
  matchId: string;
  opponentTag: string;
  stageName: string;
  eventName: string | null;
  dateMs: number;
  win: boolean;
  gameNumber: number | null;
}

export interface TrendChartPoint {
  index: number;
  winRate: number;
  context: TrendChartPointContext;
}

/**
 * OPP-03/D-11: the event-anchored mode's point shape — one point per event
 * anchor (`packages/shared/src/evidence/eventSeries.ts`'s `EventAnchor`),
 * never a game index and never a rolling-N window. `eventKey` is the
 * anchor's own content-derived key (never an array index) and is what the
 * categorical x-axis below is keyed on. `wins`/`losses` are this ANCHOR's
 * own record — rendered as an always-visible on-chart label (D-11/ADV-02
 * spirit: the record is content, not a hover affordance) — deliberately
 * distinct from `cumulativeWinRate`, which is the y-value the line plots.
 * The context carries the who/where fields scoped to the EVENT rather than
 * to one match: a single event can span several stages, so there is no
 * single `stageName` here — `eventLabel` replaces it.
 */
export interface TrendEventPointContext {
  opponentTag: string;
  eventLabel: string;
  dateMs: number;
}

export interface TrendEventPoint {
  eventKey: string;
  cumulativeWinRate: number;
  wins: number;
  losses: number;
  context: TrendEventPointContext;
}

/**
 * VIZ-01 (UI-SPEC §7.13): the three dot-size steps by sample size, as SVG
 * RADII — radius = diameter / 2; sketch 001-C draws 5 / 7 / 9px dots (owner
 * decision 2026-09-25, `trendGeometry.ts` owns the diameters). The exported
 * names are kept so existing callers compile.
 */
export const PERIOD_DOT_RADIUS_SMALL = PERIOD_DOT_DIAMETER_SMALL / 2;
export const PERIOD_DOT_RADIUS_MEDIUM = PERIOD_DOT_DIAMETER_MEDIUM / 2;
export const PERIOD_DOT_RADIUS_LARGE = PERIOD_DOT_DIAMETER_LARGE / 2;

/** UI-SPEC §7.13's table-twin column headers — fully composed by the host (Track B rule B1). */
export interface TrendLinePeriodTableHeaders {
  period: string;
  record: string;
  rate: string;
  sample: string;
}

/**
 * Plan 39.1-43 (PD-43-1, UI-SPEC §7.13 "fewer than 8 periods at the floor"):
 * the locked state's counts, computed by the kit — never by the host.
 * `have` = the periods with at least `ABSTENTION_FLOOR_GAMES` (3) games;
 * `need` = `PERIOD_TREND_MIN_PERIODS` (8) − have.
 */
export interface PeriodTrendLockCounts {
  need: number;
  have: number;
}

/**
 * Plan 39.1-43 (sketch 001-C `trendSection` / sketch 003 `trendLegend`): the
 * head's swatch legend texts. `dot` always shows on a drawn trend; `hollow`
 * only when a drawn period is sub-floor; `reference` only with a
 * `referenceRate`; `band` only when the recent band is drawn.
 */
export interface TrendLinePeriodLegend {
  dot: string;
  hollow: string;
  reference?: string;
  band?: string;
}

/** Every string this mode needs, fully composed by the host — the chart never localises (UI-SPEC §9.2 rule 6). */
export interface TrendLinePeriodLabels {
  /** UI-SPEC §7.13 locked state, e.g. "7 more quarters with 3+ games unlock this chart." — a formatter of the kit's counts. */
  lockedSentence: (counts: PeriodTrendLockCounts) => string;
  /** The locked meter's count label (also its accessible name), e.g. "1 of 8". */
  lockedCountLabel: (counts: PeriodTrendLockCounts) => string;
  /** Plan 39.1-43: the head's overline, e.g. "Win rate by quarter"; omitted renders no head. */
  title?: string;
  /** Plan 39.1-43: the head's swatch legend (rendered only with `title`). */
  legend?: TrendLinePeriodLegend;
  /** The table twin's disclosure toggle text, e.g. "View as table". */
  tableToggle: string;
  tableHeaders: TrendLinePeriodTableHeaders;
  /** The reference hairline's direct label (e.g. "75% all time") — rendered only when `referenceRate` is also supplied. */
  referenceLabel?: string;
}

export interface TrendLinePeriodProps extends TrendLineSharedProps {
  mode: 'period';
  /** `buildPeriodSeries`'s output points — this member never bins, buckets or re-windows them (VIZ-01). */
  points: PeriodPoint[];
  onSelectPoint?: (point: PeriodPoint) => void;
  /** The baseline rate (0-100) for the reference hairline; omitted renders no reference line. */
  referenceRate?: number;
  /** The recent window's start (ms) for the emphasis band; omitted renders no band. */
  emphasisStartMs?: number;
  /**
   * Plan 39.1-41 (PD-41-2): how a period dot is sized — `'games'` (default,
   * the Fighter hero: plan 37's 50 / 150-game steps) or `'tier'` (scoped
   * trends, sketch 003 `dotSize`: the confidence tier of the period's games).
   */
  dotSizing?: PeriodDotSizing;
  /**
   * Plan 39.1-43 (PD-43-3, sketch 001-C / 003 `trend()`): the span (px)
   * between the fitted domain's lowest and highest hairlines. When set the
   * chart's height is `periodChartHeightForValueRange(valueRangePx)` (the
   * value-label paddings and the axis band outside it) and `height` is
   * ignored; omitted, the chart keeps `height` exactly as before.
   */
  valueRangePx?: number;
  labels: TrendLinePeriodLabels;
}

/** Plan 39.1-41: the period dot-size rule — see `TrendLinePeriodProps.dotSizing`. */
export type PeriodDotSizing = 'games' | 'tier';

interface TrendLineSharedProps {
  /** D-04: explicit numeric size for tests; omitted at runtime for the responsive wrapper. */
  width?: number;
  height?: number;
  /** Tooltip content node, passed through to Recharts' `Tooltip`. Defaults to
   * the kit's shared `ChartTooltip` so every consumer gets the who/where/
   * when/score content without opting in (D-06). */
  tooltip?: ReactElement;
}

export interface TrendLineIndexProps extends TrendLineSharedProps {
  /** Defaults to the index mode — every Phase 37 call site omits this prop and stays byte-unchanged. */
  mode?: 'index';
  points: TrendChartPoint[];
  onSelectPoint?: (point: TrendChartPoint) => void;
}

export interface TrendLineEventProps extends TrendLineSharedProps {
  mode: 'event';
  points: TrendEventPoint[];
  onSelectPoint?: (point: TrendEventPoint) => void;
}

/**
 * Plan 41-02 (A1 / DD-41-01): the value mode's readout — pre-resolved by the host, the kit never
 * localises. `valueKey: 'value'` is the discriminant `ChartTooltip` routes on, BEFORE its numeric
 * fall-through (a value point has no `winRate`). The value leads `title`; `lines` follow.
 */
export interface TrendValueReadout {
  valueKey: 'value';
  title: string;
  lines: string[];
}

/**
 * One value-mode point: the shared `buildValueSeries` point (identity by `memberIndexes`, never by its
 * time window — CR-02) plus its host-built readout. The chart never bins, rounds or re-windows it.
 */
export interface TrendValuePoint extends ValueSeriesPoint {
  context: TrendValueReadout;
}

/** DD-41-13: a reference value (an Elite threshold) and how the host placed it relative to the readings. */
export interface TrendValueReference {
  value: number;
  /** The direct label drawn under a `'line'` placement. */
  label: string;
  placement: ReferencePlacement;
}

/**
 * Host-controlled cursor (RESEARCH correction 1): the crosshair is state the HOST owns, so a
 * multiples grid draws it at one `xMs` in every panel even when the panels' x sets differ. The
 * panel converts the pointer's x into the nearest of ITS OWN points' `xMs` and reports it.
 */
export interface TrendValueCursor {
  xMs: number | null;
  onChange: (xMs: number | null) => void;
}

/** The locked state's counts and sentence — pre-composed by the host ("{{have}} of {{need}} readings"). */
export interface TrendValueLocked {
  have: number;
  need: number;
  sentence: string;
  meterLabel: string;
}

/** Every string value mode draws — fully composed by the host. */
export interface TrendValueLabels {
  /** The head's overline naming the grain; a function receives the grain actually drawn (a narrow plot re-grains). Omitted renders no head. */
  overline?: string | ((grain: ValueSeriesGrain) => string);
  /** The plot's accessible name (`analytics.valueTrend.aria_*`). */
  aria: string;
  /** The head's swatch legend (rendered only with an overline). */
  legend?: { series: string; calibration?: string; reference?: string };
  /** The table twin's disclosure text; omitted (a multiples panel — its grid owns the one twin) renders none. */
  tableToggle?: string;
  tableHeaders?: { date: string; value: string; readings: string };
}

export interface TrendLineValueProps extends TrendLineSharedProps {
  mode: 'value';
  /** `buildValueSeries` output, oldest first (≤ 60). This member never bins. */
  points: TrendValuePoint[];
  /** The grain `points` were built at — named in the head overline. */
  grain: ValueSeriesGrain;
  /** Below `CHART_NARROW_PLOT_PX` of measured plot width these render instead (re-grain, never squeeze). */
  narrowPoints?: TrendValuePoint[];
  narrowGrain?: ValueSeriesGrain;
  /** A shared x domain (multiples); defaults to the points' own span. */
  xDomain?: [number, number];
  /** Host-formatted compact tick strings (`9.5M`, `1088万`); the y gutter is measured from them (DD-41-14). */
  formatTick: (n: number) => string;
  /** Host-formatted full-precision value (direct labels, table twin). */
  formatValueFull: (n: number) => string;
  reference?: TrendValueReference;
  directLabels?: 'last' | 'last-peak-low';
  locked?: TrendValueLocked;
  cursor?: TrendValueCursor;
  /** Draw the x tick band (default true). A multiples grid draws it on its last panel only. */
  drawXAxis?: boolean;
  /** `'thin'` = the 1.5px stroke (compact plots, multiples panels). */
  lineWidth?: 'default' | 'thin';
  /** A minimum y gutter (px), so stacked panels start their plots at one x. */
  gutterPx?: number;
  onSelectPoint?: (point: TrendValuePoint) => void;
  labels: TrendValueLabels;
}

/**
 * A discriminated union on `mode`, not two overloaded call signatures: every
 * existing consumer omits `mode` entirely, which selects `TrendLineIndexProps`
 * (`mode` optional there, required as the literal `'event'` on the other
 * member) with no change to its own type-checking.
 */
export type TrendLineProps =
  TrendLineIndexProps | TrendLineEventProps | TrendLinePeriodProps | TrendLineValueProps;

/** Used only to derive a legible tick count when no explicit width is given (the runtime responsive wrapper) — the wrapper itself still governs the actual rendered pixel width; this is purely a density fallback. */
const EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH = 800;

/** Vertical offset (px) of the always-visible per-anchor W-L label above its dot. */
const EVENT_POINT_LABEL_OFFSET_PX = 12;
/** Horizontal inset (px) of a W-L label from its dot, clear of the step riser. */
const EVENT_POINT_LABEL_INSET_PX = 4;

/**
 * Plan 39.1-37 (design-fidelity loop): a card-coloured halo painted under
 * every direct value label, so a line that crosses it (the event mode's step
 * risers, a period segment) never overprints the text.
 */
const VALUE_LABEL_HALO = {
  stroke: CHART_TOKENS.surface,
  strokeWidth: 3,
  strokeLinejoin: 'round',
  paintOrder: 'stroke',
} as const;

/**
 * The trend-with-context vocabulary member (D-05): a single-series line over
 * a win-rate domain (fixed 0-100 in the index mode; fitted to the data in the
 * event and period modes — plan 39.1-37, UI-SPEC §7.13). D-04: accepts an explicit numeric
 * `width`/`height` — when `width` is a number the chart renders directly at
 * that size (what every test uses, since jsdom's no-op ResizeObserver stub
 * plus a zero-size bounding rect make a `ResponsiveContainer` render measure
 * 0x0); when `width` is undefined the chart is wrapped in a
 * `ResponsiveContainer` (the runtime page render).
 *
 * `mode` (C2-H-02/D-11) selects between two point shapes and two axis/curve
 * treatments, sharing every other concern (frame, tooltip, click-to-index):
 * - `'index'` (default, unchanged from Phase 37): a numeric game-index x-axis
 *   with linear interpolation.
 * - `'event'`: a CATEGORICAL x-axis keyed on the engine-built anchor key
 *   (never an array index), a stepped (`stepAfter`) line, and an
 *   per-point W-L label on at most `MAX_EVENT_POINT_LABELS` anchors (plan
 *   39.1-37); each tick reads as the anchor's human label, never its key
 *   (`selectEventAnchorTickLayout`). Tick DENSITY is decided by this
 *   component from the pure `eventTicks.ts` helper and handed to the axis as
 *   an explicit `ticks` array — never delegated to Recharts'
 *   `preserveStart`/`preserveStartEnd` interval modes. Those modes decide
 *   what to drop by MEASURING rendered text
 *   (`lib/cartesian/getTicks.js:154,157`'s `getStringSize`, which measures
 *   through `getBoundingClientRect` in `lib/util/DOMUtils.js`); jsdom returns
 *   all-zero rects, so every tick measures zero width, nothing ever
 *   overlaps, and that thinning never fires under test. An explicit `ticks`
 *   array plus a directly-tested pure helper makes the density property
 *   observable with no DOM at all (see `eventTicks.test.ts`) and equal to
 *   what the component actually renders (see this file's event-mode test
 *   cases), rather than depending on jsdom's text measurement.
 */
export function TrendLine(props: TrendLineProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const { width, height = CHART_BODY_HEIGHT_PX, tooltip = <ChartTooltip /> } = props;
  // Plan 39.1-37: the event mode's tick and label density come from the
  // RENDERED width (the responsive wrapper's onResize), not a fixed 800px
  // guess — above every early return (Rules of Hooks).
  const [eventMeasuredWidth, setEventMeasuredWidth] = useState(
    EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH,
  );

  /**
   * The click surface is bound on the `LineChart` container, not on `Line` or
   * a `dot` (R1-MEDIUM-8): recharts 3.10.1's `MouseHandlerDataParam` (the
   * container-level `onClick` argument) carries no `activePayload` field —
   * that recharts-2-era field does not exist on this version's type, verified
   * against the installed package's `types/synchronisation/types.d.ts`. The
   * numeric `activeTooltipIndex` it DOES carry is a 1:1 index into whichever
   * `data` array this chart was given — exactly `props.points` regardless of
   * mode — so reading `props.points[activeTooltipIndex]` recovers the
   * clicked point without needing an `activePayload` field at all. See the
   * plan 37-01 SUMMARY for the full observed-shape record.
   */
  const handleClick = useCallback(
    (state: MouseHandlerDataParam) => {
      if (!props.onSelectPoint) return;
      const rawIndex = state.activeTooltipIndex;
      const index = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
      if (!Number.isInteger(index)) return;
      if (props.mode === 'event') {
        const point = props.points[index];
        if (point) {
          props.onSelectPoint(point);
        }
      } else if (props.mode === 'period') {
        const point = props.points[index];
        if (point) {
          props.onSelectPoint(point);
        }
      } else if (props.mode === 'value') {
        // Unreached at runtime (value mode owns its pointer layer and returns below), but the
        // explicit arm keeps the index `else` narrowed to its own point type.
        const point = props.points[index];
        if (point) {
          props.onSelectPoint(point);
        }
      } else {
        const point = props.points[index];
        if (point) {
          props.onSelectPoint(point);
        }
      }
    },
    [props],
  );

  /**
   * Period mode's locked state (UI-SPEC §7.13) fires below
   * `PERIOD_TREND_MIN_PERIODS` PERIODS, including zero — unlike the other
   * two modes' `points.length === 0` early `return null` below, which never
   * applies to period mode. `renderPeriodTrend` owns period mode's entire
   * render tree; the other two modes' code below is untouched.
   */
  if (props.mode === 'period') {
    // Plan 39.1-43 (PD-43-3): a value range sizes the chart; otherwise
    // `height` is kept exactly (hub / stage-detail / default-height callers).
    const periodHeight =
      props.valueRangePx !== undefined
        ? periodChartHeightForValueRange(props.valueRangePx)
        : height;
    return (
      <PeriodTrendChart props={props} width={width} height={periodHeight} onClick={handleClick} />
    );
  }

  if (props.mode === 'value') {
    return <ValueTrendChart props={props} width={width} height={height} />;
  }

  if (props.points.length === 0) {
    return null;
  }

  let chart: ReactElement;

  if (props.mode === 'event') {
    const eventPoints = props.points;
    const anchorKeys = eventPoints.map((point) => point.eventKey);
    const containerWidth = typeof width === 'number' ? width : eventMeasuredWidth;
    const model = periodPlotGeometry(containerWidth, height);
    // Plan 39.1-37 (VIZ-03, design-audit item 5): the axis names each anchor
    // by its human label (a date for a session, the truncated name for a
    // tournament) — never its engine key — laid out from the plotted width.
    const tickLayout = selectEventAnchorTickLayout(
      eventPoints.map((point) => ({
        eventKey: point.eventKey,
        eventLabel: point.context.eventLabel,
        dateMs: point.context.dateMs,
      })),
      { plotWidthPx: model.plotWidthPx, locale: i18n.language },
    );
    // UI-SPEC §7.13's fitted domain (no fixed 0-100) over the cumulative rates.
    const domain = fitRateDomain(eventPoints.map((point) => point.cumulativeWinRate));
    const yTicks = rateDomainTicks(domain, model.valueRangePx);
    // At most MAX_EVENT_POINT_LABELS anchors carry their W-L label; every
    // anchor's record stays in its tooltip.
    // Plan 39.1-39: width-aware — a binned trend's labels ("293–214") are
    // wider than the fixed spacing assumes, so each label's estimated width
    // (plus its inset off the dot) keeps them from overprinting.
    const pointByKey = new Map(eventPoints.map((point) => [point.eventKey, point]));
    const labelledKeys = new Set(
      selectEventLabelKeys(anchorKeys, model.plotWidthPx, (key) => {
        const point = pointByKey.get(key);
        return point
          ? estimateTickLabelWidthPx(
              t('opponents.hub.trend.pointLabel', { wins: point.wins, losses: point.losses }),
            ) + EVENT_POINT_LABEL_INSET_PX
          : 0;
      }),
    );

    chart = (
      <LineChart
        {...(typeof width === 'number' ? { width, height } : {})}
        data={eventPoints}
        margin={PERIOD_CHART_MARGIN}
        onClick={handleClick}
        accessibilityLayer
      >
        <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="eventKey"
          type="category"
          domain={anchorKeys}
          ticks={tickLayout.map((tick) => tick.key)}
          interval={0}
          padding={{ left: PERIOD_X_AXIS_PADDING_PX, right: PERIOD_X_AXIS_PADDING_PX }}
          tick={periodTickRenderer(tickLayout)}
        />
        {/* No allowDataOverflow here: the domain is fitted over every
            plotted value, so Recharts has nothing to re-extend it for — and
            allowDataOverflow's clip would cut a 0% / 100% dot in half. */}
        <YAxis
          domain={domain}
          ticks={yTicks}
          interval={0}
          width={PERIOD_Y_AXIS_WIDTH_PX}
          padding={{ top: PERIOD_Y_AXIS_PADDING_TOP_PX, bottom: PERIOD_Y_AXIS_PADDING_BOTTOM_PX }}
          tick={{ fill: CHART_TOKENS.axisText, fontSize: CHART_AXIS_FONT_SIZE }}
        />
        {tooltip && <Tooltip content={tooltip} cursor={{ stroke: CHART_TOKENS.border }} />}
        <Line
          type="stepAfter"
          dataKey="cumulativeWinRate"
          stroke={CHART_TOKENS.series1}
          strokeWidth={CHART_LINE_WIDTH}
          dot={{
            r: CHART_DOT_RADIUS,
            fill: CHART_TOKENS.series1,
            stroke: CHART_TOKENS.surface,
            strokeWidth: 2,
          }}
          isAnimationActive={false}
          label={(labelProps: unknown) => {
            const { x, y, index } = labelProps as { x?: number; y?: number; index?: number };
            if (typeof x !== 'number' || typeof y !== 'number' || typeof index !== 'number') {
              return <g />;
            }
            const point = eventPoints[index];
            if (!point || !labelledKeys.has(point.eventKey)) {
              return <g />;
            }
            // The stepAfter riser runs vertically THROUGH the dot's x, so a
            // centred label is cut by it: each label starts just right of its
            // dot (above the level it steps to), the last ends just left of
            // its dot so it stays inside the plot.
            const isLast = index === eventPoints.length - 1;
            return (
              <text
                x={isLast ? x - EVENT_POINT_LABEL_INSET_PX : x + EVENT_POINT_LABEL_INSET_PX}
                y={y - EVENT_POINT_LABEL_OFFSET_PX}
                textAnchor={isLast ? 'end' : 'start'}
                fill={CHART_TOKENS.axisText}
                fontSize={CHART_AXIS_FONT_SIZE}
                {...VALUE_LABEL_HALO}
                data-slot="trend-event-value-label"
              >
                {t('opponents.hub.trend.pointLabel', { wins: point.wins, losses: point.losses })}
              </text>
            );
          }}
        />
      </LineChart>
    );
  } else {
    const indexPoints = props.points;
    chart = (
      <LineChart
        {...(typeof width === 'number' ? { width, height } : {})}
        data={indexPoints}
        onClick={handleClick}
        accessibilityLayer
      >
        <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="index"
          tick={{ fill: CHART_TOKENS.axisText, fontSize: CHART_AXIS_FONT_SIZE }}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: CHART_TOKENS.axisText, fontSize: CHART_AXIS_FONT_SIZE }}
        />
        {tooltip && <Tooltip content={tooltip} cursor={{ stroke: CHART_TOKENS.border }} />}
        <Line
          type="linear"
          dataKey="winRate"
          stroke={CHART_TOKENS.series1}
          strokeWidth={CHART_LINE_WIDTH}
          dot={{
            r: CHART_DOT_RADIUS,
            fill: CHART_TOKENS.series1,
            stroke: CHART_TOKENS.surface,
            strokeWidth: 2,
          }}
          isAnimationActive={false}
        />
      </LineChart>
    );
  }

  if (typeof width === 'number') {
    return chart;
  }

  return (
    <ResponsiveContainer
      width="100%"
      height={height}
      onResize={props.mode === 'event' ? (w) => setEventMeasuredWidth(w) : undefined}
    >
      {chart}
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Period mode (VIZ-01, VIZ-03, UI-SPEC §7.13) — a third member of the mode
// union, added exactly the way the 'event' mode was added: a new interface,
// a new union member, a new arm. The chart CONSUMES `PeriodPoint[]` from the
// shared engine's grain ladder and bins nothing itself — no date-bucketing
// helper (a week/month/quarter/year key function, a session/set splitter)
// exists anywhere below; that logic lives exclusively in
// `packages/shared/src/insight/periodSeries.ts`.
// ---------------------------------------------------------------------------

function periodDotRadius(total: number, dotSizing: PeriodDotSizing): number {
  return (dotSizing === 'tier' ? periodDotDiameterForTier(total) : periodDotDiameter(total)) / 2;
}

/**
 * UI-SPEC §7.13: 2px at `CHART_H_DEFAULT`, 1.5px at `CHART_H_COMPACT` —
 * and (plan 39.1-43) 1.5px on a hero value-range plot, the sketches' own
 * stroke on their 160px trend box (`o.sized ? 1.5`).
 */
function periodLineStrokeWidth(height: number, valueRangePx: number | undefined): number {
  return valueRangePx !== undefined || height <= CHART_H_COMPACT ? 1.5 : CHART_LINE_WIDTH;
}

/**
 * UI-SPEC §7.13/§11: direct value labels on the last, maximum and minimum
 * JOINED (3+ game) points only — sketch 001-C's `okPts` rule: a sub-floor
 * point is never labelled, and a series with no joined point carries no
 * label at all. Ties broken by keeping the FIRST (earlier) occurrence — only
 * updating on a STRICT `>`/`<` means a later point tying the current
 * max/min never displaces it.
 */
interface PeriodLabelRoles {
  last: number;
  max: number;
  min: number;
}

function findPeriodLabelRoles(points: PeriodPoint[]): PeriodLabelRoles | null {
  const joined = points.flatMap((point, i) => (point.subFloor ? [] : [i]));
  if (joined.length === 0) {
    return null;
  }
  const last = joined[joined.length - 1]!;
  let max = joined[0]!;
  let min = joined[0]!;
  for (const i of joined) {
    if (points[i]!.rate > points[max]!.rate) max = i;
    if (points[i]!.rate < points[min]!.rate) min = i;
  }
  return { last, max, min };
}

function findPeriodLabeledIndices(points: PeriodPoint[]): Set<number> {
  const roles = findPeriodLabelRoles(points);
  return roles ? new Set([roles.last, roles.max, roles.min]) : new Set();
}

/**
 * UI-SPEC §7.13 / sketch 001-C: the domain is fitted to the JOINED periods
 * and the all-time reference rate — never to a sub-floor period (owner
 * decision 2026-09-25: an off-domain sub-floor dot is pinned to the edge
 * instead).
 */
function computePeriodYDomain(points: PeriodPoint[], referenceRate?: number): [number, number] {
  const fitted = points.filter((point) => !point.subFloor).map((point) => point.rate * 100);
  if (referenceRate !== undefined) {
    fitted.push(referenceRate);
  }
  return fitRateDomain(fitted);
}

/** Owner decision 2026-09-25: which edge (if any) an off-domain sub-floor dot is pinned to. */
type PinnedEdge = 'top' | 'bottom';

function pinnedEdgeFor(point: PeriodPoint, [lo, hi]: [number, number]): PinnedEdge | undefined {
  if (!point.subFloor) return undefined;
  const ratePercent = point.rate * 100;
  if (ratePercent < lo) return 'bottom';
  if (ratePercent > hi) return 'top';
  return undefined;
}

/** UI-SPEC §7.13: the emphasis band's left edge snaps to the period CONTAINING the window start; a window start that falls between periods snaps forward to the next period rather than inventing a partial one. */
function findEmphasisStartKey(points: PeriodPoint[], emphasisStartMs: number): string | undefined {
  const containing = points.find(
    (point) => emphasisStartMs >= point.startMs && emphasisStartMs <= point.endMs,
  );
  if (containing) return containing.key;
  const after = points.find((point) => point.startMs >= emphasisStartMs);
  return (after ?? points[points.length - 1])?.key;
}

function periodDotRenderer(
  points: PeriodPoint[],
  domain: [number, number],
  dotSizing: PeriodDotSizing,
) {
  return function renderDot(dotProps: unknown): ReactElement {
    const { cx, cy, index } = dotProps as { cx?: number; cy?: number; index?: number };
    if (typeof cx !== 'number' || typeof cy !== 'number' || typeof index !== 'number') {
      return <g />;
    }
    const point = points[index];
    if (!point) {
      return <g />;
    }
    const radius = periodDotRadius(point.total, dotSizing);
    if (point.subFloor) {
      // Owner decision 2026-09-25: an off-domain sub-floor dot is drawn at
      // the nearest domain edge (never dropped, never widening the axis) and
      // marked data-pinned; its native tooltip and the table twin carry its
      // true rate.
      const pinned = pinnedEdgeFor(point, domain);
      return (
        <circle
          key={point.key}
          cx={cx}
          cy={cy}
          r={radius}
          fill={CHART_TOKENS.surface}
          stroke={CHART_TOKENS.deemphasis}
          strokeWidth={1.5}
          data-slot="trend-period-dot"
          data-point-key={point.key}
          data-sub-floor="true"
          {...(pinned ? { 'data-pinned': pinned } : {})}
        >
          {pinned && <title>{`${Math.round(point.rate * 100)}%`}</title>}
        </circle>
      );
    }
    return (
      <circle
        key={point.key}
        cx={cx}
        cy={cy}
        r={radius}
        fill={CHART_TOKENS.series1}
        stroke={CHART_TOKENS.surface}
        strokeWidth={2}
        data-slot="trend-period-dot"
        data-point-key={point.key}
        data-sub-floor="false"
      />
    );
  };
}

function periodLabelRenderer(
  points: PeriodPoint[],
  labeledIndices: Set<number>,
  placements: Map<number, PeriodValueLabelPlacement>,
) {
  return function renderLabel(labelProps: unknown): ReactElement {
    const { x, y, index } = labelProps as { x?: number; y?: number; index?: number };
    if (typeof x !== 'number' || typeof y !== 'number' || typeof index !== 'number') {
      return <g />;
    }
    if (!labeledIndices.has(index)) {
      return <g />;
    }
    const point = points[index];
    if (!point) {
      return <g />;
    }
    const placement = placements.get(index) ?? { below: false };
    return (
      <text
        x={x}
        y={
          placement.below
            ? y + PERIOD_VALUE_LABEL_BELOW_OFFSET_PX
            : y - PERIOD_VALUE_LABEL_OFFSET_PX
        }
        textAnchor="middle"
        data-placement={placement.below ? 'below' : 'above'}
        fill={CHART_TOKENS.text}
        fontSize={PERIOD_AXIS_FONT_SIZE_PX}
        fontWeight={600}
        {...VALUE_LABEL_HALO}
        data-slot="trend-period-value-label"
        data-point-key={point.key}
      >
        {`${Math.round(point.rate * 100)}%`}
      </text>
    );
  };
}

/**
 * UI-SPEC §7.13: a FUNCTION passed as XAxis `tick` receives `className`
 * (`recharts-cartesian-axis-tick-value`) in its props and must put it on its
 * own `text` — a static `tick={{ fill, fontSize }}` object (the event mode's
 * approach) cannot format per-tick text or vary the text-anchor by position,
 * both of which this axis needs.
 *
 * CR-01 (39.1-REVIEW.md): every tick's text AND `text-anchor` come verbatim
 * from `selectPeriodTickLayout`'s output — the same layout the selector
 * checked for collisions. This renderer never derives an anchor or a label
 * of its own (it previously re-derived anchors from the selected set's
 * first/last key, which disagreed with what the selector had assumed and
 * overlapped labels).
 */
/** The event mode's x tick text size (the kit's 12px axis size). */
const EVENT_TICK_TEXT = { fontSize: CHART_AXIS_FONT_SIZE } as const;
/** Plan 39.1-43b (sketch 003 A / 001-C `.xaxis{font-size:10px}`): the period trend's x labels. */
const PERIOD_TICK_TEXT = { fontSize: PERIOD_AXIS_FONT_SIZE_PX } as const;
type TickTextSize = typeof EVENT_TICK_TEXT | typeof PERIOD_TICK_TEXT;

function periodTickRenderer(layout: PeriodTickLayout[], textSize: TickTextSize = EVENT_TICK_TEXT) {
  const byKey = new Map(layout.map((tick) => [tick.key, tick]));
  return function renderTick(tickProps: unknown): ReactElement {
    const { x, y, payload, className } = tickProps as {
      x?: number;
      y?: number;
      payload?: { value?: string };
      className?: string;
    };
    const value = payload?.value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof value !== 'string') {
      return <g />;
    }
    const tick = byKey.get(value);
    if (!tick) {
      return <g />;
    }
    return (
      <text
        x={x}
        y={y}
        dy="0.71em"
        textAnchor={tick.anchor}
        className={className}
        fill={CHART_TOKENS.axisText}
        {...textSize}
      >
        {tick.label}
      </text>
    );
  };
}

interface PeriodChartRow {
  key: string;
  lineRatePercent: number | null;
  /** The period's TRUE rate — what a tooltip payload reads. */
  ratePercent: number;
  /** Where the dot is drawn: the true rate, or the nearest domain edge for a pinned sub-floor dot. */
  dotRatePercent: number;
}

function buildPeriodChartData(points: PeriodPoint[], domain: [number, number]): PeriodChartRow[] {
  const [lo, hi] = domain;
  return points.map((point) => {
    const ratePercent = point.rate * 100;
    return {
      key: point.key,
      lineRatePercent: point.subFloor ? null : ratePercent,
      ratePercent,
      dotRatePercent: point.subFloor ? Math.min(hi, Math.max(lo, ratePercent)) : ratePercent,
    };
  });
}

/**
 * Plan 39.1-43 (PD-43-1): the periods that count toward the unlock — only
 * those at the 3-game floor (`ABSTENTION_FLOOR_GAMES`; no new threshold).
 */
function periodTrendLockCounts(points: PeriodPoint[]): PeriodTrendLockCounts {
  const have = points.filter((point) => point.total >= ABSTENTION_FLOOR_GAMES).length;
  return { have, need: Math.max(0, PERIOD_TREND_MIN_PERIODS - have) };
}

function renderPeriodLockedInset(
  props: TrendLinePeriodProps,
  counts: PeriodTrendLockCounts,
): ReactElement {
  const fillPercent = Math.min(100, Math.round((counts.have / PERIOD_TREND_MIN_PERIODS) * 100));
  const countLabel = props.labels.lockedCountLabel(counts);
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-3"
      data-slot="trend-line-period-locked"
    >
      <p className="text-sm leading-5">{props.labels.lockedSentence(counts)}</p>
      {/* Plan 39.1-43 (sketch 001-C / 003 `.lock-row`): the meter and its
          count share one wrapping row; the meter grows (`flex: 1 1 80px`). */}
      <div data-slot="trend-locked-row" className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <div
          role="img"
          aria-label={countLabel}
          className="h-1.5 min-w-[60px] flex-[1_1_80px] overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${fillPercent}%`, backgroundColor: CHART_TOKENS.steady }}
          />
        </div>
        <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
          {countLabel}
        </span>
      </div>
    </div>
  );
}

function PeriodTableTwin({ props }: { props: TrendLinePeriodProps }): ReactElement {
  const [open, setOpen] = useState(false);
  const { i18n } = useTranslation();
  const { points, labels } = props;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="trend-line-period-table">
      <Button
        type="button"
        variant="link"
        size="sm"
        className={MUTED_LINK_TONE}
        onClick={() => setOpen((o) => !o)}
      >
        {labels.tableToggle}
      </Button>
      <CollapsibleContent>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col" className="text-left font-medium">
                {labels.tableHeaders.period}
              </th>
              <th scope="col" className="text-left font-medium">
                {labels.tableHeaders.record}
              </th>
              <th scope="col" className="text-left font-medium">
                {labels.tableHeaders.rate}
              </th>
              <th scope="col" className="text-left font-medium">
                {labels.tableHeaders.sample}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.key}>
                <td>{formatPeriodRowLabel(point, i18n.language)}</td>
                <td>{`${point.wins}–${point.losses}`}</td>
                <td>{`${Math.round(point.rate * 100)}%`}</td>
                <td>{point.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** UI-SPEC §7.13: the Y-axis's own reserved width, and the X-axis's left/right edge padding (both px). */
const PERIOD_Y_AXIS_WIDTH_PX = 60;
const PERIOD_X_AXIS_PADDING_PX = 16;
/**
 * CR-01: the period chart's outer margin on every side — Recharts'
 * `CartesianChart` default (5px), passed explicitly so the plot-width model
 * `selectPeriodTickLayout` receives is exactly the width the axis draws
 * across (it previously ignored the two 5px side margins, placing every
 * modelled tick up to 10px right of where it rendered). Plan 39.1-43 moved
 * the vertical constants (`PERIOD_CHART_MARGIN_PX`, the y-axis paddings,
 * the x-axis band) into `trendGeometry.ts`'s `periodPlotModel`.
 */
const PERIOD_CHART_MARGIN = {
  top: PERIOD_CHART_MARGIN_PX,
  right: PERIOD_CHART_MARGIN_PX,
  bottom: PERIOD_CHART_MARGIN_PX,
  left: PERIOD_CHART_MARGIN_PX,
};
/**
 * Plan 39.1-43b (sketch 003 A / 001-C `.trend.gutter{margin-left:26px}`):
 * the PERIOD chart has no left margin — its y-axis IS the sketch's 26px
 * gutter, so the plot starts 26px right of the head. The event mode keeps
 * `PERIOD_CHART_MARGIN` and its 60px axis.
 */
const PERIOD_TREND_MARGIN = { ...PERIOD_CHART_MARGIN, left: 0 };
/**
 * The period plot's modelled pixel geometry — the same model
 * `selectPeriodTickLayout` receives (container width minus margins, axis
 * width and edge padding), extended vertically by `trendGeometry`'s ONE
 * `periodPlotModel` so `placeReferenceLabel` and the hairline ticks see the
 * rendered plot.
 */
interface PeriodPlotModel {
  plotLeftPx: number;
  plotRightPx: number;
  /** The first category's x (px). */
  firstXPx: number;
  /** The x-axis band width the categories spread across (px). */
  plotWidthPx: number;
  valueTopPx: number;
  valueBottomPx: number;
  valueRangePx: number;
}

function periodPlotGeometry(
  containerWidth: number,
  height: number,
  plotLeftPx: number = PERIOD_CHART_MARGIN_PX + PERIOD_Y_AXIS_WIDTH_PX,
): PeriodPlotModel {
  const plotRightPx = containerWidth - PERIOD_CHART_MARGIN_PX;
  return {
    plotLeftPx,
    plotRightPx,
    firstXPx: plotLeftPx + PERIOD_X_AXIS_PADDING_PX,
    plotWidthPx: Math.max(0, plotRightPx - plotLeftPx - PERIOD_X_AXIS_PADDING_PX * 2),
    ...periodPlotModel(height),
  };
}

function modelY(model: PeriodPlotModel, [lo, hi]: [number, number], ratePercent: number): number {
  const share = hi > lo ? (ratePercent - lo) / (hi - lo) : 0.5;
  return model.valueTopPx + (1 - share) * (model.valueBottomPx - model.valueTopPx);
}

function modelX(model: PeriodPlotModel, index: number, count: number): number {
  if (count <= 1) return model.firstXPx + model.plotWidthPx / 2;
  return model.firstXPx + (index * model.plotWidthPx) / (count - 1);
}

/** UI-SPEC §7.13: the recent band is never narrower than this (px). */
const PERIOD_BAND_MIN_WIDTH_PX = 4;

/**
 * Plan 39.1-41 (sketch 003 `.band`, UI-SPEC §7.13 "from the period containing
 * the window start to the right edge", "1px left edge"): Recharts draws a
 * category ReferenceArea from the first period's centre to the last
 * period's centre. The band instead covers the first period's whole slot
 * (half a category step left of its centre, never left of the plot) and
 * runs to the plot's right edge (the last centre plus the x-axis padding),
 * with a 1px series-1 left edge.
 */
function periodBandShape(model: PeriodPlotModel, count: number) {
  const halfStepPx = count > 1 ? model.plotWidthPx / (count - 1) / 2 : model.plotWidthPx / 2;
  return function renderBand(shapeProps: unknown): ReactElement<SVGElement> {
    const { x, y, width, height, x1, x2 } = shapeProps as {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      x1?: string | number;
      x2?: string | number;
    };
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      return (<g />) as ReactElement<SVGElement>;
    }
    const left = Math.max(model.plotLeftPx, x - halfStepPx);
    const right = Math.max(left + PERIOD_BAND_MIN_WIDTH_PX, x + width + PERIOD_X_AXIS_PADDING_PX);
    return (
      // Recharts types a ReferenceArea shape as ReactElement<SVGElement>.
      (
        <g>
          <rect
            className="recharts-reference-area-rect"
            x={left}
            y={y}
            width={right - left}
            height={height}
            fill={CHART_TOKENS.series1}
            fillOpacity={0.1}
            x1={x1}
            x2={x2}
          />
          <line
            data-slot="trend-period-band-edge"
            x1={left}
            x2={left}
            y1={y}
            y2={y + height}
            stroke={CHART_TOKENS.series1}
            strokeWidth={1}
          />
        </g>
      ) as ReactElement<SVGElement>
    );
  };
}

/**
 * Used only to derive the initial plot-width estimate before
 * `ResponsiveContainer`'s first real `onResize` callback fires — mirrors
 * `EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH`'s own role for event mode; the
 * runtime page render is still governed by the actual measured width the
 * moment it's available.
 */
const PERIOD_TICKS_RESPONSIVE_FALLBACK_WIDTH = EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH;

/**
 * Period mode's entire render tree (VIZ-01, VIZ-03, UI-SPEC §7.13) — a real
 * component (not a plain function call), because `selectPeriodTickLayout` needs
 * the plot's actual pixel width, and that width is only known instantly when
 * an explicit `width` prop is given (every test); at runtime (no explicit
 * width) it comes from `ResponsiveContainer`'s own `onResize` callback, which
 * requires component state.
 */
function PeriodTrendChart({
  props,
  width,
  height,
  onClick,
}: {
  props: TrendLinePeriodProps;
  width?: number;
  height: number;
  onClick: (state: MouseHandlerDataParam) => void;
}): ReactElement {
  const { points } = props;
  const { i18n } = useTranslation();
  const locale = i18n.language;

  // Every hook above every early return (Rules of Hooks) — the locked-state
  // branch below still needs this component to have called exactly the same
  // hooks on every render regardless of `points.length`.
  const [measuredWidth, setMeasuredWidth] = useState(PERIOD_TICKS_RESPONSIVE_FALLBACK_WIDTH);
  const dotSizing: PeriodDotSizing = props.dotSizing ?? 'games';

  // Plan 39.1-43 (PD-43-1, UI-SPEC §7.13): locked while fewer than 8
  // periods reach the 3-game floor — a sub-floor period no longer counts.
  const lockCounts = periodTrendLockCounts(points);
  const title = props.labels.title;
  if (lockCounts.have < PERIOD_TREND_MIN_PERIODS) {
    return (
      <PeriodTrendRoot state="locked" dotSizing={dotSizing} valueRangePx={props.valueRangePx}>
        {title && <PeriodTrendHead title={title} items={[]} />}
        {renderPeriodLockedInset(props, lockCounts)}
        <PeriodTableTwin props={props} />
      </PeriodTrendRoot>
    );
  }

  const containerWidth = typeof width === 'number' ? width : measuredWidth;
  const model = periodPlotGeometry(containerWidth, height, PERIOD_Y_GUTTER_PX);
  const { plotWidthPx } = model;

  const domain = computePeriodYDomain(points, props.referenceRate);
  const [yMin, yMax] = domain;
  // Plan 39.1-43b: sketch 003 A's tick step (20 over a span above 50).
  const yTicks = periodRateTicks(domain, model.valueRangePx);
  const data = buildPeriodChartData(points, domain);
  const labeledIndices = findPeriodLabeledIndices(points);
  const labelRoles = findPeriodLabelRoles(points);
  const labelPlacements = new Map<number, PeriodValueLabelPlacement>(
    [...labeledIndices].map((i) => [
      i,
      periodValueLabelPlacement({
        yPx: modelY(model, domain, points[i]!.rate * 100),
        valueTopPx: model.valueTopPx,
        valueBottomPx: model.valueBottomPx,
        isMin: labelRoles?.min === i,
        isMax: labelRoles?.max === i,
        isLast: labelRoles?.last === i,
      }),
    ]),
  );
  const tickLayout = selectPeriodTickLayout(points, { plotWidthPx, locale });
  const referenceLabel = props.labels.referenceLabel;
  // Plan 39.1-43 (OOS-6): every DRAWN dot — at the diameter it renders,
  // pinned sub-floor dots at their edge — blocks a label slot.
  const drawnDots = points.map((point, i) => ({
    xPx: modelX(model, i, points.length),
    yPx: modelY(model, domain, data[i]!.dotRatePercent),
    diameterPx: periodDotRadius(point.total, dotSizing) * 2,
    subFloor: point.subFloor,
  }));
  const referenceLabelPosition: ReferenceLabelPlacement | undefined =
    props.referenceRate !== undefined && referenceLabel
      ? placeReferenceLabel({
          referenceYPx: modelY(model, domain, props.referenceRate),
          referenceLabelWidthPx: estimateTickLabelWidthPx(referenceLabel),
          plotLeftPx: model.plotLeftPx,
          plotRightPx: model.plotRightPx,
          labelledPoints: [...labeledIndices].map((i) => {
            const point = points[i]!;
            const placement = labelPlacements.get(i);
            return {
              xPx: modelX(model, i, points.length),
              yPx: modelY(model, domain, point.rate * 100),
              labelWidthPx: estimateTickLabelWidthPx(`${Math.round(point.rate * 100)}%`),
              below: placement?.below,
            };
          }),
          dots: drawnDots,
        })
      : undefined;
  const emphasisStartKey =
    props.emphasisStartMs !== undefined
      ? findEmphasisStartKey(points, props.emphasisStartMs)
      : undefined;
  const lastKey = points[points.length - 1]!.key;
  const lineStrokeWidth = periodLineStrokeWidth(height, props.valueRangePx);

  const chart = (
    <LineChart
      {...(typeof width === 'number' ? { width, height } : {})}
      data={data}
      margin={PERIOD_TREND_MARGIN}
      onClick={onClick}
      accessibilityLayer
    >
      {/* Plan 39.1-43b (sketch `.trend .grid-y`): horizontal hairlines only,
          each at a y tick — no vertical grid, no plot-box edge lines. */}
      <CartesianGrid stroke={CHART_TOKENS.grid} vertical={false} syncWithTicks />
      <XAxis
        dataKey="key"
        type="category"
        domain={points.map((point) => point.key)}
        ticks={tickLayout.map((tick) => tick.key)}
        interval={0}
        padding={{ left: PERIOD_X_AXIS_PADDING_PX, right: PERIOD_X_AXIS_PADDING_PX }}
        axisLine={false}
        tickLine={false}
        tick={periodTickRenderer(tickLayout, PERIOD_TICK_TEXT)}
      />
      {/* The primary axis carries nothing outside the fitted domain (joined
          periods are fitted, sub-floor dots are clamped to it), so it needs no
          allowDataOverflow — whose clip would cut an edge dot in half. */}
      {/* Plan 39.1-43b (sketch `.ytick{left:-26px;width:20px;text-align:right;
          font-size:10px}`): the axis is the 26px gutter, each tick right-aligned
          6px left of the plot, no axis line or tick mark. */}
      <YAxis
        domain={[yMin, yMax]}
        ticks={yTicks}
        interval={0}
        width={PERIOD_Y_GUTTER_PX}
        padding={{ top: PERIOD_Y_AXIS_PADDING_TOP_PX, bottom: PERIOD_Y_AXIS_PADDING_BOTTOM_PX }}
        axisLine={false}
        tickLine={false}
        tickSize={0}
        tickMargin={PERIOD_Y_TICK_GAP_PX}
        tick={{ fill: CHART_TOKENS.axisText, fontSize: PERIOD_AXIS_FONT_SIZE_PX }}
      />
      {props.tooltip && (
        <Tooltip content={props.tooltip} cursor={{ stroke: CHART_TOKENS.border }} />
      )}
      {props.referenceRate !== undefined && (
        <ReferenceLine
          y={props.referenceRate}
          stroke={CHART_TOKENS.deemphasis}
          label={
            referenceLabel && referenceLabelPosition && referenceLabelPosition !== 'none'
              ? {
                  value: referenceLabel,
                  position: referenceLabelPosition,
                  fill: CHART_TOKENS.axisText,
                  fontSize: PERIOD_AXIS_FONT_SIZE_PX,
                  // Sketch 001-C draws the label on the card surface.
                  ...VALUE_LABEL_HALO,
                  // Recharts replaces its own `recharts-label` class with a custom one — keep both.
                  className: 'recharts-label trend-period-reference-label',
                }
              : undefined
          }
        />
      )}
      {emphasisStartKey !== undefined && (
        <ReferenceArea
          x1={emphasisStartKey}
          x2={lastKey}
          fill={CHART_TOKENS.series1}
          fillOpacity={0.1}
          ifOverflow="visible"
          shape={periodBandShape(model, points.length)}
        />
      )}
      <Line
        className="trend-line-period-line"
        type="linear"
        dataKey="lineRatePercent"
        stroke={CHART_TOKENS.series1}
        strokeWidth={lineStrokeWidth}
        dot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
      <Line
        type="linear"
        dataKey="dotRatePercent"
        stroke="none"
        dot={periodDotRenderer(points, domain, dotSizing)}
        label={periodLabelRenderer(points, labeledIndices, labelPlacements)}
        isAnimationActive={false}
      />
    </LineChart>
  );

  const plot =
    typeof width === 'number' ? (
      chart
    ) : (
      <ResponsiveContainer width="100%" height={height} onResize={(w) => setMeasuredWidth(w)}>
        {chart}
      </ResponsiveContainer>
    );

  const legend = props.labels.legend;
  const headItems: PeriodTrendHeadItem[] = [];
  if (legend) {
    headItems.push({ kind: 'dot', text: legend.dot });
    if (points.some((point) => point.subFloor)) {
      headItems.push({ kind: 'hollow', text: legend.hollow });
    }
    if (props.referenceRate !== undefined && legend.reference) {
      headItems.push({ kind: 'reference', text: legend.reference });
    }
    if (emphasisStartKey !== undefined && legend.band) {
      headItems.push({ kind: 'band', text: legend.band });
    }
  }

  return (
    <PeriodTrendRoot
      state="drawn"
      dotSizing={dotSizing}
      yDomain={domain}
      valueRangePx={props.valueRangePx}
      referenceLabelPosition={referenceLabelPosition}
    >
      {title && <PeriodTrendHead title={title} items={headItems} />}
      {plot}
      <PeriodTableTwin props={props} />
    </PeriodTrendRoot>
  );
}

type PeriodTrendHeadKind = 'dot' | 'hollow' | 'reference' | 'band';

interface PeriodTrendHeadItem {
  kind: PeriodTrendHeadKind;
  text: string;
}

/** Plan 39.1-43: the legend swatches, drawn from CHART_TOKENS only (sketch 003 `.lg-*` CSS 171-176). */
function PeriodLegendSwatch({ kind }: { kind: PeriodTrendHeadKind }): ReactElement {
  if (kind === 'dot') {
    return (
      <span
        aria-hidden="true"
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ backgroundColor: CHART_TOKENS.series1 }}
      />
    );
  }
  if (kind === 'hollow') {
    return (
      <span
        aria-hidden="true"
        className="inline-block size-2 shrink-0 rounded-full"
        style={{
          backgroundColor: CHART_TOKENS.surface,
          boxShadow: `inset 0 0 0 1.5px ${CHART_TOKENS.deemphasis}`,
        }}
      />
    );
  }
  if (kind === 'reference') {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-px w-3.5 shrink-0"
        style={{ backgroundColor: CHART_TOKENS.deemphasis }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="relative inline-block h-2.5 w-3.5 shrink-0"
      style={{ borderLeft: `1px solid ${CHART_TOKENS.series1}` }}
    >
      <span
        className="absolute inset-0"
        style={{ backgroundColor: CHART_TOKENS.series1, opacity: 0.1 }}
      />
    </span>
  );
}

/**
 * Plan 39.1-43 (sketch 001-C `trendSection` 494 / sketch 003 `trendLegend`
 * 809 and `.sect-head`): the trend's head — its overline (the grain title)
 * then the swatch legend on one wrapping line. The legend items sit on their
 * own centred row, as the form strip's head does (39.1-42's fidelity loop:
 * a baseline row sets swatch items' text off the text-only items' line).
 */
function PeriodTrendHead({
  title,
  items,
}: {
  title: string;
  items: PeriodTrendHeadItem[];
}): ReactElement {
  return (
    <div
      data-slot="trend-period-head"
      className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5"
    >
      <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </p>
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-xs leading-4 text-muted-foreground">
          {items.map((item) => (
            <span
              key={item.kind}
              data-slot="trend-legend-item"
              data-kind={item.kind}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <PeriodLegendSwatch kind={item.kind} />
              {item.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Plan 39.1-41: the period trend's root — layout-neutral (`display:
 * contents`, so the plot and its table twin stay direct flex/grid items of
 * the host) — declaring what the chart drew for guard:layout's
 * period-trend-marks family and the fidelity captures: `data-state`
 * (drawn | locked), `data-dot-sizing` and, when drawn, `data-y-domain`
 * ("lo,hi", the fitted domain); plan 39.1-43 adds `data-value-range-px` and
 * `data-reference-label-position`.
 */
function PeriodTrendRoot({
  state,
  dotSizing,
  yDomain,
  valueRangePx,
  referenceLabelPosition,
  children,
}: {
  state: 'drawn' | 'locked';
  dotSizing: PeriodDotSizing;
  yDomain?: [number, number];
  /** Plan 39.1-43 (PD-43-3): the requested value range, as `data-value-range-px`. */
  valueRangePx?: number;
  /** Plan 39.1-43 (OOS-6): the reference label's slot, or 'none', as `data-reference-label-position`. */
  referenceLabelPosition?: ReferenceLabelPlacement;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="contents"
      data-slot="trend-line-period"
      data-state={state}
      data-dot-sizing={dotSizing}
      {...(yDomain ? { 'data-y-domain': `${yDomain[0]},${yDomain[1]}` } : {})}
      {...(valueRangePx !== undefined ? { 'data-value-range-px': String(valueRangePx) } : {})}
      {...(referenceLabelPosition
        ? { 'data-reference-label-position': referenceLabelPosition }
        : {})}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Value mode (plan 41-02, A1 / DD-41-01, UI-SPEC §7.1) — a fourth member of the mode union: a
// time-axis numeric trend (GSP, estimated MMR, Glicko-2) whose points arrive PRE-BINNED from shared
// `buildValueSeries`. It lives in this file so the Recharts import stays inside the two files
// `chartKitBoundary.test.ts` already lists; its plain-DOM parts (head, locked inset, table twin) live
// in `valueTrendParts.tsx` and its pure geometry in `valueTrendGeometry.ts`.
//
// Every mark, label and the crosshair are drawn by two small layers that read the chart's OWN
// scales (`useXAxisScale` / `useYAxisScale` / `usePlotArea`, the `CareerTimeline` pattern) — never a
// second layout and never a Recharts mouse event. The pointer → x mapping is a transparent hit rect
// over the plot (nearest point by x), which also removes the need to trust Recharts' value
// synchronisation across panels with different x sets (RESEARCH correction 1).
// ---------------------------------------------------------------------------

const VALUE_RESPONSIVE_FALLBACK_WIDTH = EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH;
/** Phase 38's focus-ring recipe (UI-SPEC §10.1), on the plot's one tab stop. */
const VALUE_PLOT_FOCUS_CLASSES =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
/** The readout's wrapper (UI-SPEC §9.2: max 280px, `meta`, tabular) around `ChartTooltip`'s own surface. */
const VALUE_READOUT_CLASSES =
  'pointer-events-none absolute z-10 w-max max-w-[min(280px,100%)] tabular-nums';
/** UI-SPEC §9.1: the last-point dot scales this much while it is the active point. */
const VALUE_ACTIVE_DOT_SCALE = 1.35;
/** The x tick label's baseline under the plot, and the tick mark's length (px). */
const VALUE_X_LABEL_BASELINE_PX = 16;
const VALUE_X_TICK_LENGTH_PX = 4;
/** The y axis's own tick gap (px) between the tick text and the plot's left edge. */
const VALUE_Y_TICK_GAP_PX = 6;

type ValueActiveSource = 'pointer' | 'keyboard' | 'touch';

interface ValueActive {
  index: number;
  source: ValueActiveSource;
}

/** The chart's own scales, or `null` until Recharts has laid the chart out. */
function useValuePlot() {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  if (!xScale || !yScale || !plot) return null;
  return { xScale, yScale, plot };
}

interface ValueLayerProps {
  points: TrendValuePoint[];
  grain: ValueSeriesGrain;
  xDomain: [number, number];
  drawXAxis: boolean;
  locale: string;
  /** Where the crosshair stands (ms), or null. */
  crosshairMs: number | null;
  /** The active point's index (its dot is emphasised when it is the last), or null. */
  activeIndex: number | null;
  selectable: boolean;
  /** A fine pointer moved over the plot: the nearest point's index. */
  onHover: (index: number) => void;
  /** A fine pointer left the plot. */
  onLeave: () => void;
  /** A click / tap landed: the nearest point's index; `touch` says it came from a finger. */
  onPress: (index: number, touch: boolean) => void;
}

/** Under the line: the x tick labels (from `selectTimeAxisTicks`, the `CareerTimeline` way). */
function ValueUnderLayer({ drawXAxis, xDomain, locale }: ValueLayerProps): ReactElement | null {
  const scales = useValuePlot();
  if (!scales || !drawXAxis) return null;
  const { xScale, plot } = scales;
  const ticks = selectTimeAxisTicks({
    startMs: xDomain[0],
    endMs: xDomain[1],
    plotWidthPx: plot.width,
    locale,
  });
  const baseline = plot.y + plot.height;
  return (
    <g data-slot="trend-value-x-axis">
      {ticks.gridlines.map((ms) => {
        const x = xScale(ms);
        if (x == null) return null;
        return (
          <line
            key={`tick:${ms}`}
            x1={x}
            x2={x}
            y1={baseline}
            y2={baseline + VALUE_X_TICK_LENGTH_PX}
            stroke={CHART_TOKENS.grid}
            strokeWidth={1}
          />
        );
      })}
      {ticks.labels.map((label) => {
        const x = xScale(label.ms);
        if (x == null) return null;
        return (
          <text
            key={`label:${label.ms}`}
            data-slot="trend-value-x-label"
            x={x + TIME_AXIS_LABEL_OFFSET_PX}
            y={baseline + VALUE_X_LABEL_BASELINE_PX}
            textAnchor={label.anchor}
            fill={CHART_TOKENS.axisText}
            fontSize={CHART_AXIS_FONT_SIZE}
          >
            {label.text}
          </text>
        );
      })}
    </g>
  );
}

function diamondPath(x: number, y: number, diagonal: number): string {
  const half = diagonal / 2;
  return `M${x} ${y - half} ${x + half} ${y} ${x} ${y + half} ${x - half} ${y}Z`;
}

/** Over the line: marks, the crosshair and the transparent pointer layer. */
function ValueTopLayer(props: ValueLayerProps): ReactElement | null {
  const { points, grain, crosshairMs, activeIndex, selectable, onHover, onLeave, onPress } = props;
  const scales = useValuePlot();
  // The pointerType of the press that precedes a click — a React click is a MouseEvent in some
  // engines, so the pointerdown is the reliable source (the `CareerTimeline` pattern).
  const pressTypeRef = useRef<string | null>(null);
  if (!scales) return null;
  const { xScale, yScale, plot } = scales;

  function locate(event: ReactPointerEvent<SVGRectElement> | ReactMouseEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    const rect = svg ? svg.getBoundingClientRect() : { left: 0 };
    const x = event.clientX - rect.left;
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    points.forEach((point, i) => {
      const px = xScale!(point.xMs);
      if (px == null) return;
      const distance = Math.abs(px - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  }

  const last = points.length - 1;
  const crosshairX = crosshairMs !== null ? xScale(crosshairMs) : undefined;
  return (
    <g data-slot="trend-value-top-layer">
      {points.map((point, i) => {
        const kind = valueMarkKind(point, { isLast: i === last, grain });
        if (!kind) return null;
        const x = xScale(point.xMs);
        const y = yScale(point.value);
        if (x == null || y == null) return null;
        if (kind === 'diamond') {
          return (
            <path
              key={point.key}
              data-slot="trend-value-diamond"
              data-point-key={point.key}
              d={diamondPath(x, y, VALUE_DIAMOND_DIAGONAL_PX)}
              fill={CHART_TOKENS.deemphasis}
              stroke={CHART_TOKENS.surface}
              strokeWidth={VALUE_DIAMOND_STROKE_PX}
              pointerEvents="none"
            />
          );
        }
        const scale = i === last && i === activeIndex ? VALUE_ACTIVE_DOT_SCALE : 1;
        return (
          <circle
            key={point.key}
            data-slot="trend-value-dot"
            data-point-key={point.key}
            cx={x}
            cy={y}
            r={(VALUE_DOT_DIAMETER_PX / 2) * scale}
            fill={CHART_TOKENS.series1}
            stroke={CHART_TOKENS.surface}
            strokeWidth={VALUE_DOT_RING_PX}
            pointerEvents="none"
          />
        );
      })}
      {crosshairX != null && (
        <g pointerEvents="none">
          <line
            data-slot="trend-value-crosshair"
            x1={crosshairX}
            x2={crosshairX}
            y1={plot.y}
            y2={plot.y + plot.height}
            stroke={CHART_TOKENS.deemphasisStrong}
            strokeWidth={1}
          />
          {activeIndex !== null &&
            points[activeIndex] !== undefined &&
            points[activeIndex]!.xMs === crosshairMs &&
            yScale(points[activeIndex]!.value) != null && (
              <circle
                data-slot="trend-value-crosshair-dot"
                cx={crosshairX}
                cy={yScale(points[activeIndex]!.value)}
                r={VALUE_DOT_DIAMETER_PX / 2}
                fill={CHART_TOKENS.series1}
                stroke={CHART_TOKENS.surface}
                strokeWidth={VALUE_DOT_RING_PX}
              />
            )}
        </g>
      )}
      <rect
        data-slot="trend-value-hit"
        x={plot.x}
        y={plot.y}
        width={plot.width}
        height={plot.height}
        fill="transparent"
        style={selectable ? { cursor: 'pointer' } : undefined}
        onPointerDown={(event) => {
          pressTypeRef.current = event.pointerType || null;
        }}
        onPointerMove={(event) => {
          // A finger dragging over the plot scrolls the page; only fine pointers hover.
          if (event.pointerType === 'touch') return;
          const index = locate(event);
          if (index >= 0) onHover(index);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'touch') return;
          onLeave();
        }}
        onClick={(event) => {
          const touch = pressTypeRef.current === 'touch';
          pressTypeRef.current = null;
          const index = locate(event);
          if (index >= 0) onPress(index, touch);
        }}
      />
    </g>
  );
}

/** The span a single-point (or flat-x) series is centred in so the x axis never divides by zero. */
const VALUE_SINGLE_POINT_HALF_SPAN_MS = 24 * 60 * 60 * 1000;

function defaultXDomain(points: readonly { xMs: number }[]): [number, number] {
  const first = points[0]!.xMs;
  const last = points[points.length - 1]!.xMs;
  return last > first
    ? [first, last]
    : [first - VALUE_SINGLE_POINT_HALF_SPAN_MS, last + VALUE_SINGLE_POINT_HALF_SPAN_MS];
}

/**
 * Value mode's whole render tree — a real component because the narrow re-grain and the readout
 * both need the plot's measured width, known instantly with an explicit `width` (every test) and
 * from `ResponsiveContainer`'s `onResize` at runtime.
 */
function ValueTrendChart({
  props,
  width,
  height,
}: {
  props: TrendLineValueProps;
  width?: number;
  height: number;
}): ReactElement | null {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const [measuredWidth, setMeasuredWidth] = useState(VALUE_RESPONSIVE_FALLBACK_WIDTH);
  const [active, setActive] = useState<ValueActive | null>(null);
  const [readoutWidth, setReadoutWidth] = useState(0);
  const readoutRef = useRef<HTMLDivElement>(null);

  // Every hook lives ABOVE the early returns below. The readout's own width decides which side of
  // the crosshair it sits on; it is re-measured whenever it shows a different point.
  const activeKey = active ? `${active.index}` : null;
  useLayoutEffect(() => {
    const el = readoutRef.current;
    if (!el) return undefined;
    function measure() {
      if (el) setReadoutWidth(el.offsetWidth);
    }
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeKey]);

  const { points, grain, cursor, formatTick, reference } = props;
  if (points.length === 0) return null;

  const drawXAxis = props.drawXAxis ?? true;
  const containerWidth = typeof width === 'number' ? width : measuredWidth;
  const referenceArg = reference
    ? { value: reference.value, placement: reference.placement }
    : undefined;
  const axis: ValueYAxis | null = buildValueYAxis(
    points.map((point) => point.value),
    formatTick,
    referenceArg,
  );
  if (!axis) return null;

  const gutterPx = Math.max(axis.gutterPx, props.gutterPx ?? 0);
  const plotWidthPx = Math.max(0, containerWidth - gutterPx - VALUE_MARGIN_RIGHT_PX);
  const bottomPx = drawXAxis ? VALUE_X_AXIS_BAND_PX : VALUE_MARGIN_BOTTOM_PX;
  const xDomain = props.xDomain ?? defaultXDomain(points);
  const lineStrokeWidth =
    props.lineWidth === 'thin' || height <= CHART_H_COMPACT ? 1.5 : CHART_LINE_WIDTH;

  const activeIndex = cursor
    ? cursor.xMs !== null
      ? nearestPointIndex(points, cursor.xMs)
      : null
    : (active?.index ?? null);
  const crosshairMs = cursor
    ? cursor.xMs
    : activeIndex !== null
      ? (points[activeIndex]?.xMs ?? null)
      : null;
  const activePoint = activeIndex !== null ? points[activeIndex] : undefined;

  function setActiveIndex(index: number, source: ValueActiveSource) {
    const point = points[index];
    if (!point) return;
    if (cursor) cursor.onChange(point.xMs);
    else setActive({ index, source });
  }

  function select(index: number) {
    const point = points[index];
    if (point) props.onSelectPoint?.(point);
  }

  function handlePress(index: number, touch: boolean) {
    if (touch) {
      // A first tap shows the readout; a second tap on the same point selects it — a single tap
      // never acts on a point the reader has not seen.
      if (activeIndex === index && (cursor || active?.source === 'touch')) {
        select(index);
        return;
      }
      setActiveIndex(index, 'touch');
      return;
    }
    setActiveIndex(index, 'pointer');
    select(index);
  }

  const rows = points.map((point) => ({ xMs: point.xMs, value: point.value }));
  const layerProps: ValueLayerProps = {
    points,
    grain,
    xDomain,
    drawXAxis,
    locale,
    crosshairMs,
    activeIndex,
    selectable: props.onSelectPoint !== undefined,
    onHover: (index) => setActiveIndex(index, 'pointer'),
    onLeave: () => {
      if (cursor) cursor.onChange(null);
      else setActive((previous) => (previous?.source === 'pointer' ? null : previous));
    },
    onPress: handlePress,
  };

  const chart = (
    <LineChart
      {...(typeof width === 'number' ? { width, height } : {})}
      // One tab stop per plot (the wrapper below): Recharts' default accessibility layer would add a second.
      accessibilityLayer={false}
      data={rows}
      margin={{ top: VALUE_MARGIN_TOP_PX, right: VALUE_MARGIN_RIGHT_PX, bottom: bottomPx, left: 0 }}
    >
      <CartesianGrid stroke={CHART_TOKENS.grid} vertical={false} syncWithTicks />
      <XAxis type="number" dataKey="xMs" scale="linear" domain={xDomain} allowDataOverflow hide />
      <YAxis
        type="number"
        scale="linear"
        domain={axis.domain}
        ticks={axis.ticks}
        interval={0}
        width={gutterPx}
        axisLine={false}
        tickLine={false}
        tickSize={0}
        tickMargin={VALUE_Y_TICK_GAP_PX}
        tickFormatter={(value: number) => formatTick(value)}
        tick={{ fill: CHART_TOKENS.axisText, fontSize: CHART_AXIS_FONT_SIZE }}
        allowDataOverflow
      />
      <ZIndexLayer zIndex={DefaultZIndexes.grid}>
        <ValueUnderLayer {...layerProps} />
      </ZIndexLayer>
      <Line
        className="trend-line-value-line"
        type="linear"
        dataKey="value"
        stroke={CHART_TOKENS.series1}
        strokeWidth={lineStrokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        dot={false}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
      <ZIndexLayer zIndex={DefaultZIndexes.label}>
        <ValueTopLayer {...layerProps} />
      </ZIndexLayer>
    </LineChart>
  );

  const plot =
    typeof width === 'number' ? (
      chart
    ) : (
      <ResponsiveContainer width="100%" height={height} onResize={(w) => setMeasuredWidth(w)}>
        {chart}
      </ResponsiveContainer>
    );

  // The standalone readout (a grid owns one readout for all its panels and passes `cursor`).
  const readoutAnchorX =
    gutterPx +
    (((activePoint?.xMs ?? xDomain[0]) - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotWidthPx;
  const readoutLeft = clampReadoutLeft({
    anchorX: readoutAnchorX,
    readoutWidth: Math.min(readoutWidth, CAREER_TIMELINE_READOUT_MAX_WIDTH_PX),
    containerWidth,
  });

  return (
    <div
      className="contents"
      data-slot="trend-line-value"
      data-state="drawn"
      data-grain={grain}
      data-point-count={points.length}
      data-y-domain={`${axis.domain[0]},${axis.domain[1]}`}
    >
      <div
        data-slot="trend-value-frame"
        className="relative [&_.recharts-surface]:overflow-visible"
      >
        <div
          data-slot="trend-value-plot"
          role="img"
          tabIndex={0}
          aria-label={props.labels.aria}
          className={VALUE_PLOT_FOCUS_CLASSES}
        >
          {plot}
        </div>
        {!cursor && activePoint && (
          <div
            ref={readoutRef}
            data-slot="trend-value-readout"
            aria-hidden="true"
            className={VALUE_READOUT_CLASSES}
            style={{ left: readoutLeft, top: VALUE_MARGIN_TOP_PX }}
          >
            <ChartTooltip active payload={[{ payload: activePoint }]} />
          </div>
        )}
      </div>
    </div>
  );
}
