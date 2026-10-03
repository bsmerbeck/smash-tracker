/**
 * UI-SPEC §7.3 (heat data) / B1: the activity heat — games per UTC month, laid out as year rows by
 * month columns. Plan 41-01 declared the contract; plan 41-03 adds `buildActivityHeat` to this file.
 *
 * The cell count is bounded by `MARK_BOUND_HEAT_CELLS` (108 = 9 years × 12 months), which is why the
 * row count is capped at `ACTIVITY_HEAT_MAX_YEARS`; older years stay reachable in the table form.
 */

import type { Match } from '../match.js';
import { calendarBucketBounds } from './periodSeries.js';

/** At most this many year rows are drawn (9 × 12 = `MARK_BOUND_HEAT_CELLS`). */
export const ACTIVITY_HEAT_MAX_YEARS = 9;

export interface ActivityHeatCell {
  year: number;
  /** 1-12, UTC. */
  month: number;
  /** Games played in the month. */
  total: number;
  fromMs: number;
  /** Inclusive end of the month (`endMs - 1`), so a drill-down range never reaches the next month. */
  toMs: number;
}

export interface ActivityHeat {
  /** Newest first, at most `ACTIVITY_HEAT_MAX_YEARS`. */
  years: number[];
  /** Sparse: months with at least one game only (at most 108). */
  cells: ActivityHeatCell[];
  yearTotals: { year: number; total: number }[];
  maxCellValue: number;
  shownYears: number;
  totalYears: number;
}

export interface BuildActivityHeatOptions {
  /** Defaults to `ACTIVITY_HEAT_MAX_YEARS`. */
  maxYears?: number;
}

/**
 * Buckets `matches` into UTC calendar months and lays them out as the activity heat: years newest
 * first (capped at `options.maxYears`, default `ACTIVITY_HEAT_MAX_YEARS`), one sparse cell per month
 * that has at least one game, a total for EVERY year (the table twin lists them all, shown or not),
 * and the largest cell so a host's tint step is stable across re-renders.
 *
 * Months bucket in UTC (`calendarBucketBounds('month', ...)`, the rule `periodSeries.ts` and the career
 * timeline's month drill share): a game at 2026-03-01T02:00Z is a March game whatever the host time
 * zone. A cell's `toMs` is the inclusive month end, so a drill-down range never reaches the next month.
 * Pure: no module state, input never mutated.
 */
export function buildActivityHeat(
  matches: Match[],
  options: BuildActivityHeatOptions = {},
): ActivityHeat {
  const maxYears = Math.max(0, options.maxYears ?? ACTIVITY_HEAT_MAX_YEARS);

  const byMonth = new Map<number, ActivityHeatCell>();
  const totalByYear = new Map<number, number>();
  for (const match of matches) {
    const bucket = calendarBucketBounds('month', match.time);
    const existing = byMonth.get(bucket.startMs);
    if (existing) {
      existing.total += 1;
    } else {
      const start = new Date(bucket.startMs);
      byMonth.set(bucket.startMs, {
        year: start.getUTCFullYear(),
        month: start.getUTCMonth() + 1,
        total: 1,
        fromMs: bucket.startMs,
        toMs: bucket.endMs - 1,
      });
    }
    const year = new Date(bucket.startMs).getUTCFullYear();
    totalByYear.set(year, (totalByYear.get(year) ?? 0) + 1);
  }

  const allYears = [...totalByYear.keys()].sort((a, b) => b - a);
  const years = allYears.slice(0, maxYears);
  const shown = new Set(years);
  const cells = [...byMonth.values()]
    .filter((cell) => shown.has(cell.year))
    .sort((a, b) => b.year - a.year || a.month - b.month);

  return {
    years,
    cells,
    yearTotals: allYears.map((year) => ({ year, total: totalByYear.get(year)! })),
    maxCellValue: cells.reduce((max, cell) => Math.max(max, cell.total), 0),
    shownYears: years.length,
    totalYears: allYears.length,
  };
}
