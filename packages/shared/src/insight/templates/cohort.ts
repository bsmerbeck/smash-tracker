import type { InsightTemplate } from './registry.js';
import { tiltCostTemplate } from './tiltCost.js';
import { sessionFatigueTemplate } from './sessionFatigue.js';
import { settingGapTemplate } from './settingGap.js';
import { ratingMoveTemplate } from './ratingMove.js';
import { volumeFormTemplate } from './volumeForm.js';
import { mixShiftTemplate } from './mixShift.js';
import { tierGapTemplate } from './tierGap.js';
import { playRhythmTemplate } from './playRhythm.js';

/**
 * Cohort-comparison templates (DD-12's two-proportion / RD-band reads):
 * `tiltCost`, `sessionFatigue`, `settingGap`, `ratingMove`, `volumeForm`,
 * `mixShift` — filled by plan 39.1-04 — plus `tierGap` (Phase 39.2, TIER-03),
 * the Tournaments page's tier read, and `playRhythm` (Phase 41, DD-41-07), the Trends play-rhythm read. The registry composition
 * test (`registry.test.ts`) asserts `INSIGHT_TEMPLATES.length` always equals
 * the union of the four segment arrays, so a template added here can never be
 * silently orphaned from the composed registry a caller actually iterates.
 */
export const COHORT_TEMPLATES: InsightTemplate[] = [
  tiltCostTemplate,
  sessionFatigueTemplate,
  settingGapTemplate,
  ratingMoveTemplate,
  volumeFormTemplate,
  mixShiftTemplate,
  tierGapTemplate,
  playRhythmTemplate,
];
