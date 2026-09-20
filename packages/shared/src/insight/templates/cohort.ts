import type { InsightTemplate } from './registry.js';
import { tiltCostTemplate } from './tiltCost.js';

/**
 * Cohort-comparison templates (DD-12's two-proportion / RD-band reads):
 * `tiltCost`, `sessionFatigue`, `settingGap`, `ratingMove`, `volumeForm`,
 * `mixShift` — filled by plan 39.1-04 (this plan). The registry composition
 * test (`registry.test.ts`) asserts `INSIGHT_TEMPLATES.length` always equals
 * the union of the four segment arrays, so a template added here can never be
 * silently orphaned from the composed registry a caller actually iterates.
 */
export const COHORT_TEMPLATES: InsightTemplate[] = [tiltCostTemplate];
