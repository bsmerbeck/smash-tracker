import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
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
import { PERIOD_TREND_MIN_PERIODS } from '@smash-tracker/shared';
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
import { formatEventTickLabel, selectEventTicks } from './eventTicks';
import { formatPeriodTickLabel, formatPeriodRowLabel, selectPeriodTicks } from './periodTicks';

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
 * VIZ-01 (UI-SPEC §7.13): the three dot-size steps by sample size, ×2 the
 * kit's existing `CHART_DOT_RADIUS` convention (radius, not diameter — the
 * "5/7/9px" the spec names). Exported per the plan's artifact list.
 */
export const PERIOD_DOT_RADIUS_SMALL = 5;
export const PERIOD_DOT_RADIUS_MEDIUM = 7;
export const PERIOD_DOT_RADIUS_LARGE = 9;

/** UI-SPEC §7.13's table-twin column headers — fully composed by the host (Track B rule B1). */
export interface TrendLinePeriodTableHeaders {
  period: string;
  record: string;
  rate: string;
  sample: string;
}

/** Every string this mode needs, fully composed by the host — the chart never localises (UI-SPEC §9.2 rule 6). */
export interface TrendLinePeriodLabels {
  /** UI-SPEC §7.13 locked state, e.g. "Period trend — 3 more weeks with 3+ games unlock this chart." — the host interpolates the count. */
  lockedSentence: string;
  /** The locked meter's accessible count label, e.g. "3 of 8 weeks". */
  lockedCountLabel: string;
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
  /** An optional cumulative-rate context step series (Matchups only, UI-SPEC §7.13's Phase-38 D-11 semantic demoted to context), 0-100, same length/order as `points`. */
  contextRatePercents?: number[];
  labels: TrendLinePeriodLabels;
}

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

/**
 * The trend-with-context vocabulary member (D-05): a single-series line over
 * a fixed 0-100 win-rate domain. D-04: accepts an explicit numeric
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
 *   always-visible per-point W-L label. Tick DENSITY is decided by this
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
  const { t } = useTranslation();
  const { width, height = CHART_BODY_HEIGHT_PX, tooltip = <ChartTooltip /> } = props;

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
    return <PeriodTrendChart props={props} width={width} height={height} onClick={handleClick} />;
  }

  if (props.points.length === 0) {
    return null;
  }

  let chart: ReactElement;

  if (props.mode === 'event') {
    const eventPoints = props.points;
    const anchorKeys = eventPoints.map((point) => point.eventKey);
    const tickWidth = typeof width === 'number' ? width : EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH;
    const selectedTicks = selectEventTicks(anchorKeys, tickWidth);

    chart = (
      <LineChart
        {...(typeof width === 'number' ? { width, height } : {})}
        data={eventPoints}
        onClick={handleClick}
        accessibilityLayer
      >
        <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="eventKey"
          type="category"
          domain={anchorKeys}
          ticks={selectedTicks}
          interval={0}
          tickFormatter={(value: string) => formatEventTickLabel(value)}
          tick={{ fill: CHART_TOKENS.axisText, fontSize: CHART_AXIS_FONT_SIZE }}
        />
        <YAxis
          domain={[0, 100]}
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
            if (!point) {
              return <g />;
            }
            return (
              <text
                x={x}
                y={y - EVENT_POINT_LABEL_OFFSET_PX}
                textAnchor="middle"
                fill={CHART_TOKENS.axisText}
                fontSize={CHART_AXIS_FONT_SIZE}
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
    <ResponsiveContainer width="100%" height={height}>
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

function periodDotRadius(total: number): number {
  if (total >= 150) return PERIOD_DOT_RADIUS_LARGE;
  if (total >= 50) return PERIOD_DOT_RADIUS_MEDIUM;
  return PERIOD_DOT_RADIUS_SMALL;
}

/** UI-SPEC §7.13: 2px at `CHART_H_DEFAULT`, 1.5px at `CHART_H_COMPACT`. */
function periodLineStrokeWidth(height: number): number {
  return height <= CHART_H_COMPACT ? 1.5 : CHART_LINE_WIDTH;
}

