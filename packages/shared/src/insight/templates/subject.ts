import type { InsightTemplate } from './registry.js';

/**
 * Character/player/stage-scoped templates (`characterMovers`, `rivalMovers`,
 * `matchupOrPlayer`, …) — empty in this plan. Filled by plan 39.1-03. The
 * registry composition test (`registry.test.ts`) asserts
 * `INSIGHT_TEMPLATES.length` always equals the union of the four segment
 * arrays, so a template added here later cannot be silently orphaned from
 * the composed registry a caller actually iterates.
 */
export const SUBJECT_TEMPLATES: InsightTemplate[] = [];
