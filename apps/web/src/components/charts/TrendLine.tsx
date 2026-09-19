import { useCallback } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip } from 'recharts';
import { XAxis, YAxis, type MouseHandlerDataParam } from 'recharts';
import {
  CHART_AXIS_FONT_SIZE,
  CHART_BODY_HEIGHT_PX,
  CHART_DOT_RADIUS,
  CHART_LINE_WIDTH,
  CHART_TOKENS,
} from './tokens';
import { ChartTooltip } from './ChartTooltip';
import { formatEventTickLabel, selectEventTicks } from './eventTicks';

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
export type TrendLineProps = TrendLineIndexProps | TrendLineEventProps;

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
      } else {
        const point = props.points[index];
        if (point) {
          props.onSelectPoint(point);
        }
      }
    },
    [props],
  );

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
