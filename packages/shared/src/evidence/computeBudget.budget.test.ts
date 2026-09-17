import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';
import { buildStageEvidence } from './stageEvidence.js';
import { buildMatchupEvidence } from './matchupEvidence.js';
import {
  SCL_01_BUDGETS,
  BUDGET_SAMPLE_ITERATIONS,
  percentileNearestRank,
  budgetVerdict,
  formatScl01Line,
  type Scl01Budget,
} from './budgets.js';

/**
 * SCL-01 engine-compute budget command (D-19, D-26). Deliberately excluded
 * from the default test run (`*.budget.test.ts` in `vitest.config.ts`'s
 * `exclude`) and run only via `pnpm --filter @smash-tracker/shared budget`.
 *
 * ORACLE property vs. TASK completion gate (R1-HIGH-4): this command exits
 * non-zero when a measured value exceeds its budget — that property is what
 * D-26 requires, and it is demonstrated by deliberately lowering a target and
 * observing the failure (recorded in 36-06-SUMMARY.md), never by the happy
 * path alone. Whether THIS run's own p95 happens to pass or miss the WRITTEN
 * target is a measurement outcome, not a defect in this file.
 */

function budgetFor(id: string): Scl01Budget {
  const budget = SCL_01_BUDGETS.find((b) => b.id === id);
  if (!budget) {
    throw new Error(`missing SCL-01 budget: ${id}`);
  }
  return budget;
}

/** One full engine recompute: both aggregate entry points over the whole fixture. */
function recompute(matches: Match[]): void {
  const refreshedAt = Date.now();
  buildStageEvidence({ matches, refreshedAt });
  buildMatchupEvidence({ matches, refreshedAt });
}

/** Warms up once, then times `BUDGET_SAMPLE_ITERATIONS` full recomputes and returns the p95 (ms). */
function measureRecomputeP95Ms(matches: Match[]): number {
  recompute(matches); // warmup — excluded from the sample
  const samplesMs: number[] = [];
  for (let i = 0; i < BUDGET_SAMPLE_ITERATIONS; i += 1) {
    const start = performance.now();
    recompute(matches);
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);
  return percentileNearestRank(samplesMs, 95);
}

describe('SCL-01 engine-compute budget', () => {
  it('8k synthetic fixture: p95 full recompute against the written budget', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const budget = budgetFor('engine-recompute-p95-8k');
    const p95 = Math.round(measureRecomputeP95Ms(matches) * 100) / 100;
    console.log(formatScl01Line(budget.id, budget.target, budget.unit, p95));
    expect(p95).toBeLessThanOrEqual(budget.target);
  });

  it('50k synthetic fixture: p95 full recompute against the written budget', () => {
    const matches = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS);
    const budget = budgetFor('engine-recompute-p95-50k');
    const p95 = Math.round(measureRecomputeP95Ms(matches) * 100) / 100;
    console.log(formatScl01Line(budget.id, budget.target, budget.unit, p95));
    expect(p95).toBeLessThanOrEqual(budget.target);
  });

  it('empty fixture: completes, reports a zero game count, no division by a zero denominator', () => {
    const stage = buildStageEvidence({ matches: [], refreshedAt: Date.now() });
    expect(stage.claim.sample.rawSampleSize).toBe(0);
    expect(Number.isFinite(stage.claim.sample.knownFieldCoverage)).toBe(true);
    expect(Number.isNaN(stage.claim.sample.knownFieldCoverage)).toBe(false);

    const matchup = buildMatchupEvidence({ matches: [], refreshedAt: Date.now() });
    expect(matchup.claim.sample.rawSampleSize).toBe(0);
    expect(Number.isFinite(matchup.claim.sample.knownFieldCoverage)).toBe(true);
    expect(Number.isNaN(matchup.claim.sample.knownFieldCoverage)).toBe(false);
  });

  it('percentileNearestRank is nearest-rank, not interpolated or a mean', () => {
    expect(percentileNearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentileNearestRank([1, 2], 95)).toBe(2);
  });

  it('the budget comparison is <=: a measured value exactly equal to its target PASSes', () => {
    const target = 100;
    expect(budgetVerdict(target, target)).toBe('PASS');
    expect(budgetVerdict(target + 1, target)).toBe('MISS');
    expect(budgetVerdict(target - 1, target)).toBe('PASS');
  });
});
