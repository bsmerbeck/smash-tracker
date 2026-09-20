import type { Insight } from '../types.js';
import type { InsightTemplate } from './registry.js';

// RED stub (Task 2, tdd="true"): intentionally returns nothing so the RED test run fails on
// real assertions about rivalMoversTemplate's behavior, not on an import/syntax error.
export const rivalMoversTemplate: InsightTemplate = {
  id: 'rivalMovers',
  scopeKind: 'character',
  assertsDirection: true,
  windowExpressible: true,
  build(): Insight[] {
    return [];
  },
};
