import type { ReactNode } from 'react';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { CHART_BAR_MAX_THICKNESS_PX, CHART_BAR_ROW_HEIGHT_PX, CHART_TOKENS } from './tokens';

export interface ComparisonBarsRow {
  key: string;
  label: ReactNode;
  /** 0-100. Rendered as the filled portion's width percentage. */
  value: number;
  valueLabel: string;
}

export type ComparisonBarsTone = 'emerald' | 'destructive';

interface ComparisonBarsDefaultProps {
  mode?: undefined;
  rows: ComparisonBarsRow[];
  tone: ComparisonBarsTone;
  onSelectRow?: (row: ComparisonBarsRow) => void;
}

/**
 * `ComparisonBars`'s dumbbell row shape (UI-SPEC §7.11): a category's
 * baseline (all-time) rate compared against its recent rate and 95% range.
 * `recentRecordNode` is host-controlled content — it shows the ALL-TIME
 * record instead of the recent one when the host has already detected the
 * sub-floor case, per the honesty rule below.
 */
export interface ComparisonBarsDumbbellRow {
  key: string;
  label: ReactNode;
  recentRecordNode: ReactNode;
  /** Rendered unless `collapsed` — a thin/none-state chip is still host content, not this component's job. */
  deltaNode: ReactNode;
  /** 0-100. */
  baselineRate: number;
  /** 0-100. Omitted from the track (regardless of presence) when `recentTotal < ABSTENTION_FLOOR_GAMES` or `collapsed`. */
  recentRate?: number;
  /** [low, high], 0-100. Same omission rule as `recentRate`. */
  recentRange?: [number, number];
  recentTotal: number;
  href: string;
  ariaLabel: string;
  /** When horizons are collapsed: baseline tick only, delta slot empty. */
  collapsed?: boolean;
}

export interface ComparisonBarsDumbbellProps {
  mode: 'dumbbell';
  /** Rendered in the order given — this component never sorts (the host decides row order). */
  rows: ComparisonBarsDumbbellRow[];
}

export type ComparisonBarsProps = ComparisonBarsDefaultProps | ComparisonBarsDumbbellProps;

const DUMBBELL_TRACK_HEIGHT_PX = 16;
const DUMBBELL_RAIL_HEIGHT_PX = 2;
const DUMBBELL_MIDLINE_WIDTH_PX = 1;
const DUMBBELL_RANGE_HEIGHT_PX = 6;
const DUMBBELL_BASELINE_TICK_WIDTH_PX = 2;
const DUMBBELL_BASELINE_TICK_HEIGHT_PX = 14;
const DUMBBELL_RECENT_DOT_SIZE_PX = 10;
const DUMBBELL_RECENT_DOT_RING_PX = 2;

function DumbbellRow({ row }: { row: ComparisonBarsDumbbellRow }) {
  const showRecentTrack =
    !row.collapsed &&
    row.recentTotal >= ABSTENTION_FLOOR_GAMES &&
    typeof row.recentRate === 'number';

  const rowContent = (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 truncate">{row.label}</span>
      <span data-slot="dumbbell-record">{row.recentRecordNode}</span>
      <span data-slot="dumbbell-delta" className="min-w-16 text-right">
        {row.collapsed ? null : row.deltaNode}
      </span>
      <div
        data-slot="dumbbell-track"
        className="relative col-span-3 w-full"
        style={{ height: DUMBBELL_TRACK_HEIGHT_PX }}
      >
        <div
          data-slot="dumbbell-rail"
          className="absolute inset-x-0 top-1/2 -translate-y-1/2"
          style={{
            height: DUMBBELL_RAIL_HEIGHT_PX,
            backgroundColor: CHART_TOKENS.deemphasisStrong,
          }}
        />
        <div
          data-slot="dumbbell-midline"
          className="absolute top-0 bottom-0"
          style={{
            left: '50%',
            width: DUMBBELL_MIDLINE_WIDTH_PX,
            backgroundColor: CHART_TOKENS.deemphasisStrong,
          }}
        />
        {showRecentTrack && row.recentRange && (
          <div
            data-slot="dumbbell-range"
            className="absolute top-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${row.recentRange[0]}%`,
              width: `${row.recentRange[1] - row.recentRange[0]}%`,
              height: DUMBBELL_RANGE_HEIGHT_PX,
              backgroundColor: CHART_TOKENS.series1,
              opacity: 0.16,
            }}
          />
        )}
        <div
          data-slot="dumbbell-baseline-tick"
          className="absolute top-1/2 -translate-y-1/2"
          style={{
            left: `${row.baselineRate}%`,
            width: DUMBBELL_BASELINE_TICK_WIDTH_PX,
            height: DUMBBELL_BASELINE_TICK_HEIGHT_PX,
            backgroundColor: CHART_TOKENS.deemphasis,
          }}
        />
        {showRecentTrack && (
          <div
            data-slot="dumbbell-recent-dot"
            className="absolute top-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${row.recentRate}%`,
              width: DUMBBELL_RECENT_DOT_SIZE_PX,
              height: DUMBBELL_RECENT_DOT_SIZE_PX,
              backgroundColor: CHART_TOKENS.series1,
              boxShadow: `0 0 0 ${DUMBBELL_RECENT_DOT_RING_PX}px ${CHART_TOKENS.surface}`,
            }}
          />
        )}
      </div>
    </div>
  );

  return (
    <li key={row.key}>
      <a href={row.href} aria-label={row.ariaLabel} className="block">
        {rowContent}
      </a>
    </li>
  );
}

