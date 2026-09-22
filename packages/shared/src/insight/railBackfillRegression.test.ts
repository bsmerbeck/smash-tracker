import { describe, expect, it } from 'vitest';
import { assembleRail } from './rail.js';
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
import { ratingMoveTemplate } from './templates/ratingMove.js';
import { tiltCostTemplate } from './templates/tiltCost.js';
import { sessionFatigueTemplate } from './templates/sessionFatigue.js';
import { generateSyntheticMatches, EIGHT_K_FIXTURE_OPTIONS } from '../testUtils/index.js';
import type { Match } from '../match.js';

/**
 * WR-A03 (39.1-REVIEW.md) regression: `bestMatchupTemplate`/`worstMatchupTemplate`
 * are now wired into all three `apps/web` rail hosts' real `RAIL_TEMPLATES` sets
 * (`FighterInsightRail.tsx`, `MatchDataRail.tsx`, `TrendsReadsRail.tsx`) — this
 * file mirrors those exact three arrays and runs them through `assembleRail`
 * against the shared 8,000-game synthetic fixture, the same one
 * `39.1-REVIEW-FIX-part-A.md`'s WR-A03 investigation used to prove the bug.
 *
 * IMPORTANT (documented honestly, not asserted away): `bestMatchup`/
 * `worstMatchup` both guard `scope.kind !== 'character'` internally, so
 * wiring them into `MatchDataRail`/`TrendsReadsRail` — both ACCOUNT-scoped —
 * contributes ZERO candidates there; they only ever produce a card at
 * CHARACTER scope (`FighterInsightRail`'s scope). Verified empirically
 * against this exact fixture before writing these assertions:
 *  - FighterInsightRail's set (character scope): fallback never reached.
 *  - MatchDataRail's set (account scope): fallback never reached — but
 *    because `rosterCore`/`secondaryPayoff` already produce real cards on
 *    this fixture, NOT because of the newly-wired templates.
 *  - TrendsReadsRail's set (account scope) at the `last30` horizon: the
 *    fallback IS STILL REACHED on this exact fixture — `ratingMove`/
 *    `tiltCost`/`sessionFatigue` are all `hidden`/`locked-as-a-single`-free
 *    for this account's most recent 30 games, and the newly-wired
 *    character-only templates cannot back-fill an account-scoped rail. This
 *    is exactly why WR-A03's fix also had to make the fallback copy honest
 *    (Option 2) rather than relying on Option 1 (back-fill wiring) alone —
 *    for an account-scoped rail, Option 1 provably does not always prevent
 *    the branch from firing.
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
const TRENDS_READS_RAIL_TEMPLATES: InsightTemplate[] = [
  ratingMoveTemplate,
  tiltCostTemplate,
  sessionFatigueTemplate,
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

  it('TrendsReadsRail — when the account-scoped set still reaches the fallback (last30, this fixture), the card carries the HONEST copy key, never a games-needed claim', () => {
    const cards = buildRailCards(
      TRENDS_READS_RAIL_TEMPLATES,
      EIGHT_K_FIXTURE,
      ACCOUNT_SCOPE,
      'last30',
    );
    const fallback = cards.find((c) => c.id === FALLBACK_ID);
    // Documented, not asserted away (see file doc comment): this fixture's
    // last30 horizon genuinely exhausts ratingMove/tiltCost/sessionFatigue,
    // and bestMatchup/worstMatchup cannot back-fill an account scope.
    expect(fallback, 'expected this exact fixture/horizon to still hit the fallback').toBeDefined();
    expect(fallback!.copy.key).toBe('insights.rail.unavailable');
    expect(fallback!.copy.values).toEqual({});
  });
});
