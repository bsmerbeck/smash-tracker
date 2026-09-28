import { useCallback, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { XAxis, YAxis, type MouseHandlerDataParam } from 'recharts';
import type { PeriodPoint } from '@smash-tracker/shared';
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
  PERIOD_Y_AXIS_PADDING_BOTTOM_PX,
  PERIOD_Y_AXIS_PADDING_TOP_PX,
  fitRateDomain,
  periodChartHeightForValueRange,
  periodDotDiameter,
  periodDotDiameterForTier,
  periodPlotModel,
  periodValueLabelPlacement,
  placeReferenceLabel,
  rateDomainTicks,
  type PeriodValueLabelPlacement,
  type ReferenceLabelPlacement,
} from './trendGeometry';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';

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
 * A discriminated union on `mode`, not two overloaded call signatures: every
 * existing consumer omits `mode` entirely, which selects `TrendLineIndexProps`
 * (`mode` optional there, required as the literal `'event'` on the other
 * member) with no change to its own type-checking.
 */
export type TrendLineProps = TrendLineIndexProps | TrendLineEventProps | TrendLinePeriodProps;

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
        fill={CHART_TOKENS.axisText}
        fontSize={CHART_AXIS_FONT_SIZE}
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
function periodTickRenderer(layout: PeriodTickLayout[]) {
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
        fontSize={CHART_AXIS_FONT_SIZE}
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
      <div
        role="img"
        aria-label={countLabel}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${fillPercent}%`, backgroundColor: CHART_TOKENS.steady }}
        />
      </div>
      <p className="text-xs leading-4 text-muted-foreground tabular-nums">{countLabel}</p>
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

function periodPlotGeometry(containerWidth: number, height: number): PeriodPlotModel {
  const plotLeftPx = PERIOD_CHART_MARGIN_PX + PERIOD_Y_AXIS_WIDTH_PX;
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
  const model = periodPlotGeometry(containerWidth, height);
  const { plotWidthPx } = model;

  const domain = computePeriodYDomain(points, props.referenceRate);
  const [yMin, yMax] = domain;
  const yTicks = rateDomainTicks(domain, model.valueRangePx);
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
      margin={PERIOD_CHART_MARGIN}
      onClick={onClick}
      accessibilityLayer
    >
      <CartesianGrid stroke={CHART_TOKENS.grid} />
      <XAxis
        dataKey="key"
        type="category"
        domain={points.map((point) => point.key)}
        ticks={tickLayout.map((tick) => tick.key)}
        interval={0}
        padding={{ left: PERIOD_X_AXIS_PADDING_PX, right: PERIOD_X_AXIS_PADDING_PX }}
        tick={periodTickRenderer(tickLayout)}
      />
      {/* The primary axis carries nothing outside the fitted domain (joined
          periods are fitted, sub-floor dots are clamped to it), so it needs no
          allowDataOverflow — whose clip would cut an edge dot in half. */}
      <YAxis
        domain={[yMin, yMax]}
        ticks={yTicks}
        interval={0}
        width={PERIOD_Y_AXIS_WIDTH_PX}
        padding={{ top: PERIOD_Y_AXIS_PADDING_TOP_PX, bottom: PERIOD_Y_AXIS_PADDING_BOTTOM_PX }}
        tick={{ fill: CHART_TOKENS.axisText, fontSize: CHART_AXIS_FONT_SIZE }}
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
                  fontSize: CHART_AXIS_FONT_SIZE,
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
