import type { Match } from '../../match.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'rosterShift' as const;

// STUB (TDD RED phase, Task 2): replaced with the real implementation in the
// GREEN commit. Always returns `[]` so `rosterShift.test.ts`'s real
// assertions fail intentionally, on the target behavior, not on an
// import/syntax error.
function buildRosterShiftInsight(_input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  return null;
}

export const rosterShiftTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildRosterShiftInsight(input);
    return insight === null ? [] : [insight];
  },
};