/**
 * Status-colour classes for each tone (CHRT-01 kit README, "the collision
 * rule"): a series that means good/bad wears the app's existing status
 * tokens, never `--chart-*` categorical tokens. `emerald` is the pick tone,
 * `destructive` the ban tone.
 */
const TONE_CLASSES: Record<ComparisonBarsTone, { track: string; fill: string }> = {
  emerald: { track: 'bg-emerald-500/15', fill: 'bg-emerald-500' },
  destructive: { track: 'bg-destructive/15', fill: 'bg-destructive' },
};

/**
 * The comparison-bars chart-kit vocabulary member (kit README "Comparison
 * bars"): one horizontal meter row per item — an unfilled track spanning the
 * FULL row width at low opacity (state reads across the whole bar, not just
 * the filled portion — the "meter" convention) plus a filled portion sized
 * to `value` as a percentage, rounded at the value tip and square at the
 * baseline. `label` renders before the bar, `valueLabel` at the bar's tip.
 *
 * Plain DOM, not a Recharts primitive: this member never imports `recharts`
 * and is deliberately NOT a member of `chartKitBoundary.test.ts`'s
 * `KIT_CHART_PRIMITIVES` — that list enumerates kit files that render a
 * Recharts element for the structural frame rule (every member must nest
 * inside a `ChartCard`); a CSS meter renders no Recharts element, so it is
 * outside that rule's scope. `CounterpickAdvisor.tsx` supplies the
 * `ChartCard` frame this component renders inside, the same split
 *
 * `mode: 'dumbbell'` (39.1-08, VIZ-02/DD-04) is a THIRD variant of this same
 * member, added the exact way `TrendLine.tsx` gained its `'event'` mode: the
 * existing mode-less props stay the default branch, untouched — every
 * existing call site that omits `mode` stays byte-unchanged. A dumbbell row
 * compares a category's all-time rate against its recent rate and 95% range
 * on one track; per the honesty rule, the recent dot and range are OMITTED
 * (never hollowed into a fabricated position) when `recentTotal` is below
 * `ABSTENTION_FLOOR_GAMES` or when the row is `collapsed` — see
 * `DumbbellRow` below.
 * `MatchupChart.tsx`/`TrendLine.tsx` already establish.
 */
export function ComparisonBars(props: ComparisonBarsProps) {
  if (props.mode === 'dumbbell') {
    return (
      <ul className="flex flex-col" data-slot="comparison-bars-dumbbell">
        {props.rows.map((row) => (
          <DumbbellRow key={row.key} row={row} />
        ))}
      </ul>
    );
  }
  const { rows, tone, onSelectRow } = props;
  const toneClasses = TONE_CLASSES[tone];

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const widthPct = Math.max(0, Math.min(100, row.value));
        const rowContent = (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              {row.label}
              <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                {row.valueLabel}
              </span>
            </div>
            <div
              data-slot="comparison-bar-track"
              className={`relative w-full overflow-hidden rounded-full ${toneClasses.track}`}
              style={{ height: CHART_BAR_MAX_THICKNESS_PX }}
            >
              <div
                data-slot="comparison-bar-fill"
                className={`h-full rounded-full ${toneClasses.fill}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
          </>
        );
        return (
          <li key={row.key} style={{ minHeight: CHART_BAR_ROW_HEIGHT_PX }}>
            {onSelectRow ? (
              <button
                type="button"
                className="flex w-full flex-col gap-1 text-left"
                onClick={() => onSelectRow(row)}
              >
                {rowContent}
              </button>
            ) : (
              <div className="flex flex-col gap-1">{rowContent}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
