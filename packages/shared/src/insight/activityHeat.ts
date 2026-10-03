/**
 * UI-SPEC §7.3 (heat data) / B1: the contract of the activity heat — games per UTC month, laid out as
 * year rows by month columns. Interface-first (plan 41-01): final exported types and bound
 * constants only; plan 41-03 adds `buildActivityHeat` to this same file.
 *
 * The cell count is bounded by `MARK_BOUND_HEAT_CELLS` (108 = 9 years × 12 months), which is why the
 * row count is capped at `ACTIVITY_HEAT_MAX_YEARS`; older years stay reachable in the table form.
 */

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
