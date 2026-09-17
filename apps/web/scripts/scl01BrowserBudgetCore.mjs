/**
 * SCL-01 browser-budget PURE core (Phase 36 Plan 06, Task 3B): the
 * statistics/verdict logic, separated from the Puppeteer/Vite orchestration
 * in `scl01BrowserBudget.mjs` so it is unit-testable without a browser.
 * Reuses `percentileNearestRank`/`budgetVerdict`/`formatScl01Line`/
 * `SCL_01_BUDGETS` from `@smash-tracker/shared` — the SAME budget source
 * and nearest-rank method the automated (headless) budgets use (D-19).
 * Reads targets; never edits them.
 */
import {
  percentileNearestRank,
  budgetVerdict,
  formatScl01Line,
  SCL_01_BUDGETS,
} from '@smash-tracker/shared';

export function budgetFor(id) {
  const budget = SCL_01_BUDGETS.find((b) => b.id === id);
  if (!budget) {
    throw new Error(`missing SCL-01 budget: ${id}`);
  }
  return budget;
}

/** p95 over a raw (unsorted) millisecond sample array, via nearest-rank. */
export function computeP95Ms(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return percentileNearestRank(sorted, 95);
}

/**
 * `filter-change-to-paint-8k`: p95 over the repeated fighter-switch
 * samples. Rounds to 2 decimal places for a readable printed line.
 */
export function buildFilterChangeToPaintResult(samplesMs) {
  const budget = budgetFor('filter-change-to-paint-8k');
  const measured = Math.round(computeP95Ms(samplesMs) * 100) / 100;
  return {
    id: budget.id,
    target: budget.target,
    unit: budget.unit,
    measured,
    verdict: budgetVerdict(measured, budget.target),
    samples: samplesMs,
    line: formatScl01Line(budget.id, budget.target, budget.unit, measured),
  };
}

/**
 * `heap-delta-50k`: every sample plus the MAX as the reported figure
 * (worst case, stated as such — per this task's explicit instruction, not
 * an average or a p95).
 */
export function buildHeapDeltaResult(samplesMb) {
  const measured = Math.round(Math.max(...samplesMb) * 100) / 100;
  const budget = budgetFor('heap-delta-50k');
  return {
    id: budget.id,
    target: budget.target,
    unit: budget.unit,
    measured,
    verdict: budgetVerdict(measured, budget.target),
    samples: samplesMb,
    line: formatScl01Line(budget.id, budget.target, budget.unit, measured),
  };
}

/** Bytes -> megabytes, matching `heap-delta-50k`'s `MB` unit. */
export function bytesToMb(bytes) {
  return bytes / (1024 * 1024);
}
