import type { Match } from '../match.js';
import { RAIL_CARD_CAP } from './policy.js';
import { assembleRail, type AssembleRailResult } from './rail.js';
import { ACCOUNT_SCOPE } from './types.js';
import type { HorizonKey, Insight, InsightTemplateId } from './types.js';
import type { InsightTemplate } from './templates/registry.js';
import { ratingMoveTemplate } from './templates/ratingMove.js';
import { tiltCostTemplate } from './templates/tiltCost.js';
import { sessionFatigueTemplate } from './templates/sessionFatigue.js';
import { buildMatchupBackfillInsights } from './templates/bestWorstMatchup.js';
import { buildLastEventRecapInsight } from './templates/lastEventRecap.js';

/**
 * Plan 39.1-40 — the Trends reads rail's ONE derivation (INS-01, 36 D-12):
 * which reads it owns, which FACT results back-fill it, and how the two are
 * assembled. `TrendsReadsRail` ranks, sorts and back-fills nothing itself.
 *
 * - Own reads (TRND-02, D-09): RatingMove, TiltCost, SessionFatigue at
 *   whole-account scope. Their steady / thinRecent results stay lines under
 *   the cards and never take a slot (UI-SPEC §7.8 rule 4, D-14's
 *   parenthetical).
 * - Back-fill (D-14, UI-SPEC §7.8 rules 1-3): Best record and Toughest record
 *   (account scope, Wilson-bound ranking, never the same opponent twice) and
 *   LastEventRecap (no registry row — DD-02's W-L-only degrade; hidden when
 *   the account has no named event). Direction-free facts, deltaPoints null.
 * - Fill rule (D-07, UI-SPEC §8.2 thin account): the back-fill fills free
 *   slots only when the own reads hold NO locked candidate — a locked read
 *   means a thin account or an empty recent window, which keeps its
 *   UnlocksNext lead instead of padding. Own reads always rank first.
 *
 * Account scope has no D-15 recency bound (D-15 applies to narrow scopes
 * only). Pure: no clock, no randomness, no console.
 */

/** The Trends rail's own reads, in the order the host builds them. */
export const TRENDS_READ_TEMPLATES: readonly InsightTemplate[] = [
  ratingMoveTemplate,
  tiltCostTemplate,
  sessionFatigueTemplate,
];

/** The template ids `buildTrendsBackfillInsights` produces — the back-fill part of the one insights array. */
export const TRENDS_BACKFILL_TEMPLATE_IDS: ReadonlySet<InsightTemplateId> =
  new Set<InsightTemplateId>(['bestMatchup', 'worstMatchup', 'lastEventRecap']);

/** The account-scope D-14 FACT back-fill: Best / Toughest record, then LastEventRecap. */
export function buildTrendsBackfillInsights(input: {
  matches: Match[];
  horizon: HorizonKey;
  nowMs: number;
}): Insight[] {
  const { matches, horizon, nowMs } = input;
  return [
    ...buildMatchupBackfillInsights({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs }),
    buildLastEventRecapInsight({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs }),
  ];
}

/**
 * Partitions the host's ONE insights array (own reads + back-fill, already
 * salience-scored and dismissal-filtered) by `TRENDS_BACKFILL_TEMPLATE_IDS`
 * and assembles it — the back-fill part goes through the rail assembler's
 * `backfill` input, so own reads always rank first and a locked own read is
 * never padded.
 */
export function assembleTrendsRail(input: {
  insights: Insight[];
  cap?: number;
}): AssembleRailResult {
  const { insights, cap = RAIL_CARD_CAP } = input;
  const own: Insight[] = [];
  const backfill: Insight[] = [];
  for (const insight of insights) {
    if (TRENDS_BACKFILL_TEMPLATE_IDS.has(insight.templateId)) {
      backfill.push(insight);
    } else {
      own.push(insight);
    }
  }
  return assembleRail({ insights: own, cap, backfill });
}
