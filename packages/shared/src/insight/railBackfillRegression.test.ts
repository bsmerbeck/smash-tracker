import { describe, expect, it } from 'vitest';
import { assembleRail, isRailFallbackInsight } from './rail.js';
import {
  TRENDS_READ_TEMPLATES,
  assembleTrendsRail,
  buildTrendsBackfillInsights,
} from './trendsReads.js';
import { ACCOUNT_SCOPE } from './types.js';
import type { HorizonKey, Insight, InsightScope } from './types.js';
import type { InsightTemplate } from './templates/registry.js';
import { characterMoversTemplate } from './templates/characterMovers.js';
import { rivalMoversTemplate } from './templates/rivalMovers.js';
import { lastEventRecapTemplate } from './templates/lastEventRecap.js';
import { bestMatchupTemplate, worstMatchupTemplate } from './templates/bestWorstMatchup.js';
import { rosterCoreTemplate } from './templates/rosterCore.js';
import { rosterShiftTemplate } from './templates/rosterShift.js';
import { secondaryPayoffTemplate } from './templates/secondaryPayoff.js';
import { pocketCostTemplate } from './templates/pocketCost.js';
import { generateSyntheticMatches, EIGHT_K_FIXTURE_OPTIONS } from '../testUtils/index.js';
import type { Match } from '../match.js';

/**
 * WR-A03 (39.1-REVIEW.md) regression, updated by plan 39.1-40 (D-14): every
 * rail host's real template set, run through the engine's rail assembler
 * against the shared 8,000-game synthetic fixture — the one
 * `39.1-REVIEW-FIX-part-A.md`'s WR-A03 investigation used to prove the bug.
 *
 * - FighterInsightRail's set (character scope) and MatchDataRail's set
 *   (account scope) are mirrored here by hand, as before. `bestMatchup` /
 *   `worstMatchup` still guard `scope.kind !== 'character'`, so Match Data's
 *   account-scoped entries stay inert (documented, unchanged by 39.1-40);
 *   its rail avoids the fallback through `rosterCore` / `secondaryPayoff`.
 * - The Trends reads rail is no longer a hand-mirrored array: it builds its
 *   set from `trendsReads.ts` — `TRENDS_READ_TEMPLATES` (its own reads) plus
 *   `buildTrendsBackfillInsights` (the account-scope Best / Toughest record
 *   and LastEventRecap FACT back-fill) through `assembleTrendsRail`. Before
 *   39.1-40 this account-scoped rail reached the synthetic fallback on this
 *   fixture at `last30` (every own read steady, the character-only matchup
 *   templates inert); with the account-scope back-fill it no longer does.
 */

const EIGHT_K_FIXTURE = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);

/** Mirrors `evidence.bench.ts`'s `mainCharacterScope` helper — the largest single-fighter scope in a fixture, i.e. exactly the "large, steady main" scenario WR-A03 describes. */
function mainCharacterScope(matches: Match[]): InsightScope {
  const counts = new Map<number, number>();
  for (const match of matches) {
    counts.set(match.fighter_id, (counts.get(match.fighter_id) ?? 0) + 1);
  }
  let bestFighterId = -1;
  let bestCount = -1;
  for (const [fighterId, count] of counts) {
    if (count > bestCount) {
      bestFighterId = fighterId;
      bestCount = count;
    }
  }
  return {
    kind: 'character',
    key: `character:${bestFighterId}`,
    axes: { fighter: bestFighterId },
    filter: (ms) => ms.filter((m) => m.fighter_id === bestFighterId),
  };
}

const CHARACTER_SCOPE = mainCharacterScope(EIGHT_K_FIXTURE);

/** The exact three `RAIL_TEMPLATES` arrays post-WR-A03 (kept in lockstep with the apps/web hosts by naming — a drift here should prompt updating both). */
const FIGHTER_INSIGHT_RAIL_TEMPLATES: InsightTemplate[] = [
  characterMoversTemplate,
  rivalMoversTemplate,
  lastEventRecapTemplate,
  bestMatchupTemplate,
  worstMatchupTemplate,
];
const MATCH_DATA_RAIL_TEMPLATES: InsightTemplate[] = [
  rosterCoreTemplate,
  rosterShiftTemplate,
  secondaryPayoffTemplate,
  pocketCostTemplate,
  bestMatchupTemplate,
  worstMatchupTemplate,
];
function buildRailCards(
  templates: InsightTemplate[],
  matches: Match[],
  scope: InsightScope,
  horizon: HorizonKey,
): Insight[] {
  const nowMs = Date.now();
  const insights: Insight[] = [];
  for (const template of templates) {
    const results = template.build({ matches, scope, horizon, nowMs });
    insights.push(...results);
  }
  return assembleRail({ insights }).cards;
}

const FALLBACK_ID = 'formNow:account:last30';

describe('WR-A03: rail back-fill on a real 8k-game fixture', () => {
  it('FighterInsightRail — a large, steady character scope never reaches the synthetic fallback', () => {
    for (const horizon of ['last30', 'lastEvent', 'last90'] as const) {
      const cards = buildRailCards(
        FIGHTER_INSIGHT_RAIL_TEMPLATES,
        EIGHT_K_FIXTURE,
        CHARACTER_SCOPE,
        horizon,
      );
      expect(
        cards.some((c) => c.id === FALLBACK_ID),
        `horizon ${horizon}`,
      ).toBe(false);
    }
  });

  it('MatchDataRail — the whole-account roster set never reaches the synthetic fallback', () => {
    for (const horizon of ['last30', 'lastEvent', 'last90'] as const) {
      const cards = buildRailCards(
        MATCH_DATA_RAIL_TEMPLATES,
        EIGHT_K_FIXTURE,
        ACCOUNT_SCOPE,
        horizon,
      );
      expect(
        cards.some((c) => c.id === FALLBACK_ID),
        `horizon ${horizon}`,
      ).toBe(false);
    }
  });

  it('TrendsReadsRail — the account-scoped own reads + engine back-fill never reach the synthetic fallback (8k, last30), with at least 2 cards', () => {
    const nowMs = Date.now();
    const own = TRENDS_READ_TEMPLATES.flatMap((template) =>
      template.build({ matches: EIGHT_K_FIXTURE, scope: ACCOUNT_SCOPE, horizon: 'last30', nowMs }),
    );
    const backfill = buildTrendsBackfillInsights({
      matches: EIGHT_K_FIXTURE,
      horizon: 'last30',
      nowMs,
    });
    const { cards } = assembleTrendsRail({ insights: [...own, ...backfill] });
    expect(cards.some((c) => c.id === FALLBACK_ID)).toBe(false);
    expect(cards.some((c) => isRailFallbackInsight(c))).toBe(false);
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });
});
