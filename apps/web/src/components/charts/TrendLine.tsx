import { useCallback } from 'react';
import type { ReactElement } from 'react';
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

export interface TrendLineProps {
  points: TrendChartPoint[];
  onSelectPoint?: (point: TrendChartPoint) => void;
  /** D-04: explicit numeric size for tests; omitted at runtime for the responsive wrapper. */
  width?: number;
  height?: number;
  /** Tooltip content node, passed through to Recharts' `Tooltip`. Defaults to
   * the kit's shared `ChartTooltip` so every consumer gets the who/where/
   * when/score content without opting in (D-06). */
  tooltip?: ReactElement;
}

/**
 * The trend-with-context vocabulary member (D-05): a single-series line over
 * a fixed 0-100 win-rate domain. D-04: accepts an explicit numeric
 * `width`/`height` — when `width` is a number the chart renders directly at
 * that size (what every test uses, since jsdom's no-op ResizeObserver stub
 * plus a zero-size bounding rect make a `ResponsiveContainer` render measure
 * 0x0); when `width` is undefined the chart is wrapped in a
 * `ResponsiveContainer` (the runtime page render).
 */
export function TrendLine({
  points,
  onSelectPoint,
  width,
  height = CHART_BODY_HEIGHT_PX,
  tooltip = <ChartTooltip />,
}: TrendLineProps) {
  /**
   * The click surface is bound on the `LineChart` container, not on `Line` or
   * a `dot` (R1-MEDIUM-8): recharts 3.10.1's `MouseHandlerDataParam` (the
   * container-level `onClick` argument) carries no `activePayload` field —
   * that recharts-2-era field does not exist on this version's type, verified
   * against the installed package's `types/synchronisation/types.d.ts`. The
   * numeric `activeTooltipIndex` it DOES carry is a 1:1 index into the `data`
   * array this chart was given, which is exactly `points` — reading
   * `points[activeTooltipIndex]` recovers the clicked point without needing
   * an `activePayload` field at all. See the plan 37-01 SUMMARY for the full
   * observed-shape record.
   */
  const handleClick = useCallback(
    (state: MouseHandlerDataParam) => {
      if (!onSelectPoint) return;
      const rawIndex = state.activeTooltipIndex;
      const index = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
      const point = Number.isInteger(index) ? points[index] : undefined;
      if (point) {
        onSelectPoint(point);
      }
    },
    [onSelectPoint, points],
  );

  if (points.length === 0) {
    return null;
  }

  const chart = (
    <LineChart
      {...(typeof width === 'number' ? { width, height } : {})}
      data={points}
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

  if (typeof width === 'number') {
    return chart;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      {chart}
    </ResponsiveContainer>
  );
}
