import type { ReactNode } from 'react';
import { CHART_BAR_MAX_THICKNESS_PX, CHART_BAR_ROW_HEIGHT_PX } from './tokens';

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
 * RED-phase stub (39.1-08 Task 3, tdd="true"): shape only, no rendering yet.
 * Replaced by the real dumbbell row shape in the GREEN commit.
 */
export interface ComparisonBarsDumbbellRow {
  key: string;
  label: ReactNode;
  recentRecordNode: ReactNode;
  deltaNode: ReactNode;
  baselineRate: number;
  recentRate?: number;
  recentRange?: [number, number];
  recentTotal: number;
  href: string;
  ariaLabel: string;
  collapsed?: boolean;
}

export interface ComparisonBarsDumbbellProps {
  mode: 'dumbbell';
  rows: ComparisonBarsDumbbellRow[];
}

export type ComparisonBarsProps = ComparisonBarsDefaultProps | ComparisonBarsDumbbellProps;

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
 * `MatchupChart.tsx`/`TrendLine.tsx` already establish.
 */
export function ComparisonBars(props: ComparisonBarsProps) {
  if (props.mode === 'dumbbell') {
    // RED-phase placeholder — real dumbbell rendering lands in the GREEN commit.
    return <ul data-slot="comparison-bars-dumbbell" />;
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
