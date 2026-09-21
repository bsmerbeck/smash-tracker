import type { InsightTemplate } from './registry.js';
import { rosterCoreTemplate } from './rosterCore.js';
import { rosterShiftTemplate } from './rosterShift.js';
import { secondaryPayoffTemplate } from './secondaryPayoff.js';
import { pocketCostTemplate } from './pocketCost.js';

/**
 * Roster-composition templates (UI-SPEC §8.4's Match Data roster model):
 * `rosterCore`, `rosterShift`, `secondaryPayoff`, `pocketCost` — the full,
 * closed four-template segment (plan 39.1-05). The registry composition test
 * (`registry.test.ts`) asserts `INSIGHT_TEMPLATES.length` always equals the
 * union of the four segment arrays, so a template added here cannot be
 * silently orphaned from the composed registry a caller actually iterates.
 */
export const ROSTER_TEMPLATES: InsightTemplate[] = [
  rosterCoreTemplate,
  rosterShiftTemplate,
  secondaryPayoffTemplate,
  pocketCostTemplate,
];
