import type { ReactNode } from 'react';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { CHART_TOKENS } from './tokens';

export interface ComparisonBarsRow {
  key: string;
  label: ReactNode;
  /** 0-100. Rendered as the filled portion's width percentage. */
  value: number;
  /** The row's value as one plain-text sentence — the accessible text even when `valueNode` replaces it visually. */
  valueLabel: string;
  /**
   * Plan 39.1-46 (`series` tone): host content drawn in place of `valueLabel`
   * (a `Record` and a confidence glyph). `valueLabel` stays in the DOM,
   * screen-reader only, so the row's accessible name never depends on markup.
   */
  valueNode?: ReactNode;
  /** `series` tone: the row's full label text, shown as a native tooltip when `label` truncates. */
  labelTitle?: string;
  /** `series` tone: the row sits under the abstention floor — strong de-emphasis fill, muted label. */
  subFloor?: boolean;
}

/**
 * `series` (plan 39.1-46, PD-46-1, sketch 003 A `.cmp` rows) is the neutral
 * evidence tone: identity-blue fill, muted track, an optional all-time
 * reference tick. Since plan 39.1-47 (PD-47-4) it is the ONLY tone — the two
 * status tones that once carried the advisor's pick / ban judgement were
 * deleted with their last caller (an alarm colour on an evidence row breaks
 * the sketch's "blue data ink" rule; `designFidelity.test.ts` fails a status
 * tone passed to this member).
 */
export type ComparisonBarsTone = 'series';

interface ComparisonBarsDefaultProps {
  mode?: undefined;
  rows: ComparisonBarsRow[];
  tone: ComparisonBarsTone;
  onSelectRow?: (row: ComparisonBarsRow) => void;
  /** `series` tone: 0-100 position of the all-time reference tick drawn on every row's track. */
  referenceRate?: number;
  /** `series` tone: a hairline between rows (sketch `.cmp.divide`). */
  divided?: boolean;
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

/** Sketch 003 `.cmp-track .ref`: the tick is 2px wide and pokes 2px past the track above and below. */
const SERIES_REFERENCE_WIDTH_PX = 2;
const SERIES_REFERENCE_OVERHANG_PX = 2;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * The `series` tone's rows (plan 39.1-46, sketch 003 A `.cmp-row`): a
 * two-column grid — label | value — with the 6px track spanning both. The
 * fill is the identity series token, or the strong de-emphasis token for a
 * sub-floor row; the optional reference tick is drawn in the de-emphasis ink.
 */
function SeriesRows({
  rows,
  onSelectRow,
  referenceRate,
  divided,
}: Pick<ComparisonBarsDefaultProps, 'rows' | 'onSelectRow' | 'referenceRate' | 'divided'>) {
  return (
    <ul
      className={divided ? 'flex flex-col divide-y divide-border' : 'flex flex-col'}
      data-slot="comparison-bars-series"
    >
      {rows.map((row) => {
        const content = (
          <>
            <span
              data-slot="comparison-bar-label"
              title={row.labelTitle}
              className={`min-w-0 truncate font-medium${row.subFloor ? ' text-muted-foreground' : ''}`}
            >
              {row.label}
            </span>{' '}
            <span className="text-right text-sm whitespace-nowrap text-muted-foreground">
              {row.valueNode ? (
                <>
                  <span aria-hidden="true">{row.valueNode}</span>
                  <span className="sr-only">{row.valueLabel}</span>
                </>
              ) : (
                row.valueLabel
              )}
            </span>
            <span
              data-slot="comparison-bar-track"
              className="relative col-span-2 h-1.5 w-full rounded-full bg-muted"
            >
              <span
                data-slot="comparison-bar-fill"
                className="block h-full rounded-full"
                style={{
                  width: `${clampPercent(row.value)}%`,
                  backgroundColor: row.subFloor
                    ? CHART_TOKENS.deemphasisStrong
                    : CHART_TOKENS.series1,
                }}
              />
              {typeof referenceRate === 'number' && (
                <span
                  data-slot="comparison-bar-reference"
                  className="absolute"
                  style={{
                    left: `${clampPercent(referenceRate)}%`,
                    top: -SERIES_REFERENCE_OVERHANG_PX,
                    bottom: -SERIES_REFERENCE_OVERHANG_PX,
                    width: SERIES_REFERENCE_WIDTH_PX,
                    backgroundColor: CHART_TOKENS.deemphasis,
                  }}
                />
              )}
            </span>
          </>
        );
        const rowClass =
          '-mx-1.5 grid w-[calc(100%+0.75rem)] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-1.5 py-1.5';
        return (
          <li key={row.key}>
            {onSelectRow ? (
              <button
                type="button"
                className={`${rowClass} cursor-pointer text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
                onClick={() => onSelectRow(row)}
              >
                {content}
              </button>
            ) : (
              <div className={rowClass}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

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
 * outside that rule's scope. The host supplies the card frame (the Matchups
 * rail cards render it inside their own `Card`, the stage rows of the
 * Insights card, Stage breakdown, MatchupOrPlayer mark and Counterpick
 * Advisor alike).
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
  return (
    <SeriesRows
      rows={props.rows}
      onSelectRow={props.onSelectRow}
      referenceRate={props.referenceRate}
      divided={props.divided}
    />
  );
}
