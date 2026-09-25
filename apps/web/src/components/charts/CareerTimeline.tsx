import { useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area,
  ComposedChart,
  DefaultZIndexes,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  ZIndexLayer,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from 'recharts';
import type {
  CareerRatingPoint,
  CareerStripSet,
  CareerTimeline as CareerTimelineData,
} from '@smash-tracker/shared';
import { CHART_AXIS_FONT_SIZE, CHART_DOT_RADIUS, CHART_LINE_WIDTH, CHART_TOKENS } from './tokens';
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
  careerTimelineYDomain,
  type CareerTimelineGeometry,
  type CareerTimelineYDomain,
} from './careerTimelineLayout';
import { TIME_AXIS_LABEL_OFFSET_PX, selectTimeAxisTicks } from './timeAxisTicks';

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
  /** The last close's value ("1734"). */
  value: (rating: number) => string;
  /** The last close's RD sublabel ("±72"). */
  rd: (rd: number) => string;
  /** Calendar grains: the peak / low close labels ("1970 · peak close"). */
  peakClose: (rating: number) => string;
  lowClose: (rating: number) => string;
  /** Session grain: the peak / low labels ("1970 · peak"). */
  peak: (rating: number) => string;
  low: (rating: number) => string;
  /** The recent-window band's label — the active horizon's short name. */
  band?: string;
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

/** Sketch 002-C: the per-session dot radius on a session-grain (thin) line. */
const SESSION_DOT_RADIUS = 2.5;
/** Sketch 002-C: the surface ring around a labelled dot. */
const DOT_RING_WIDTH = 2;
/** Sketch 002-C: the last close's value sits 9px right of its dot, its ±RD 14px under it. */
const LAST_LABEL_DX = 9;
const LAST_LABEL_DY = 4;
const LAST_RD_DY = 18;
/** Sketch 002-C: the peak label 11px above its dot, the low label 20px below. */
const PEAK_LABEL_DY = -11;
const LOW_LABEL_DY = 20;
/** Sketch 002-C: a centred peak / low label is kept 34px inside the plot's edges. */
const CENTRED_LABEL_EDGE_PX = 34;
/** Sketch 002-C: y tick labels sit 4px under their hairline. */
const Y_LABEL_DY = 4;
/** Sketch 002-C: the recent-window band is never narrower than 6px; its label sits 7px above the plot. */
const BAND_MIN_WIDTH_PX = 6;
const BAND_LABEL_DY = -7;
const BAND_OPACITY = 0.14;
const BAND_EDGE_OPACITY = 0.5;
/** UI-SPEC §12.1: the RD band is a 10%-opacity fill, not two legend series. */
const RD_BAND_OPACITY = 0.1;
/** Sketch 002-C: x tick labels sit 8px above the SVG's bottom edge. */
const X_LABEL_BOTTOM_PX = 8;
/** Strip row labels' baseline inside their 15px row. */
const ROW_LABEL_BASELINE_PX = 12;
/**
 * Sketch 002-C's `.plot svg{overflow:visible}`: the row labels, y tick labels
 * and the last close's value are drawn in the chart's own margins and may run
 * a few px past the surface edge (into the card padding) — an HTML-embedded
 * SVG clips by default, which cut "games" to "ames".
 */
const SURFACE_OVERFLOW_CLASSES = '[&_.recharts-surface]:overflow-visible';

interface TimelineRow {
  key: string;
  closeMs: number;
  rating: number | null;
  band: [number, number] | null;
}

/**
 * One row per rating close; a gap row (null rating, midway between two
 * closes) wherever the engine marks `gapBefore`, so the line and RD band
 * break across a calendar period with no games (UI-SPEC §12.1).
 */
