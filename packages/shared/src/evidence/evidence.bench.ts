import { bench, describe } from 'vitest';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';
import { buildStageEvidence } from './stageEvidence.js';
import { buildMatchupEvidence } from './matchupEvidence.js';
import { computeInsights, ACCOUNT_SCOPE } from '../insight/index.js';
import type { InsightScope } from '../insight/types.js';
import type { Match } from '../match.js';

/**
 * Human-readable companion bench for the SCL-01 engine-compute budget
 * (D-19). Asserts NOTHING — `computeBudget.budget.test.ts` is the oracle.
 * This file exists only to give the readout a readable ops/sec figure
 * alongside the pass/miss verdicts. Never added to any default test run
 * (vitest's `bench` files are opt-in via `vitest bench`, not `vitest run`).
 */

const eightK = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
const fiftyK = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS);

/** The main fighter (most games) in a fixture — a real, non-trivial character scope. */
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

const eightKCharacterScope = mainCharacterScope(eightK);

describe('SCL-01 engine full recompute (readable bench, not the oracle)', () => {
  bench('8k games: buildStageEvidence + buildMatchupEvidence', () => {
    const refreshedAt = Date.now();
    buildStageEvidence({ matches: eightK, refreshedAt });
    buildMatchupEvidence({ matches: eightK, refreshedAt });
  });

  bench('50k games: buildStageEvidence + buildMatchupEvidence', () => {
    const refreshedAt = Date.now();
    buildStageEvidence({ matches: fiftyK, refreshedAt });
    buildMatchupEvidence({ matches: fiftyK, refreshedAt });
  });

  /**
   * Plan 39.1-21 Task 2: the insight engine's own scan, alongside the two
   * evidence-engine cases above — `computeBudget.budget.test.ts`'s
   * `insight-scan-p95-8k` case is the asserting oracle for this same call
   * shape (account scope + one character scope, `last30` horizon).
   */
  bench('8k games: computeInsights (account + one character scope)', () => {
    computeInsights({
      matches: eightK,
      scopes: [ACCOUNT_SCOPE, eightKCharacterScope],
      horizon: 'last30',
      nowMs: Date.now(),
    });
  });
});
