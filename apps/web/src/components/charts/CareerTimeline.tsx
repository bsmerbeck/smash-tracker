import { useLayoutEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';
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
import { CAREER_TIMELINE_MIN_GAMES } from '@smash-tracker/shared';
import type {
  CareerRatingPoint,
  CareerStripCell,
  CareerStripSet,
  CareerTimeline as CareerTimelineData,
  KnownTierWord,
  TierBasis,
} from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { CHART_AXIS_FONT_SIZE, CHART_DOT_RADIUS, CHART_LINE_WIDTH, CHART_TOKENS } from './tokens';
import {
  CAREER_TIMELINE_CELL_INSET_PX,
  CAREER_TIMELINE_CELL_RADIUS_PX,
  CAREER_TIMELINE_GAMES_ROW_OFFSET_PX,
  CAREER_TIMELINE_LABEL_GAP_PX,
  CAREER_TIMELINE_RATE_ROW_OFFSET_PX,
  CAREER_TIMELINE_READOUT_MAX_WIDTH_PX,
  CAREER_TIMELINE_STRIP_ROW_HEIGHT_PX,
  careerGamesFill,
  careerStripFill,
  careerTimelineGeometry,
  careerTimelineIsNarrow,
  careerTimelineYDomain,
  clampReadoutLeft,
  type CareerTimelineGeometry,
  type CareerTimelineYDomain,
} from './careerTimelineLayout';
import { TIME_AXIS_LABEL_OFFSET_PX, selectTimeAxisTicks } from './timeAxisTicks';

/**
 * A major event on the plot baseline (UI-SPEC §12.1). Which events qualify is
 * the host's call (plan 41-04: resolved tier >= major); the kit only draws.
 * `basis` decides the form (12.6 anti-masquerade): an `estimated` tier is a
 * hollow diamond, a `recorded` / `manual` one is filled — `tier` is never a hue
 * or a size, only the host's readout words.
 */
export interface CareerTimelineEventMarker {
  key: string;
  label: string;
  /** When the event ended — its x on the time axis. */
  atMs: number;
  wins: number;
  losses: number;
  /** The resolved tier word (readout only — supermajor and major share one shape). */
  tier: KnownTierWord;
  /** How the tier was established; `estimated` draws hollow. */
  basis: TierBasis;
  /** The rating after the event, or null when no plotted rating sits at or after it. */
  ratingAfter: number | null;
}

/** One calendar month's record (UTC), for the table twin's year x month table. */
export interface CareerTimelineMonthRecord {
  year: number;
  /** 0..11. */
  month: number;
  wins: number;
  losses: number;
  total: number;
}

/** What the one readout describes: a rating close (plot band), a strip cell (strip band) or an event diamond. */
export type CareerTimelineReadoutTarget =
  | { kind: 'point'; point: CareerRatingPoint }
  | { kind: 'cell'; cell: CareerStripCell }
  | { kind: 'event'; marker: CareerTimelineEventMarker };

/** The table twin's strings (UI-SPEC §14.4) — every value formatted by the host. */
export interface CareerTimelineTableLabels {
  /** The "View as table" toggle. */
  toggle: string;
  ratingCaption: string;
  monthCaption: string;
  headers: {
    period: string;
    rating: string;
    rd: string;
    record: string;
    rate: string;
    games: string;
    year: string;
    total: string;
  };
  /** Twelve short month names, January first. */
  months: readonly string[];
  period: (point: CareerRatingPoint) => string;
  rd: (rd: number) => string;
  record: (wins: number, losses: number) => string;
  rate: (rate: number) => string;
  /** A month cell: "<rate> · <n>". */
  monthCell: (cell: { rate: number; total: number }) => string;
  /** A year's total: "<W>–<L> · <rate>". */
  yearTotal: (row: { wins: number; losses: number; total: number; rate: number }) => string;
}

/** The readout's content — a title and its lines, every string composed by the host. */
export interface CareerTimelineReadout {
  title: string;
  lines: string[];
}

/** An inclusive drill window in epoch ms — Phase 38's `from` / `to` axes (UI-SPEC §10.3). */
export interface CareerTimelineSelection {
  fromMs: number;
  toMs: number;
}

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
  /** The locked meter's `role="img"` label ("3 of 5 games"). */
  lockedCount?: string;
  /** An event diamond's accessible name. */
  eventAria?: (marker: CareerTimelineEventMarker) => string;
  /** The table twin's strings — omitted: no twin. */
  table?: CareerTimelineTableLabels;
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
  /** The one readout's title and lines for a target (UI-SPEC §10.2 order) — the kit composes nothing itself. */
  readout: (target: CareerTimelineReadoutTarget) => CareerTimelineReadout;
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
  /**
   * UI-SPEC §10.3 / §12.1: a period or strip cell was clicked (mouse / pen),
   * Entered (keyboard) or tapped twice (touch) — the host writes the
   * inclusive window as the `from` / `to` drill axes. Omitted: nothing drills.
   */
  onSelectPeriod?: (selection: CareerTimelineSelection) => void;
  /**
   * D-07 / sketch 002-C: the thin account's per-game strip (the host's
   * `FormStrip`), rendered under the plot in place of the month strips —
   * only while the timeline is `thin`.
   */
  thinStrip?: ReactNode;
  /** The table twin's year x month records (the host bins them by the engine's UTC calendar rule). */
  monthRecords?: readonly CareerTimelineMonthRecord[];
  /**
   * UI-SPEC §12.1 major-event diamonds. The Trends host passes none until
   * Phase 39.2 supplies tier data (owner decision 2026-09-25).
   */
  eventMarkers?: readonly CareerTimelineEventMarker[];
  onSelectEventMarker?: (key: string) => void;
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
/** Sketch 002-C `#cx`: the crosshair's active dot. */
const CROSSHAIR_DOT_RADIUS = 4.5;
/** Phase 38's focus-ring recipe (UI-SPEC §10.1). */
const PLOT_FOCUS_CLASSES =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
/** `ChartTooltip`'s own surface (UI-SPEC §10.2: max 280px, meta size, tabular). */
const READOUT_CLASSES =
  'pointer-events-none absolute z-10 w-max max-w-[min(280px,100%)] rounded-md border border-border bg-card p-2 text-xs tabular-nums';

/** Sketch 002-C: the event diamond's half-diagonal (an 11px diamond), its surface stroke and its 24px hit box (UI-SPEC §14.6). */
const DIAMOND_HALF_PX = 5.5;
const DIAMOND_STROKE_PX = 1.5;
const DIAMOND_HIT_PX = 24;
/** The table twin's cells (sketch 002 `table.twin`), with its phone stacked-row rule below 640px. */
const TWIN_TABLE_CLASSES = 'w-full border-collapse text-xs leading-4 tabular-nums';
const TWIN_HEAD_CELL_CLASSES =
  'border-b border-border px-1.5 py-1.5 text-right text-[0.6875rem] font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase first:text-left';
const TWIN_CELL_CLASSES =
  'border-b border-border px-1.5 py-1.5 text-right whitespace-nowrap first:text-left';
const TWIN_STACKED_ROW_CLASSES =
  'max-sm:flex max-sm:flex-wrap max-sm:gap-x-2.5 max-sm:gap-y-0.5 max-sm:border-b max-sm:border-border max-sm:py-2';
const TWIN_STACKED_CELL_CLASSES = 'max-sm:border-0 max-sm:p-0';
const TWIN_STACKED_MONTH_CLASSES =
  'max-sm:before:mr-1 max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-m)]';

/** The readout's target — a rating close, a strip cell of the strip set currently drawn, or an event marker. */
type ActiveTarget =
  | { kind: 'point'; index: number }
  | { kind: 'cell'; index: number }
  | { kind: 'event'; index: number };

/**
 * Who showed the readout: a fine pointer hovering, the keyboard stepping (the
 * only source mirrored into the polite live region) or a first touch tap
 * (armed — a second tap on the same target drills).
 */
type ActiveSource = 'pointer' | 'keyboard' | 'touch';

interface ActiveState {
  target: ActiveTarget;
  source: ActiveSource;
}

function sameTarget(a: ActiveTarget, b: ActiveTarget): boolean {
  return a.kind === b.kind && a.index === b.index;
}

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

interface InteractionLayerProps extends LayerProps {
  active: ActiveTarget | null;
  selectable: boolean;
  /** A fine pointer moved over the hit rect (`null`: over nothing locatable). */
  onHover: (target: ActiveTarget | null) => void;
  /** A fine pointer left the hit rect. */
  onLeave: () => void;
  /** A click / tap landed on a target; `touch` says it came from a finger. */
  onPress: (target: ActiveTarget, touch: boolean) => void;
}

/**
 * The TOP layer (plan 39.1-35, UI-SPEC §10.1 / §12.1, sketch 002-C `#cx` +
 * `.hit` + `locate()`): ONE crosshair through the plot and both strips, a
 * dot at the active rating close, and a transparent hit rect over plot +
 * strip band. A pointer above the plot bottom snaps to the nearest close by
 * x; inside the strip band it takes the cell under it (falling back to the
 * nearest close in a month with no cell). Every x is the chart's own scale.
 */
function InteractionLayer({
  timeline,
  strips,
  geometry,
  active,
  selectable,
  onHover,
  onLeave,
  onPress,
}: InteractionLayerProps): ReactElement | null {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  // The pointerType of the press that precedes a click — a React click is a
  // MouseEvent in some engines, so the pointerdown is the reliable source.
  const pressTypeRef = useRef<string | null>(null);
  if (!xScale || !yScale || !plot) return null;
  const points = timeline.rating.points;
  const x0 = plot.x;
  const x1 = plot.x + plot.width;
  const y0 = plot.y;
  const plotBottom = plot.y + plot.height;
  const bandBottom = plotBottom + geometry.stripBand;

  const cellSpan = (cell: CareerStripCell): [number, number] | null => {
    const start = xScale(cell.startMs);
    const end = xScale(cell.endMs);
    if (start == null || end == null) return null;
    return [Math.max(x0, start), Math.min(x1, end)];
  };

  function locate(x: number, y: number): ActiveTarget | null {
    if (strips && y > plotBottom) {
      const index = strips.cells.findIndex((cell) => {
        const span = cellSpan(cell);
        return span !== null && x >= span[0] && x < span[1];
      });
      if (index >= 0) return { kind: 'cell', index };
    }
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    points.forEach((point, i) => {
      const px = xScale!(point.closeMs);
      if (px == null) return;
      const distance = Math.abs(px - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best >= 0 ? { kind: 'point', index: best } : null;
  }

  function locateEvent(event: ReactPointerEvent<SVGRectElement> | ReactMouseEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    const rect = svg ? svg.getBoundingClientRect() : { left: 0, top: 0 };
    return locate(event.clientX - rect.left, event.clientY - rect.top);
  }

  let crosshairX: number | null = null;
  let dotPoint: CareerRatingPoint | null = null;
  if (active?.kind === 'point') {
    const point = points[active.index];
    if (point) {
      crosshairX = xScale(point.closeMs) ?? null;
      dotPoint = point;
    }
  } else if (active?.kind === 'cell' && strips) {
    const cell = strips.cells[active.index];
    const span = cell ? cellSpan(cell) : null;
    if (cell && span) {
      crosshairX = (span[0] + span[1]) / 2;
      const inForce = cell.ratingAtClose?.key;
      dotPoint = inForce ? (points.find((point) => point.key === inForce) ?? null) : null;
    }
  }
  const dotX = dotPoint ? xScale(dotPoint.closeMs) : undefined;
  const dotY = dotPoint ? yScale(dotPoint.rating) : undefined;

  return (
    <g data-slot="career-timeline-interaction-layer">
      {crosshairX !== null && (
        <g pointerEvents="none">
          <line
            data-slot="career-timeline-crosshair"
            x1={crosshairX}
            x2={crosshairX}
            y1={y0}
            y2={bandBottom}
            stroke={CHART_TOKENS.deemphasisStrong}
            strokeWidth={1}
          />
          {dotX != null && dotY != null && (
            <circle
              data-slot="career-timeline-crosshair-dot"
              cx={dotX}
              cy={dotY}
              r={CROSSHAIR_DOT_RADIUS}
              fill={CHART_TOKENS.series1}
              stroke={CHART_TOKENS.surface}
              strokeWidth={DOT_RING_WIDTH}
            />
          )}
        </g>
      )}
      <rect
        data-slot="career-timeline-hit"
        x={x0}
        y={y0}
        width={x1 - x0}
        height={bandBottom - y0}
        fill="transparent"
        style={selectable ? { cursor: 'pointer' } : undefined}
        onPointerDown={(event) => {
          pressTypeRef.current = event.pointerType || null;
        }}
        onPointerMove={(event) => {
          // A finger dragging over the plot scrolls the page; only fine
          // pointers hover (the touch rule is tap-to-read, tap-again-to-drill).
          if (event.pointerType === 'touch') return;
          onHover(locateEvent(event));
        }}
        onPointerLeave={(event) => {
          // Every lifted finger fires a pointerleave — it must not hide a
          // tapped readout.
          if (event.pointerType === 'touch') return;
          onLeave();
        }}
        onClick={(event) => {
          const touch = pressTypeRef.current === 'touch';
          pressTypeRef.current = null;
          const target = locateEvent(event);
          if (target) onPress(target, touch);
        }}
      />
    </g>
  );
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
 * D-07 / UI-SPEC §12.1 (the TrendLine locked-inset precedent): below
 * `CAREER_TIMELINE_MIN_GAMES` the timeline is a designed L2 inset — the
 * host's sentence and a meter of the games so far — never an empty frame.
 */
function LockedInset({
  timeline,
  labels,
}: {
  timeline: CareerTimelineData;
  labels: CareerTimelineLabels;
}): ReactElement {
  const have = Math.max(0, CAREER_TIMELINE_MIN_GAMES - timeline.gamesNeeded);
  const fillPercent = Math.min(100, Math.round((have / CAREER_TIMELINE_MIN_GAMES) * 100));
  return (
    <div
      data-slot="career-timeline-locked"
      className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-3"
    >
      {labels.locked && <p className="text-sm leading-5">{labels.locked}</p>}
      <div
        role="img"
        aria-label={labels.lockedCount}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${fillPercent}%`, backgroundColor: CHART_TOKENS.steady }}
        />
      </div>
      {labels.lockedCount && (
        <p className="text-xs leading-4 text-muted-foreground tabular-nums">{labels.lockedCount}</p>
      )}
    </div>
  );
}

interface YearRow {
  year: number;
  months: (CareerTimelineMonthRecord | null)[];
  wins: number;
  losses: number;
  total: number;
}

/** Years newest first (sketch 002 `years()`), every year between the first and the last — a year with no games reads "—" throughout. */
function yearRows(records: readonly CareerTimelineMonthRecord[]): YearRow[] {
  if (records.length === 0) return [];
  const years = records.map((r) => r.year);
  const newest = Math.max(...years);
  const oldest = Math.min(...years);
  const rows: YearRow[] = [];
  for (let year = newest; year >= oldest; year -= 1) {
    const months: (CareerTimelineMonthRecord | null)[] = Array.from({ length: 12 }, () => null);
    let wins = 0;
    let losses = 0;
    for (const record of records) {
      if (record.year !== year) continue;
      months[record.month] = record;
      wins += record.wins;
      losses += record.losses;
    }
    rows.push({ year, months, wins, losses, total: wins + losses });
  }
  return rows;
}

/**
 * UI-SPEC §14.4 table twin (sketch 002 `HeatTable`): "View as table" opens a
 * rating-close table (period · rating · ±RD · W–L · rate · games) and a
 * year x month table (rate · n per month, a year total), with scoped headers;
 * below 640px the month table stacks each year as one wrapped row whose
 * cells carry their month name (sketch 002's phone twin rule). Every value a
 * tooltip shows is reachable here without hover.
 */
function TableTwin({
  points,
  monthRecords,
  table,
}: {
  points: readonly CareerRatingPoint[];
  monthRecords: readonly CareerTimelineMonthRecord[];
  table: CareerTimelineTableLabels;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rows = yearRows(monthRecords);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Sketch 002's `.btn`: a neutral bordered button — never brand-red link ink (plan 39.1-35 fidelity). */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 font-normal"
        data-slot="career-timeline-table-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {table.toggle}
      </Button>
      <CollapsibleContent>
        <div data-slot="career-timeline-table" className="flex flex-col gap-4">
          <table className={TWIN_TABLE_CLASSES}>
            <caption className="sr-only">{table.ratingCaption}</caption>
            <thead>
              <tr>
                {[
                  table.headers.period,
                  table.headers.rating,
                  table.headers.rd,
                  table.headers.record,
                  table.headers.rate,
                  table.headers.games,
                ].map((header) => (
                  <th key={header} scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.key}>
                  <th scope="row" className={`${TWIN_CELL_CLASSES} font-normal`}>
                    {table.period(point)}
                  </th>
                  <td className={TWIN_CELL_CLASSES}>{point.rating}</td>
                  <td className={TWIN_CELL_CLASSES}>{table.rd(point.rd)}</td>
                  <td className={TWIN_CELL_CLASSES}>{table.record(point.wins, point.losses)}</td>
                  <td className={TWIN_CELL_CLASSES}>
                    {table.rate(point.total > 0 ? point.wins / point.total : 0)}
                  </td>
                  <td className={TWIN_CELL_CLASSES}>{point.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 0 && (
            <table className={TWIN_TABLE_CLASSES}>
              <caption className="sr-only">{table.monthCaption}</caption>
              <thead className="max-sm:hidden">
                <tr>
                  <th scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                    {table.headers.year}
                  </th>
                  {table.months.map((month) => (
                    <th key={month} scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                      {month}
                    </th>
                  ))}
                  <th scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                    {table.headers.total}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.year} className={TWIN_STACKED_ROW_CLASSES}>
                    <th
                      scope="row"
                      className={`${TWIN_CELL_CLASSES} ${TWIN_STACKED_CELL_CLASSES} font-semibold max-sm:basis-full`}
                    >
                      {row.year}
                    </th>
                    {row.months.map((record, month) => (
                      <td
                        key={month}
                        data-m={table.months[month]}
                        className={`${TWIN_CELL_CLASSES} ${TWIN_STACKED_CELL_CLASSES} ${TWIN_STACKED_MONTH_CLASSES}${record ? '' : ' text-muted-foreground'}`}
                      >
                        {record
                          ? table.monthCell({
                              rate: record.total > 0 ? record.wins / record.total : 0,
                              total: record.total,
                            })
                          : '—'}
                      </td>
                    ))}
                    <td className={`${TWIN_CELL_CLASSES} ${TWIN_STACKED_CELL_CLASSES}`}>
                      {row.total > 0
                        ? table.yearTotal({
                            wins: row.wins,
                            losses: row.losses,
                            total: row.total,
                            rate: row.wins / row.total,
                          })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
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
export function CareerTimeline({
  timeline,
  labels,
  width,
  onSelectPeriod,
  thinStrip,
  monthRecords,
  eventMarkers,
  onSelectEventMarker,
}: CareerTimelineProps): ReactElement {
  const { i18n } = useTranslation();
  const [measuredWidth, setMeasuredWidth] = useState(RESPONSIVE_FALLBACK_WIDTH);
  const [active, setActive] = useState<ActiveState | null>(null);
  const [readoutWidth, setReadoutWidth] = useState(0);
  const readoutRef = useRef<HTMLDivElement>(null);

  // Every hook lives ABOVE the locked early return below. The readout's own
  // width decides which side of the crosshair it sits on (clampReadoutLeft);
  // re-measured whenever it shows a different target.
  const activeKey = active ? `${active.target.kind}:${active.target.index}` : null;
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

  const points = timeline.rating.points;
  if (timeline.state === 'locked' || points.length === 0 || timeline.domain === null) {
    return (
      <div data-slot="career-timeline" data-state={timeline.state}>
        <LockedInset timeline={timeline} labels={labels} />
      </div>
    );
  }
  const domain = timeline.domain;

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

  // The same linear time mapping the chart's hidden XAxis draws with (its
  // domain is explicit and its range is the plot area) — used only to place
  // the HTML readout beside the crosshair the chart itself draws.
  const plotLeft = geometry.marginLeft;
  const plotRight = containerWidth - geometry.marginRight;
  const xOf = (ms: number) =>
    domain.endMs === domain.startMs
      ? plotLeft
      : plotLeft +
        ((ms - domain.startMs) / (domain.endMs - domain.startMs)) * (plotRight - plotLeft);

  function readoutTargetOf(target: ActiveTarget): CareerTimelineReadoutTarget | null {
    if (target.kind === 'point') {
      const point = points[target.index];
      return point ? { kind: 'point', point } : null;
    }
    if (target.kind === 'event') {
      const marker = eventMarkers?.[target.index];
      return marker ? { kind: 'event', marker } : null;
    }
    const cell = strips?.cells[target.index];
    return cell ? { kind: 'cell', cell } : null;
  }

  function selectionOf(target: ActiveTarget): CareerTimelineSelection | null {
    const resolved = readoutTargetOf(target);
    if (!resolved || resolved.kind === 'event') return null;
    const span = resolved.kind === 'point' ? resolved.point : resolved.cell;
    // The engine's periods are `[startMs, endMs)`; the drill axes are inclusive.
    return { fromMs: span.startMs, toMs: span.endMs - 1 };
  }

  function select(target: ActiveTarget): void {
    if (!onSelectPeriod) return;
    const selection = selectionOf(target);
    if (selection) onSelectPeriod(selection);
  }

  function handlePress(target: ActiveTarget, touch: boolean): void {
    if (touch) {
      // Planner decision 2: the first tap shows the readout; a second tap on
      // the same target drills — a single tap never navigates unseen.
      if (active?.source === 'touch' && sameTarget(active.target, target)) {
        select(target);
        return;
      }
      setActive({ target, source: 'touch' });
      return;
    }
    setActive({ target, source: 'pointer' });
    select(target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const last = points.length - 1;
    const current = active?.target.kind === 'point' ? active.target.index : null;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        // Planner decision 3: the first press starts at the latest period.
        next = current === null ? last : Math.max(0, current - 1);
        break;
      case 'ArrowRight':
        next = current === null ? last : Math.min(last, current + 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Enter':
        if (!active) return;
        event.preventDefault();
        select(active.target);
        return;
      case 'Escape':
        if (!active) return;
        event.preventDefault();
        setActive(null);
        return;
      default:
        return;
    }
    event.preventDefault();
    setActive({ target: { kind: 'point', index: next }, source: 'keyboard' });
  }

  const readoutTarget = active ? readoutTargetOf(active.target) : null;
  const readout = readoutTarget ? labels.readout(readoutTarget) : null;
  let readoutAnchorX = plotLeft;
  if (readoutTarget?.kind === 'point') {
    readoutAnchorX = xOf(readoutTarget.point.closeMs);
  } else if (readoutTarget?.kind === 'cell') {
    readoutAnchorX =
      (Math.max(plotLeft, xOf(readoutTarget.cell.startMs)) +
        Math.min(plotRight, xOf(readoutTarget.cell.endMs))) /
      2;
  } else if (readoutTarget?.kind === 'event') {
    readoutAnchorX = xOf(readoutTarget.marker.atMs);
  }
  const readoutLeft = clampReadoutLeft({
    anchorX: readoutAnchorX,
    readoutWidth: Math.min(readoutWidth, CAREER_TIMELINE_READOUT_MAX_WIDTH_PX),
    containerWidth,
  });
  const readoutBody = (content: CareerTimelineReadout) => (
    <>
      <p data-slot="career-timeline-readout-title" className="text-sm font-semibold">
        {content.title}
      </p>
      {content.lines.map((line, i) => (
        <p
          key={`${i}:${line}`}
          data-slot="career-timeline-readout-line"
          className="text-muted-foreground"
        >
          {line}
        </p>
      ))}
    </>
  );

  const chart = (
    <ComposedChart
      {...(typeof width === 'number' ? { width, height: geometry.height } : {})}
      // UI-SPEC §10.1: the plot wrapper is the ONE tab stop — Recharts'
      // default accessibility layer would add a second (tabIndex=0 surface).
      accessibilityLayer={false}
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
        domain={[domain.startMs, domain.endMs]}
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
        {/* Same (pre-registered) label layer, drawn after the labels: a new
            zIndex value would only mount its portal on a later commit. */}
        <InteractionLayer
          {...layerProps}
          active={active?.target ?? null}
          selectable={onSelectPeriod !== undefined}
          onHover={(target) => setActive(target ? { target, source: 'pointer' } : null)}
          onLeave={() => setActive((prev) => (prev?.source === 'pointer' ? null : prev))}
          onPress={handlePress}
        />
      </ZIndexLayer>
    </ComposedChart>
  );

  return (
    <div
      data-slot="career-timeline"
      data-state={timeline.state}
      className={`relative ${SURFACE_OVERFLOW_CLASSES}`}
    >
      <div
        data-slot="career-timeline-plot"
        tabIndex={0}
        role="img"
        aria-label={labels.aria}
        className={PLOT_FOCUS_CLASSES}
        onKeyDown={handleKeyDown}
        onBlur={() => setActive(null)}
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
      {eventMarkers && eventMarkers.length > 0 && (
        // UI-SPEC §12.1 major-event diamonds, drawn OUTSIDE the plot's
        // role="img" (a focusable control inside an image is hidden from
        // assistive tech) and after it in tab order, on the plot baseline at
        // the chart's own time mapping.
        <svg
          data-slot="career-timeline-events"
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          width={containerWidth}
          height={geometry.height}
        >
          {eventMarkers.map((marker, index) => {
            const x = xOf(marker.atMs);
            const y = geometry.plotBottom;
            const target: ActiveTarget = { kind: 'event', index };
            return (
              <g
                key={marker.key}
                data-slot="career-timeline-event"
                data-basis={marker.basis}
                tabIndex={0}
                role="button"
                aria-label={labels.eventAria ? labels.eventAria(marker) : marker.label}
                className={`pointer-events-auto cursor-pointer ${PLOT_FOCUS_CLASSES}`}
                onFocus={() => setActive({ target, source: 'keyboard' })}
                onBlur={() => setActive(null)}
                onPointerEnter={(event) => {
                  if (event.pointerType !== 'touch') setActive({ target, source: 'pointer' });
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType !== 'touch') {
                    setActive((prev) => (prev?.source === 'pointer' ? null : prev));
                  }
                }}
                onClick={() => onSelectEventMarker?.(marker.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectEventMarker?.(marker.key);
                  }
                }}
              >
                <rect
                  x={x - DIAMOND_HIT_PX / 2}
                  y={y - DIAMOND_HIT_PX / 2}
                  width={DIAMOND_HIT_PX}
                  height={DIAMOND_HIT_PX}
                  fill="transparent"
                />
                <path
                  d={`M${x} ${y - DIAMOND_HALF_PX} ${x + DIAMOND_HALF_PX} ${y} ${x} ${y + DIAMOND_HALF_PX} ${x - DIAMOND_HALF_PX} ${y}Z`}
                  fill={
                    marker.basis === 'estimated' ? CHART_TOKENS.surface : CHART_TOKENS.deemphasis
                  }
                  stroke={
                    marker.basis === 'estimated' ? CHART_TOKENS.deemphasis : CHART_TOKENS.surface
                  }
                  strokeWidth={DIAMOND_STROKE_PX}
                />
              </g>
            );
          })}
        </svg>
      )}
      {timeline.state === 'thin' && thinStrip && (
        <div data-slot="career-timeline-thin-strip" className="mt-3 flex min-w-0 flex-col">
          {thinStrip}
        </div>
      )}
      {labels.table && (
        <TableTwin points={points} monthRecords={monthRecords ?? []} table={labels.table} />
      )}
      {readout && (
        <div
          ref={readoutRef}
          data-slot="career-timeline-readout"
          aria-hidden="true"
          className={READOUT_CLASSES}
          style={{ left: readoutLeft, top: geometry.marginTop }}
        >
          {readoutBody(readout)}
        </div>
      )}
      {/* UI-SPEC §14.7: keyboard steps are announced politely; a pointer hover never is. */}
      <div data-slot="career-timeline-live" aria-live="polite" className="sr-only">
        {readout && active?.source === 'keyboard' ? readoutBody(readout) : null}
      </div>
    </div>
  );
}
