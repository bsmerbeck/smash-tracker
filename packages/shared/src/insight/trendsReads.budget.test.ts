import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { generateSyntheticMatches, EIGHT_K_FIXTURE_OPTIONS } from '../testUtils/index.js';
import { computeInsights } from './engine.js';
import { ACCOUNT_SCOPE } from './types.js';
import type { InsightScope } from './types.js';
import { assembleTrendsRail, buildTrendsBackfillInsights } from './trendsReads.js';
import {
  SCL_01_BUDGETS,
  BUDGET_SAMPLE_ITERATIONS,
  percentileNearestRank,
  formatScl01Line,
  type Scl01Budget,
} from '../evidence/budgets.js';

/**
 * Plan 39.1-40 (T-39.1-40-05, SCL-01): the insight scan the Trends page now
 * pays, measured against the REGISTERED `insight-scan-p95-8k` target — the
 * existing account + main-character `computeInsights` scan (the shape
 * `evidence/computeBudget.budget.test.ts` times) PLUS the account-scope
 * back-fill (`buildTrendsBackfillInsights`) and its rail assembly
 * (`assembleTrendsRail`) at `last30`. No new budget id is registered.
 *
 * Lives under `insight/` (not `evidence/`): the evidence directory belongs to
 * the concurrent Phase 39 executor and is only imported from here, never
 * edited. Picked up by `vitest.budget.config.ts`'s `src/**\/*.budget.test.ts`
 * include and excluded from the default run like every other budget file.
 */

function budgetFor(id: string): Scl01Budget {
  const budget = SCL_01_BUDGETS.find((b) => b.id === id);
  if (!budget) {
    throw new Error(`missing SCL-01 budget: ${id}`);
  }
  return budget;
}

/** The main fighter (most games) in a fixture — mirrors the evidence budget test's helper. */
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

/** One scan: the existing account + character insight scan, then the Trends back-fill and rail. */
function scanWithTrendsBackfill(matches: Match[], characterScope: InsightScope): number {
  const nowMs = Date.now();
  const insights = computeInsights({
    matches,
    scopes: [ACCOUNT_SCOPE, characterScope],
    horizon: 'last30',
    nowMs,
  });
  const backfill = buildTrendsBackfillInsights({ matches, horizon: 'last30', nowMs });
  const rail = assembleTrendsRail({ insights: [...insights, ...backfill] });
  return rail.cards.length;
}

describe('SCL-01 insight-scan incl. Trends back-fill (39.1-40)', () => {
  it('8k synthetic fixture: p95 insight-scan incl. Trends back-fill against the registered insight-scan-p95-8k budget', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const characterScope = mainCharacterScope(matches);
    // Warm up once — excluded from the sample. The rail must be non-empty, so
    // the timed path is the real one.
    expect(scanWithTrendsBackfill(matches, characterScope)).toBeGreaterThan(0);
    const samplesMs: number[] = [];
    for (let i = 0; i < BUDGET_SAMPLE_ITERATIONS; i += 1) {
      const start = performance.now();
      scanWithTrendsBackfill(matches, characterScope);
      samplesMs.push(performance.now() - start);
    }
    samplesMs.sort((a, b) => a - b);
    const budget = budgetFor('insight-scan-p95-8k');
    const p95 = Math.round(percentileNearestRank(samplesMs, 95) * 100) / 100;
    console.log(formatScl01Line(budget.id, budget.target, budget.unit, p95));
    expect(p95).toBeLessThanOrEqual(budget.target);
  });
});
