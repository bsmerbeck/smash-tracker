import type { Insight } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'ratingMove' as const;

// STUB (TDD RED, Task 2): intentionally wrong — always returns no insight,
// and the RD-band rule always reports "not notable". Real implementation
// lands in the GREEN commit.
export function isNotableRatingMove(_deltaRating: number, _currentRd: number): boolean {
  return false;
}

export const ratingMoveTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(): Insight[] {
    return [];
  },
};