function buildRows(points: CareerRatingPoint[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  points.forEach((point, i) => {
    if (point.gapBefore && i > 0) {
      rows.push({
        key: `gap:${point.key}`,
        closeMs: (points[i - 1]!.closeMs + point.closeMs) / 2,
        rating: null,
        band: null,
      });
    }
    rows.push({
      key: point.key,
      closeMs: point.closeMs,
      rating: point.rating,
      band: [point.rating - point.rd, point.rating + point.rd],
    });
  });
  return rows;
}

/**
 * One anchor per rating close, at the line's OWN x scale — the markers the
 * layout oracle measures the time axis from. Transparent, never a pointer
 * target; a gap row emits nothing, so anchors always equal the points.
 */
function renderAnchor(props: { cx?: number; cy?: number; payload?: TimelineRow; index?: number }) {
  const { cx, cy, payload, index } = props;
  if (payload == null || payload.rating == null || cx == null || cy == null) {
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

interface LayerProps {
  timeline: CareerTimelineData;
  strips: CareerStripSet | null;
  labels: CareerTimelineLabels;
  geometry: CareerTimelineGeometry;
  yDomain: CareerTimelineYDomain;
  locale: string;
}

/**
 * Under the RD band and the line (sketch 002-C's first group): y hairlines
 * and labels, the time axis's gridlines (through the strips) and labels, the
 * plot baseline and the recent-window band — every x from the chart's own
 * hidden numeric XAxis scale.
 */
function UnderLayer({ timeline, labels, geometry, yDomain, locale }: LayerProps) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  if (!xScale || !yScale || !plot || !timeline.domain) return null;
  const x0 = plot.x;
  const x1 = plot.x + plot.width;
  const y0 = plot.y;
  const y1 = plot.y + plot.height;
  const stripBottom = y1 + geometry.stripBand;
  const ticks = selectTimeAxisTicks({
    startMs: timeline.domain.startMs,
    endMs: timeline.domain.endMs,
    plotWidthPx: plot.width,
    locale,
  });

  let band: ReactElement | null = null;
  const recent = timeline.recentWindow;
  if (recent && recent.fromMs !== null && recent.toMs !== null) {
    const from = xScale(Math.max(timeline.domain.startMs, recent.fromMs));
    const to = xScale(Math.min(timeline.domain.endMs, recent.toMs));
    if (from != null && to != null) {
      const right = Math.min(x1, to);
      const left = right - from < BAND_MIN_WIDTH_PX ? right - BAND_MIN_WIDTH_PX : from;
      band = (
        <g data-slot="career-timeline-recent-band">
          <rect
            x={left}
            y={y0}
            width={right - left}
            height={stripBottom - y0}
            fill={CHART_TOKENS.deemphasis}
            opacity={BAND_OPACITY}
          />
          <line
            x1={left}
            x2={left}
            y1={y0}
            y2={stripBottom}
            stroke={CHART_TOKENS.deemphasis}
            strokeWidth={1}
            opacity={BAND_EDGE_OPACITY}
          />
          {labels.band && (
            <text
              x={right}
              y={y0 + BAND_LABEL_DY}
              textAnchor="end"
              fontSize={CHART_AXIS_FONT_SIZE}
              fill={CHART_TOKENS.axisText}
            >
              {labels.band}
            </text>
          )}
        </g>
      );
    }
  }

  return (
    <g data-slot="career-timeline-under-layer">
      {yDomain.ticks.map((value) => {
        const y = yScale(value);
        if (y == null) return null;
        return (
          <g key={`y-${value}`}>
            <line x1={x0} x2={x1} y1={y} y2={y} stroke={CHART_TOKENS.grid} strokeWidth={1} />
            <text
              data-slot="career-timeline-tick-label"
              data-axis="y"
              x={x0 - CAREER_TIMELINE_LABEL_GAP_PX}
              y={y + Y_LABEL_DY}
              textAnchor="end"
              fontSize={CHART_AXIS_FONT_SIZE}
              fill={CHART_TOKENS.axisText}
              className="tabular-nums"
            >
              {value}
            </text>
          </g>
        );
      })}
      {ticks.gridlines.map((ms) => {
        const x = xScale(ms);
        if (x == null) return null;
        return (
          <line
            key={`grid-${ms}`}
            data-slot="career-timeline-gridline"
            x1={x}
            x2={x}
            y1={y0}
            y2={stripBottom}
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
            key={`x-${label.ms}`}
            data-slot="career-timeline-tick-label"
            data-axis="x"
            x={x + TIME_AXIS_LABEL_OFFSET_PX}
            y={geometry.height - X_LABEL_BOTTOM_PX}
            fontSize={CHART_AXIS_FONT_SIZE}
            fill={CHART_TOKENS.axisText}
            className="tabular-nums"
          >
            {label.text}
          </text>
        );
      })}
      <line
        x1={x0}
        x2={x1}
        y1={y1}
        y2={y1}
        stroke={CHART_TOKENS.deemphasisStrong}
        strokeWidth={1}
      />
      {band}
    </g>
  );
}

/**
 * UI-SPEC §12.1's shared time axis, by construction: the plot-area marker and
 * the two strips are drawn INSIDE the chart from the same hidden numeric XAxis
 * scale the rating line uses (`useXAxisScale`) and the chart's own plot area
 * (`usePlotArea`) — the strips are never a second layout.
 */
function StripsLayer({ strips, labels }: LayerProps): ReactElement | null {
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
            y={rateTop + ROW_LABEL_BASELINE_PX}
            textAnchor="end"
            fontSize={CHART_AXIS_FONT_SIZE}
            fill={CHART_TOKENS.axisText}
          >
            {labels.rate}
          </text>
          <text
            x={x0 - CAREER_TIMELINE_LABEL_GAP_PX}
            y={gamesTop + ROW_LABEL_BASELINE_PX}
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

/** A direct label whose value part is emphasised and whose suffix is muted (sketch 002-C `.lab` + tspan). */
function LabelText({
  x,
  y,
  anchor,
  text,
  value,
}: {
  x: number;
  y: number;
  anchor: 'start' | 'middle';
  text: string;
  value: string;
}): ReactElement {
  const at = text.indexOf(value);
  const before = at >= 0 ? text.slice(0, at) : '';
  const emphasised = at >= 0 ? value : text;
  const after = at >= 0 ? text.slice(at + value.length) : '';
  return (
    <text
      data-slot="career-timeline-direct-label"
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={CHART_AXIS_FONT_SIZE}
      className="fill-foreground font-semibold tabular-nums"
    >
      {before && <tspan className="fill-muted-foreground font-normal">{before}</tspan>}
      {emphasised}
      {after && <tspan className="fill-muted-foreground font-normal">{after}</tspan>}
    </text>
  );
}

/**
 * Over the line (sketch 002-C's `labs`): the visible dots — last / peak / low
 * on a calendar grain, every close on a session-grain (thin) line — and the
 * direct labels, from the same x / y scales.
 */
function TopLayer({ timeline, labels, geometry }: LayerProps) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  if (!xScale || !yScale || !plot) return null;
  const { points, grain, lastIndex, peakIndex, lowIndex } = timeline.rating;
  const sessionGrain = grain === 'session';
  const x0 = plot.x;
  const x1 = plot.x + plot.width;
  const position = (point: CareerRatingPoint) => {
    const x = xScale(point.closeMs);
    const y = yScale(point.rating);
    return x == null || y == null ? null : { x, y };
  };
  const clampX = (x: number) =>
    Math.max(x0 + CENTRED_LABEL_EDGE_PX, Math.min(x1 - CENTRED_LABEL_EDGE_PX, x));
  const labelled = new Set([lastIndex, peakIndex, lowIndex].filter((i): i is number => i !== null));
  const dotIndices = sessionGrain ? points.map((_, i) => i) : [...labelled].sort((a, b) => a - b);

  const last = lastIndex !== null ? points[lastIndex]! : null;
  const lastAt = last ? position(last) : null;
  const peak = peakIndex !== null ? points[peakIndex]! : null;
  const peakAt = peak ? position(peak) : null;
  const low = lowIndex !== null ? points[lowIndex]! : null;
  const lowAt = low ? position(low) : null;

  return (
    <g data-slot="career-timeline-top-layer">
      {dotIndices.map((i) => {
        const at = position(points[i]!);
        if (!at) return null;
        const isLabelled = labelled.has(i);
        return (
          <circle
            key={points[i]!.key}
            data-slot="career-timeline-dot"
            cx={at.x}
            cy={at.y}
            r={isLabelled ? CHART_DOT_RADIUS : SESSION_DOT_RADIUS}
            fill={CHART_TOKENS.series1}
            stroke={isLabelled ? CHART_TOKENS.surface : 'none'}
            strokeWidth={isLabelled ? DOT_RING_WIDTH : 0}
          />
        );
      })}
      {last && lastAt && (
        <>
          <LabelText
            x={lastAt.x + LAST_LABEL_DX}
            y={lastAt.y + LAST_LABEL_DY}
            anchor="start"
            text={labels.value(last.rating)}
            value={labels.value(last.rating)}
          />
          {!geometry.narrow && (
            <text
              data-slot="career-timeline-direct-label"
              x={lastAt.x + LAST_LABEL_DX}
              y={lastAt.y + LAST_RD_DY}
              fontSize={CHART_AXIS_FONT_SIZE}
              fill={CHART_TOKENS.axisText}
              className="tabular-nums"
            >
              {labels.rd(last.rd)}
            </text>
          )}
        </>
      )}
      {peak && peakAt && (
        <LabelText
          x={clampX(peakAt.x)}
          y={peakAt.y + PEAK_LABEL_DY}
          anchor="middle"
          text={sessionGrain ? labels.peak(peak.rating) : labels.peakClose(peak.rating)}
          value={labels.value(peak.rating)}
        />
      )}
      {low && lowAt && (
        <LabelText
          x={clampX(lowAt.x)}
          y={lowAt.y + LOW_LABEL_DY}
          anchor="middle"
          text={sessionGrain ? labels.low(low.rating) : labels.lowClose(low.rating)}
          value={labels.value(low.rating)}
        />
      )}
    </g>
  );
}

/**
 * The Trends career timeline (plan 39.1-34, owner decision 2026-09-25, D-13,
 * UI-SPEC §12.1 — the binding visual is sketch 002-C's `drawRating`): a
 * close-of-period rating line with its RD as a 10% band over ONE numeric time
 * axis, with the month-resolution rate-vs-own-baseline and games strips drawn
 * under the plot by the chart's own x scale; year gridlines run through plot
 * and strips; only last / peak / low are dotted and direct-labelled; the
 * recent window is a neutral band. Reads only the engine's `CareerTimeline` —
 * the chart never bins; below a 520px plot it switches to the engine's
 * narrow (quarter) strip set, a 170px plot bottom and 200-point hairlines.
 */
export function CareerTimeline({ timeline, labels, width }: CareerTimelineProps): ReactElement {
  const { i18n } = useTranslation();
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
  const yDomain = careerTimelineYDomain(points, { narrow });
  const layerProps: LayerProps = {
    timeline,
    strips,
    labels,
    geometry,
    yDomain,
    locale: i18n.language,
  };

  const chart = (
    <ComposedChart
      {...(typeof width === 'number' ? { width, height: geometry.height } : {})}
      data={buildRows(points)}
      margin={{
        top: geometry.marginTop,
        right: geometry.marginRight,
        bottom: geometry.height - geometry.plotBottom,
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
      <YAxis
        type="number"
        scale="linear"
        domain={[yDomain.lo, yDomain.hi]}
        allowDataOverflow
        hide
      />
      <ZIndexLayer zIndex={DefaultZIndexes.grid}>
        <UnderLayer {...layerProps} />
      </ZIndexLayer>
      <Area
        type="linear"
        dataKey="band"
        stroke="none"
        fill={CHART_TOKENS.series1}
        fillOpacity={RD_BAND_OPACITY}
        connectNulls={false}
        dot={false}
        activeDot={false}
        isAnimationActive={false}
      />
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
      <StripsLayer {...layerProps} />
      <ZIndexLayer zIndex={DefaultZIndexes.label}>
        <TopLayer {...layerProps} />
      </ZIndexLayer>
    </ComposedChart>
  );

  return (
    <div
      data-slot="career-timeline"
      data-state={timeline.state}
      role="img"
      aria-label={labels.aria}
      className={SURFACE_OVERFLOW_CLASSES}
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
