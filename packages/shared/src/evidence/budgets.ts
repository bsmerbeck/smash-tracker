/**
 * SCL-01 measurement-gate budgets (D-19, D-21, D-26, D-27).
 *
 * THESE TARGETS WERE WRITTEN BEFORE ANY MEASUREMENT WAS TAKEN. A later change
 * may TIGHTEN a target (make it stricter) but must NEVER LOOSEN one just to
 * make a miss disappear — a target existing to be met, not adjusted to match
 * whatever the code currently does.
 *
 * This array is APPEND-ONLY: a later plan may APPEND a new budget id (plan
 * 36-08 appends a distinct server-side heap-delta id under this exact rule)
 * but may never edit or remove an existing entry. The order below is a fixed,
 * declared order — the SCL-01 readout renders every budget in this same
 * order, so two readouts stay diffable line-for-line.
 *
 * Each entry's `measuredBy` names the honest instrument that produced (or
 * will produce) its number. Two entries measured by genuinely different
 * instruments must never share an id — a Node `process.memoryUsage()` delta
 * and a Chrome DevTools Memory-panel heap delta are not the same quantity,
 * and recording them against one target would silently launder the
 * difference. That is why this plan's browser-measured heap budget below
 * and any future Node-side heap measurement (see plan 36-08) are distinct
 * ids, never the same one reused across instruments — this comment
 * deliberately does not restate either id verbatim, since a later target-
 * drift guard locates each id's `target:` field by searching forward from
 * that id's FIRST textual occurrence in this file, and a second, earlier
 * mention in prose would point the guard at the wrong text.
 *
 * WR-04-i3 (36-REVIEW.md iteration 3): the never-loosen/append-only contract
 * above was, until this fix, enforced by nothing but this prose and a
 * one-off `node -e` shell check that ran once, by hand, during 36-06's own
 * execution and was never committed anywhere. `budgets.guard.test.ts` (same
 * directory) is the committed, falsifiable regression guard: it pins the
 * five D-19 target values by id and runs in the DEFAULT `pnpm test` suite,
 * so a later change that loosens a target, renames/removes an id, or
 * reorders the five relative to each other turns it red. See that file's
 * own doc comment for the full incident.
 */

export type BudgetUnit = 'ms' | 'MB' | 'bytes';
export type BudgetScale = '8k' | '50k';
export type MeasuredBy = 'automated' | 'browser-protocol';

export interface Scl01Budget {
  /** Stable identifier — never renamed once measured against (append-only). */
  id: string;
  /** The written target, in `unit`. A measured value <= target is a PASS. */
  target: number;
  unit: BudgetUnit;
  scale: BudgetScale;
  measuredBy: MeasuredBy;
}

/**
 * The five SCL-01 budgets, in their fixed declared order (D-19). D-19's
 * prose names four VALUES because the engine-recompute p95 is stated at two
 * scales (8k and 50k) — that yields five ENTRIES, not four.
 */
export const SCL_01_BUDGETS: readonly Scl01Budget[] = Object.freeze([
  {
    id: 'engine-recompute-p95-8k',
    target: 100,
    unit: 'ms',
    scale: '8k',
    measuredBy: 'automated',
  },
  {
    id: 'engine-recompute-p95-50k',
    target: 400,
    unit: 'ms',
    scale: '50k',
    measuredBy: 'automated',
  },
  {
    id: 'filter-change-to-paint-8k',
    target: 200,
    unit: 'ms',
    scale: '8k',
    measuredBy: 'browser-protocol',
  },
  {
    id: 'heap-delta-50k',
    target: 150,
    unit: 'MB',
    scale: '50k',
    measuredBy: 'browser-protocol',
  },
  {
    id: 'matches-gzip-payload-8k',
    target: 1_500_000,
    unit: 'bytes',
    scale: '8k',
    measuredBy: 'automated',
  },
  /**
   * Plan 39.1-21 Task 2 (VIZ-01/append-only rule): a SIXTH, APPENDED entry —
   * the insight engine's own `computeInsights()` scan (account scope + one
   * character scope, `last30` horizon) over the 8k fixture, distinct from
   * the five D-19 entries above (which time `buildStageEvidence`/
   * `buildMatchupEvidence`/`buildOpponentCrossTab`, never the insight
   * engine). Measured p95 at authoring time: ~20ms (20 samples, nearest-rank,
   * `computeBudget.budget.test.ts`'s own `it` prints the exact figure via
   * `formatScl01Line` every run). Target set at 50ms — comfortable headroom
   * over the measured figure, tighter than the pre-existing
   * `engine-recompute-p95-8k` target (100ms) since a two-scope insight scan
   * is lighter-weight than a full evidence recompute. Appended AFTER the
   * five pinned D-19 ids (`budgets.guard.test.ts`'s append-only guard scans
   * for exactly those five, in order, and permits anything following them).
   */
  {
    id: 'insight-scan-p95-8k',
    target: 50,
    unit: 'ms',
    scale: '8k',
    measuredBy: 'automated',
  },
]);

/** Fixed iteration count each timed automated run uses (at least 20 samples per p95). */
export const BUDGET_SAMPLE_ITERATIONS = 20;

/**
 * Nearest-rank percentile over an ALREADY-SORTED-ASCENDING sample array — no
 * interpolation, no mean. `percentile` is 0-100. Clamped to a valid index so
 * a 1- or 2-element sample never reads out of bounds.
 */
export function percentileNearestRank(sortedMs: readonly number[], percentile: number): number {
  if (sortedMs.length === 0) {
    throw new Error('percentileNearestRank: sample array is empty');
  }
  const rank = Math.ceil((percentile / 100) * sortedMs.length);
  const index = Math.min(Math.max(rank, 1), sortedMs.length) - 1;
  return sortedMs[index]!;
}

/** A measured value <= target is a PASS — an exact-equality measurement passes. */
export function budgetVerdict(measured: number, target: number): 'PASS' | 'MISS' {
  return measured <= target ? 'PASS' : 'MISS';
}

/**
 * The one machine-readable line shape every budget command prints, so the
 * SCL-01 readout is assembled from real command output rather than from
 * memory: `SCL-01 <id> target=<n><unit> measured=<n><unit> verdict=<PASS|MISS>`.
 */
export function formatScl01Line(
  id: string,
  target: number,
  unit: BudgetUnit,
  measured: number,
): string {
  const verdict = budgetVerdict(measured, target);
  return `SCL-01 ${id} target=${target}${unit} measured=${measured}${unit} verdict=${verdict}`;
}
