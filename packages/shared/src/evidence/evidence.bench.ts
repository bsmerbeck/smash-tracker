import { bench, describe } from 'vitest';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';
import { buildStageEvidence } from './stageEvidence.js';
import { buildMatchupEvidence } from './matchupEvidence.js';

/**
 * Human-readable companion bench for the SCL-01 engine-compute budget
 * (D-19). Asserts NOTHING — `computeBudget.budget.test.ts` is the oracle.
 * This file exists only to give the readout a readable ops/sec figure
 * alongside the pass/miss verdicts. Never added to any default test run
 * (vitest's `bench` files are opt-in via `vitest bench`, not `vitest run`).
 */

const eightK = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
const fiftyK = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS);

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
});
