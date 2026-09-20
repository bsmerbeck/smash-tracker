import type { InsightTemplate } from './registry.js';
import { characterMoversTemplate } from './characterMovers.js';
import { rivalMoversTemplate } from './rivalMovers.js';
import { lastEventRecapTemplate } from './lastEventRecap.js';
import { bestMatchupTemplate, worstMatchupTemplate } from './bestWorstMatchup.js';
import { matchupOrPlayerTemplate } from './matchupOrPlayer.js';

/**
 * Character/player/stage-scoped templates: the six reads scoped to a
 * fighter, an opponent character, an opponent player, or the last event
 * (plan 39.1-03). The registry composition test (`registry.test.ts`) asserts
 * `INSIGHT_TEMPLATES.length` always equals the union of the four segment
 * arrays, so a template added here cannot be silently orphaned from the
 * composed registry a caller actually iterates.
 */
export const SUBJECT_TEMPLATES: InsightTemplate[] = [
  characterMoversTemplate,
  rivalMoversTemplate,
  lastEventRecapTemplate,
  bestMatchupTemplate,
  worstMatchupTemplate,
  matchupOrPlayerTemplate,
];
