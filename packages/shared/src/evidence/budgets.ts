/**
 * SCL-01 measurement-gate budgets (D-19, D-21, D-26, D-27).
 *
 * THESE TARGETS WERE WRITTEN BEFORE ANY MEASUREMENT WAS TAKEN. A later change
 * may TIGHTEN a target (make it stricter) but must NEVER LOOSEN one just to
 * make a miss disappear — a target existing to be met, not adjusted to match
 * whatever the code currently does.
 *
 * This array is APPEND-ONLY: a later plan may APPEND a new budget id (see
 * plan 36-08's `server-heap-delta-50k`, added under this exact rule) but may
 * never edit or remove an existing entry. The order below is a fixed,
 * declared order — the SCL-01 readout renders every budget in this same
 * order, so two readouts stay diffable line-for-line.
 *
 * Each entry's `measuredBy` names the honest instrument that produced (or
 * will produce) its number. Two entries measured by genuinely different
 * instruments must never share an id — a Node `process.memoryUsage()` delta
 * and a Chrome DevTools Memory-panel heap delta are not the same quantity,
 * and recording them against one target would silently launder the
 * difference. That is why `heap-delta-50k` (this plan, `browser-protocol`)
 * and any future Node-side heap measurement are distinct ids, never the
 * same one reused across instruments.
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
