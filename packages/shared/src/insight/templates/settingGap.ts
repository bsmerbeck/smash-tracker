import type { Insight } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'settingGap' as const;

// STUB (TDD RED, Task 2): intentionally wrong — always returns no insight.
// Real implementation lands in the GREEN commit.
export const settingGapTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(): Insight[] {
    return [];
  },
};