/**
 * UI-SPEC §7.13/§11: direct value labels on the last, maximum and minimum
 * points only. Ties broken by keeping the FIRST (earlier) occurrence — only
 * updating on a STRICT `>`/`<` means a later point tying the current
 * max/min never displaces it.
 */
function findPeriodLabeledIndices(points: PeriodPoint[]): Set<number> {
  const lastIndex = points.length - 1;
  let maxIndex = 0;
  let minIndex = 0;
  points.forEach((point, i) => {
    const current = points[maxIndex]!;
    if (point.rate > current.rate) maxIndex = i;
    const currentMin = points[minIndex]!;
    if (point.rate < currentMin.rate) minIndex = i;
  });
  return new Set([lastIndex, maxIndex, minIndex]);
}

/** UI-SPEC §11: fitted to data ± 4pts, snapped to 10s, minimum span 20pts, clamped to [0, 100]. */
function computePeriodYDomain(points: PeriodPoint[]): [number, number] {
  const rates = points.map((point) => point.rate * 100);
  const dataMin = Math.min(...rates);
  const dataMax = Math.max(...rates);
  let lo = Math.max(0, Math.floor((dataMin - 4) / 10) * 10);
  let hi = Math.min(100, Math.ceil((dataMax + 4) / 10) * 10);
  if (hi - lo < 20) {
    hi = Math.min(100, lo + 20);
    if (hi - lo < 20) {
      lo = Math.max(0, hi - 20);
    }
  }
  return [lo, hi];
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

function periodDotRenderer(points: PeriodPoint[]) {
  return function renderDot(dotProps: unknown): ReactElement {
    const { cx, cy, index } = dotProps as { cx?: number; cy?: number; index?: number };
    if (typeof cx !== 'number' || typeof cy !== 'number' || typeof index !== 'number') {
      return <g />;
    }
    const point = points[index];
    if (!point) {
      return <g />;
    }
    const radius = periodDotRadius(point.total);
    if (point.subFloor) {
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
        />
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
      />
    );
  };
}

function periodLabelRenderer(points: PeriodPoint[], labeledIndices: Set<number>) {
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
    return (
      <text
        x={x}
        y={y - 12}
        textAnchor="middle"
        fill={CHART_TOKENS.axisText}
        fontSize={CHART_AXIS_FONT_SIZE}
        fontWeight={600}
        data-slot="trend-period-value-label"
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
 * both of which this axis needs (`formatPeriodTickLabel`, edge anchoring).
 * `firstKey`/`lastKey` are the SELECTED tick set's own first/last entries
 * (never the series' own first/last point) — with a narrow plot, the
 * selected set can be a strict subset that never includes the series' true
 * edges, and the anchor decision is about the rendered tick set, not the
 * data.
 */
function periodTickRenderer(points: PeriodPoint[], ticks: string[], locale: string) {
  const byKey = new Map(points.map((point) => [point.key, point]));
  const firstKey = ticks[0];
  const lastKey = ticks[ticks.length - 1];
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
    const point = byKey.get(value);
    if (!point) {
      return <g />;
    }
    const textAnchor = value === firstKey ? 'start' : value === lastKey ? 'end' : 'middle';
    return (
      <text
        x={x}
        y={y}
        dy="0.71em"
        textAnchor={textAnchor}
        className={className}
        fill={CHART_TOKENS.axisText}
        fontSize={CHART_AXIS_FONT_SIZE}
      >
        {formatPeriodTickLabel(point, locale)}
      </text>
    );
  };
}

interface PeriodChartRow {
  key: string;
  lineRatePercent: number | null;
  ratePercent: number;
  contextPercent?: number;
}

function buildPeriodChartData(
  points: PeriodPoint[],
  contextRatePercents?: number[],
): PeriodChartRow[] {
  return points.map((point, i) => ({
    key: point.key,
    lineRatePercent: point.subFloor ? null : point.rate * 100,
    ratePercent: point.rate * 100,
    contextPercent: contextRatePercents?.[i],
  }));
}

function renderPeriodLockedInset(props: TrendLinePeriodProps): ReactElement {
  const need = PERIOD_TREND_MIN_PERIODS;
  const have = props.points.length;
  const fillPercent = need > 0 ? Math.min(100, Math.round((have / need) * 100)) : 0;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-3"
      data-slot="trend-line-period-locked"
    >
      <p className="text-sm leading-5">{props.labels.lockedSentence}</p>
      <div
        role="img"
        aria-label={props.labels.lockedCountLabel}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${fillPercent}%`, backgroundColor: CHART_TOKENS.steady }}
        />
      </div>
      <p className="text-xs leading-4 text-muted-foreground tabular-nums">
        {props.labels.lockedCountLabel}
      </p>
    </div>
  );
}

function PeriodTableTwin({ props }: { props: TrendLinePeriodProps }): ReactElement {
  const [open, setOpen] = useState(false);
  const { i18n } = useTranslation();
  const { points, labels } = props;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="trend-line-period-table">
      <Button type="button" variant="link" size="sm" onClick={() => setOpen((o) => !o)}>
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
 * Used only to derive the initial plot-width estimate before
 * `ResponsiveContainer`'s first real `onResize` callback fires — mirrors
 * `EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH`'s own role for event mode; the
 * runtime page render is still governed by the actual measured width the
 * moment it's available.
 */
const PERIOD_TICKS_RESPONSIVE_FALLBACK_WIDTH = EVENT_TICKS_RESPONSIVE_FALLBACK_WIDTH;

/**
 * Period mode's entire render tree (VIZ-01, VIZ-03, UI-SPEC §7.13) — a real
 * component (not a plain function call), because `selectPeriodTicks` needs
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

  if (points.length < PERIOD_TREND_MIN_PERIODS) {
    return (
      <>
        {renderPeriodLockedInset(props)}
        <PeriodTableTwin props={props} />
      </>
    );
  }

  const containerWidth = typeof width === 'number' ? width : measuredWidth;
  const plotWidthPx = Math.max(
    0,
    containerWidth - PERIOD_Y_AXIS_WIDTH_PX - PERIOD_X_AXIS_PADDING_PX * 2,
  );

  const data = buildPeriodChartData(points, props.contextRatePercents);
  const labeledIndices = findPeriodLabeledIndices(points);
  const [yMin, yMax] = computePeriodYDomain(points);
  const ticks = selectPeriodTicks(points, { plotWidthPx, locale });
  const emphasisStartKey =
    props.emphasisStartMs !== undefined
      ? findEmphasisStartKey(points, props.emphasisStartMs)
      : undefined;
  const lastKey = points[points.length - 1]!.key;
  const lineStrokeWidth = periodLineStrokeWidth(height);

  const chart = (
    <LineChart
      {...(typeof width === 'number' ? { width, height } : {})}
      data={data}
      onClick={onClick}
      accessibilityLayer
    >
      <CartesianGrid stroke={CHART_TOKENS.grid} />
      <XAxis
        dataKey="key"
        type="category"
        domain={points.map((point) => point.key)}
        ticks={ticks}
        interval={0}
        padding={{ left: PERIOD_X_AXIS_PADDING_PX, right: PERIOD_X_AXIS_PADDING_PX }}
        tick={periodTickRenderer(points, ticks, locale)}
      />
      <YAxis
        domain={[yMin, yMax]}
        width={PERIOD_Y_AXIS_WIDTH_PX}
        padding={{ top: 24, bottom: 16 }}
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
            props.labels.referenceLabel
              ? { value: props.labels.referenceLabel, position: 'insideTopRight' }
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
        />
      )}
      {props.contextRatePercents && (
        <Line
          type="stepAfter"
          dataKey="contextPercent"
          stroke={CHART_TOKENS.deemphasis}
          strokeWidth={1}
          dot={false}
          isAnimationActive={false}
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
        dataKey="ratePercent"
        stroke="none"
        dot={periodDotRenderer(points)}
        label={periodLabelRenderer(points, labeledIndices)}
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

  return (
    <>
      {plot}
      <PeriodTableTwin props={props} />
    </>
  );
}
