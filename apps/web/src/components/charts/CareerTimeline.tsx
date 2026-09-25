import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  usePlotArea,
  useXAxisScale,
} from 'recharts';
import type { CareerStripSet, CareerTimeline as CareerTimelineData } from '@smash-tracker/shared';
import { CHART_AXIS_FONT_SIZE, CHART_LINE_WIDTH, CHART_TOKENS } from './tokens';
import {
  CAREER_TIMELINE_CELL_INSET_PX,
  CAREER_TIMELINE_CELL_RADIUS_PX,
  CAREER_TIMELINE_GAMES_ROW_OFFSET_PX,
  CAREER_TIMELINE_LABEL_GAP_PX,
  CAREER_TIMELINE_RATE_ROW_OFFSET_PX,
  CAREER_TIMELINE_STRIP_ROW_HEIGHT_PX,
  careerGamesFill,
  careerStripFill,
  careerTimelineGeometry,
  careerTimelineIsNarrow,
} from './careerTimelineLayout';

/** Every string the timeline draws — the chart never localises (its host passes them in). */
export interface CareerTimelineLabels {
  /** The rate strip's row label ("rate"). */
  rate: string;
  /** The games strip's row label ("games"). */
  games: string;
  /** The plot's `role="img"` summary. */
  aria: string;
  /** The locked state's sentence (below `CAREER_TIMELINE_MIN_GAMES`) — the host's abstention copy. */
  locked?: string;
}

export interface CareerTimelineProps {
  timeline: CareerTimelineData;
  labels: CareerTimelineLabels;
  /**
   * D-04 test affordance: an explicit container width in px. Omitted at
   * runtime — the chart then measures its own container
   * (`ResponsiveContainer`'s `onResize`), because Recharts renders 0x0 under
   * jsdom's ResponsiveContainer.
   */
  width?: number;
}

/** The container width assumed before `ResponsiveContainer`'s first measurement lands. */
const RESPONSIVE_FALLBACK_WIDTH = 1000;
/** Y-domain rounding step (UI-SPEC §12.1 "100-point gridlines"). */
const Y_DOMAIN_STEP = 100;

interface TimelineRow {
  key: string;
  closeMs: number;
  rating: number;
}

function fittedYDomain(timeline: CareerTimelineData): [number, number] {
  const points = timeline.rating.points;
  const lo = Math.min(...points.map((p) => p.rating - p.rd));
  const hi = Math.max(...points.map((p) => p.rating + p.rd));
  return [
    Math.floor(lo / Y_DOMAIN_STEP) * Y_DOMAIN_STEP,
    Math.ceil(hi / Y_DOMAIN_STEP) * Y_DOMAIN_STEP,
  ];
}

/**
 * One anchor per rating close, at the line's OWN x scale — the markers the
 * layout oracle measures the time axis from (transparent in Task 1's tracer;
 * never a pointer target).
 */
function renderAnchor(props: { cx?: number; cy?: number; payload?: TimelineRow; index?: number }) {
  const { cx, cy, payload, index } = props;
  if (payload == null || cx == null || cy == null) {
    return <g key={`anchor-empty-${index ?? 0}`} />;
  }
  return (
    <circle
      key={payload.key}
      data-slot="career-timeline-point"
      data-t={payload.closeMs}
      data-key={payload.key}
      cx={cx}
      cy={cy}
      r={2}
      fill="transparent"
      pointerEvents="none"
    />
  );
}

/**
 * UI-SPEC §12.1's shared time axis, by construction: drawn INSIDE the chart
 * from the same hidden numeric XAxis scale the rating line uses
 * (`useXAxisScale`) and the chart's own plot area (`usePlotArea`) — the
 * strips are never a second layout.
 */
