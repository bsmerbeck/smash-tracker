import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '@smash-tracker/shared/testUtils';
import { SCL_01_BUDGETS, formatScl01Line, type Scl01Budget } from '@smash-tracker/shared';
import type { Match } from '@smash-tracker/shared';
import { buildTestApp, authHeader, TEST_UID } from '../test-support/testApp.js';

/**
 * SCL-01 `/api/matches` gzip-payload budget command (D-19, D-26). Excluded
 * from the default test run (`*.budget.test.ts` in `vitest.config.ts`'s
 * `exclude`); run only via `pnpm --filter @smash-tracker/api budget`.
 *
 * ORACLE property vs. TASK completion gate (R1-HIGH-4): see the identical
 * note in `computeBudget.budget.test.ts` — this file's job is to measure and
 * print, not to guarantee a PASS.
 */

function budgetFor(id: string): Scl01Budget {
  const budget = SCL_01_BUDGETS.find((b) => b.id === id);
  if (!budget) {
    throw new Error(`missing SCL-01 budget: ${id}`);
  }
  return budget;
}

function seedMatches(
  database: ReturnType<typeof buildTestApp>['database'],
  matches: Match[],
): void {
  const seeded = Object.fromEntries(matches.map((match, index) => [`synth${index}`, match]));
  database.seed(`matches/${TEST_UID}`, seeded);
}

describe('SCL-01 /api/matches gzip payload budget', () => {
  it('8k synthetic fixture: gzip(JSON) size against the written budget', async () => {
    const { app, database } = buildTestApp();
    seedMatches(database, generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS));

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);

    const gzipped = gzipSync(response.rawPayload);
    const budget = budgetFor('matches-gzip-payload-8k');
    console.log(formatScl01Line(budget.id, budget.target, budget.unit, gzipped.length));
    expect(gzipped.length).toBeLessThanOrEqual(budget.target);
  });

  it('50k synthetic fixture: gzip(JSON) size recorded for information (no written 50k payload budget)', async () => {
    const { app, database } = buildTestApp();
    seedMatches(database, generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS));

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);

    const gzipped = gzipSync(response.rawPayload);
    console.log(
      `SCL-01 matches-gzip-payload-50k-informational target=n/a measured=${gzipped.length}bytes verdict=INFO`,
    );
    expect(gzipped.length).toBeGreaterThan(0);
  });
});
