import type { Insight } from '../types.js';
import type { InsightTemplate } from './registry.js';

// RED stub (Task 3, tdd="true"): intentionally returns nothing so the RED test run fails on
// real assertions, not an import/syntax error.
export const bestMatchupTemplate: InsightTemplate = {
  id: 'bestMatchup',
  scopeKind: 'character',
  assertsDirection: false,
  windowExpressible: true,
  build(): Insight[] {
    return [];
  },
};

export const worstMatchupTemplate: InsightTemplate = {
  id: 'worstMatchup',
  scopeKind: 'character',
  assertsDirection: false,
  windowExpressible: true,
  build(): Insight[] {
    return [];
  },
};
