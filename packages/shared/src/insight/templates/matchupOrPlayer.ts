import type { Insight } from '../types.js';
import type { InsightTemplate } from './registry.js';

// RED stub (Task 3, tdd="true"): intentionally returns nothing so the RED test run fails on
// real assertions, not an import/syntax error.
export const matchupOrPlayerTemplate: InsightTemplate = {
  id: 'matchupOrPlayer',
  scopeKind: 'character',
  assertsDirection: true,
  windowExpressible: false,
  build(): Insight[] {
    return [];
  },
};
