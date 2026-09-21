import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';
import { buildStageEvidence } from './stageEvidence.js';
import { buildMatchupEvidence } from './matchupEvidence.js';
import { buildOpponentCrossTab } from './opponentCrossTab.js';
import { computeInsights, ACCOUNT_SCOPE } from '../insight/index.js';
import type { InsightScope } from '../insight/types.js';
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
 *
 * D-16 (plan 38-01, Task 3): the hub cross-tab's cost is now folded INSIDE
 * this same measured `recompute()` — no sixth `SCL_01_BUDGETS` id is
 * registered; the existing `engine-recompute-p95-8k`/`-50k` targets now cover
 * three aggregate entry points instead of two.
 */

function budgetFor(id: string): Scl01Budget {
  const budget = SCL_01_BUDGETS.find((b) => b.id === id);
  if (!budget) {
    throw new Error(`missing SCL-01 budget: ${id}`);
  }
  return budget;
}

/**
 * D-16: the identity `recompute()` cross-tabs each iteration, threaded via a
 * module-scope closure variable rather than a `recompute` parameter —
 * `recompute`'s single-`Match[]`-parameter signature and
 * `measureRecomputeP95Ms`'s two call sites are this task's own
 * read_first-declared untouched harness, so a new parameter (which would
 * require editing both) is not an option here. Derived from the fixture
 * itself (the identity with the most countable games) rather than a
 * hardcoded tag, so a change to the generator's RNG stream cannot silently
 * turn the bench into a zero-work call.
 */
let benchOpponentTag = '';

/** The raw opponent tag with the most rows in `matches` — a real, non-trivial identity to cross-tab in the bench, computed fresh per fixture. */
function deriveBenchOpponentTag(matches: Match[]): string {
  const counts = new Map<string, number>();
  for (const match of matches) {
    if (!match.opponent) continue;
    counts.set(match.opponent, (counts.get(match.opponent) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

/** One full engine recompute: all three aggregate entry points over the whole fixture. */
function recompute(matches: Match[]): void {
  const refreshedAt = Date.now();
  buildStageEvidence({ matches, refreshedAt });
  buildMatchupEvidence({ matches, refreshedAt });
  buildOpponentCrossTab({ matches, aliasMap: {}, opponentTag: benchOpponentTag, refreshedAt });
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

/** Plan 39.1-21 Task 2 (VIZ-01): the main fighter (most games) in a fixture — a real, non-trivial character scope for the insight-scan budget, computed fresh per fixture (never a hardcoded id). */
function mainCharacterScope(matches: Match[]): InsightScope {
  const counts = new Map<number, number>();
  for (const match of matches) {
    counts.set(match.fighter_id, (counts.get(match.fighter_id) ?? 0) + 1);
  }
  let bestFighterId = -1;
  let bestCount = -1;
  for (const [fighterId, count] of counts) {
    if (count > bestCount) {
      bestFighterId = fighterId;
      bestCount = count;
    }
  }
  return {
    kind: 'character',
    key: `character:${bestFighterId}`,
    axes: { fighter: bestFighterId },
    filter: (ms) => ms.filter((m) => m.fighter_id === bestFighterId),
  };
}

/** One insight scan: account scope + one character scope, `last30` horizon — the same shape `evidence.bench.ts`'s companion bench case exercises. */
function scanInsights(matches: Match[], characterScope: InsightScope): void {
  computeInsights({
    matches,
    scopes: [ACCOUNT_SCOPE, characterScope],
    horizon: 'last30',
    nowMs: Date.now(),
  });
}

/** Warms up once, then times `BUDGET_SAMPLE_ITERATIONS` insight scans and returns the p95 (ms). */
function measureInsightScanP95Ms(matches: Match[]): number {
  const characterScope = mainCharacterScope(matches);
  scanInsights(matches, characterScope); // warmup — excluded from the sample
  const samplesMs: number[] = [];
  for (let i = 0; i < BUDGET_SAMPLE_ITERATIONS; i += 1) {
    const start = performance.now();
    scanInsights(matches, characterScope);
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);
  return percentileNearestRank(samplesMs, 95);
}

describe('SCL-01 engine-compute budget', () => {
  it('8k synthetic fixture: p95 full recompute against the written budget', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    benchOpponentTag = deriveBenchOpponentTag(matches);
    const budget = budgetFor('engine-recompute-p95-8k');
    const p95 = Math.round(measureRecomputeP95Ms(matches) * 100) / 100;
    console.log(formatScl01Line(budget.id, budget.target, budget.unit, p95));
    expect(p95).toBeLessThanOrEqual(budget.target);
  });

  it('50k synthetic fixture: p95 full recompute against the written budget', () => {
    const matches = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS);
    benchOpponentTag = deriveBenchOpponentTag(matches);
    const budget = budgetFor('engine-recompute-p95-50k');
    const p95 = Math.round(measureRecomputeP95Ms(matches) * 100) / 100;
    console.log(formatScl01Line(budget.id, budget.target, budget.unit, p95));
    expect(p95).toBeLessThanOrEqual(budget.target);
  });

  it('8k synthetic fixture: p95 insight scan (account + one character scope) against the appended budget (39.1-21)', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const budget = budgetFor('insight-scan-p95-8k');
    const p95 = Math.round(measureInsightScanP95Ms(matches) * 100) / 100;
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