function StripsLayer({
  strips,
  labels,
}: {
  strips: CareerStripSet | null;
  labels: CareerTimelineLabels;
}): ReactElement | null {
  const xScale = useXAxisScale();
  const plot = usePlotArea();
  if (!xScale || !plot) return null;
  const x0 = plot.x;
  const x1 = plot.x + plot.width;
  const plotBottom = plot.y + plot.height;
  const rateTop = plotBottom + CAREER_TIMELINE_RATE_ROW_OFFSET_PX;
  const gamesTop = plotBottom + CAREER_TIMELINE_GAMES_ROW_OFFSET_PX;
  return (
    <g data-slot="career-timeline-layer">
      <rect
        data-slot="career-timeline-plot-area"
        x={x0}
        y={plot.y}
        width={plot.width}
        height={plot.height}
        fill="transparent"
        pointerEvents="none"
      />
      {strips && (
        <g data-slot="career-timeline-strips" data-grain={strips.grain}>
          {strips.cells.map((cell) => {
            const start = xScale(cell.startMs);
            const end = xScale(cell.endMs);
            if (start == null || end == null) return null;
            const left = Math.max(x0, start) + CAREER_TIMELINE_CELL_INSET_PX;
            const right = Math.min(x1, end) - CAREER_TIMELINE_CELL_INSET_PX;
            const width = Math.max(0, right - left);
            const shared = {
              'data-start-ms': cell.startMs,
              'data-end-ms': cell.endMs,
              'data-wins': cell.wins,
              'data-losses': cell.losses,
              x: left,
              width,
              height: CAREER_TIMELINE_STRIP_ROW_HEIGHT_PX,
              rx: CAREER_TIMELINE_CELL_RADIUS_PX,
            };
            return (
              <g key={cell.key}>
                <rect
                  {...shared}
                  data-slot="career-timeline-rate-cell"
                  data-step={cell.rateStep}
                  y={rateTop}
                  fill={careerStripFill(cell.rateStep)}
                />
                <rect
                  {...shared}
                  data-slot="career-timeline-games-cell"
                  data-step={cell.gamesStep}
                  y={gamesTop}
                  fill={careerGamesFill(cell.gamesStep)}
                />
              </g>
            );
          })}
          <text
            x={x0 - CAREER_TIMELINE_LABEL_GAP_PX}
            y={rateTop + 12}
            textAnchor="end"
            fontSize={CHART_AXIS_FONT_SIZE}
            fill={CHART_TOKENS.axisText}
          >
            {labels.rate}
          </text>
          <text
            x={x0 - CAREER_TIMELINE_LABEL_GAP_PX}
            y={gamesTop + 12}
            textAnchor="end"
            fontSize={CHART_AXIS_FONT_SIZE}
            fill={CHART_TOKENS.axisText}
          >
            {labels.games}
          </text>
        </g>
      )}
    </g>
  );
}

/**
 * The Trends career timeline (plan 39.1-34, owner decision 2026-09-25, D-13,
 * UI-SPEC §12.1 — the binding visual is sketch 002-C's `drawRating`): a
 * close-of-period rating line over ONE numeric time axis, with the
 * month-resolution rate-vs-own-baseline and games strips drawn under the
 * plot by the chart's own x scale. Reads only the engine's
 * `CareerTimeline` — the chart never bins; below a 520px plot it switches
 * to the engine's narrow (quarter) strip set.
 */
export function CareerTimeline({ timeline, labels, width }: CareerTimelineProps): ReactElement {
  const [measuredWidth, setMeasuredWidth] = useState(RESPONSIVE_FALLBACK_WIDTH);

  const points = timeline.rating.points;
  if (timeline.state === 'locked' || points.length === 0 || timeline.domain === null) {
    return (
      <div data-slot="career-timeline" data-state={timeline.state}>
        {labels.locked && <p className="text-sm text-muted-foreground">{labels.locked}</p>}
      </div>
    );
  }

  const containerWidth = typeof width === 'number' ? width : measuredWidth;
  const narrow = careerTimelineIsNarrow(containerWidth);
  const strips =
    timeline.state === 'full' && timeline.strips
      ? narrow
        ? timeline.strips.narrow
        : timeline.strips.wide
      : null;
  const geometry = careerTimelineGeometry({ narrow, strips: strips !== null });
  const data: TimelineRow[] = points.map((point) => ({
    key: point.key,
    closeMs: point.closeMs,
    rating: point.rating,
  }));

  const chart = (
    <ComposedChart
      {...(typeof width === 'number' ? { width, height: geometry.height } : {})}
      data={data}
      margin={{
        top: geometry.marginTop,
        right: geometry.marginRight,
        bottom: geometry.stripBand + geometry.axisBand,
        left: geometry.marginLeft,
      }}
    >
      <XAxis
        type="number"
        dataKey="closeMs"
        scale="linear"
        domain={[timeline.domain.startMs, timeline.domain.endMs]}
        allowDataOverflow
        hide
      />
      <YAxis type="number" scale="linear" domain={fittedYDomain(timeline)} allowDataOverflow hide />
      <Line
        className="career-timeline-line"
        type="linear"
        dataKey="rating"
        stroke={CHART_TOKENS.series1}
        strokeWidth={CHART_LINE_WIDTH}
        strokeLinejoin="round"
        strokeLinecap="round"
        dot={renderAnchor}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
      <StripsLayer strips={strips} labels={labels} />
    </ComposedChart>
  );

  return (
    <div
      data-slot="career-timeline"
      data-state={timeline.state}
      role="img"
      aria-label={labels.aria}
    >
      {typeof width === 'number' ? (
        chart
      ) : (
        <ResponsiveContainer
          width="100%"
          height={geometry.height}
          onResize={(w) => setMeasuredWidth(w)}
        >
          {chart}
        </ResponsiveContainer>
      )}
    </div>
  );
}
