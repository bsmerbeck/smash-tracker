import type { Insight } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'mixShift' as const;

// STUB (TDD RED, Task 3): intentionally wrong — always returns no insight.
// Real implementation lands in the GREEN commit.
export const mixShiftTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: false,
  windowExpressible: true,
  build(): Insight[] {
    return [];
  },
};
