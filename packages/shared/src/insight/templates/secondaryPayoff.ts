import type { Match } from '../../match.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'secondaryPayoff' as const;

// STUB (TDD RED phase, Task 2): replaced with the real implementation in the
// GREEN commit. Always returns `[]` so `secondaryPayoff.test.ts`'s real
// assertions fail intentionally, on the target behavior, not on an
// import/syntax error.
function buildSecondaryPayoffInsight(_input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  return null;
}

export const secondaryPayoffTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildSecondaryPayoffInsight(input);
    return insight === null ? [] : [insight];
  },
};
