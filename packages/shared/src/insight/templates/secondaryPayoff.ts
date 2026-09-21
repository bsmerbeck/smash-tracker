import type { Match } from '../../match.js';
import { getFighterById } from '../../fighterData.js';
import { isUnknownCharacter } from '../../evidence/predicate.js';
import { buildRosterModel, type RosterFighterEntry } from './rosterCore.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import { COHORT_MIN_SIDE_GAMES, SUGGESTION_MIN_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'secondaryPayoff' as const;

/** Mirrors `rosterCore.ts`'s identical helper — duplicated locally per this codebase's small-helper-duplication convention. */
function fighterNameFor(id: number): string {
  return getFighterById(id)?.name ?? String(id);
}

/** Mirrors `characterMovers.ts`'s identical helper — duplicated locally per this plan's own per-file convention (no shared grouping helper across template files). */
function groupByOpponentCharacter(matches: Match[]): Map<number, Match[]> {
  const groups = new Map<number, Match[]>();
  for (const match of matches) {
    if (isUnknownCharacter(match)) {
      continue;
    }
    const existing = groups.get(match.opponent_id);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.opponent_id, [match]);
    }
  }
  return groups;
}

interface AssertingCandidate {
  secondary: RosterFighterEntry;
  opponentCharacterId: number;
  secondaryRate: RateValue;
  mainRate: RateValue;
  deltaPoints: number;
}

interface LockedCandidate {
  secondary: RosterFighterEntry;
  opponentCharacterId: number;
  secondaryRate: RateValue;
  gamesNeeded: number;
}

function buildSecondaryPayoffInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  if (scope.kind !== 'account') {
    return null;
  }
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return null;
  }

  const model = buildRosterModel({ matches: scopedMatches });
  if (model.main === null || model.secondaries.length === 0) {
    return null;
  }
  const main = model.main;

  const mainByOpponent = groupByOpponentCharacter(
    scopedMatches.filter((m) => m.fighter_id === main.fighterId),
  );

  const asserting: AssertingCandidate[] = [];
  const locked: LockedCandidate[] = [];

  for (const secondary of model.secondaries) {
    const secondaryMatches = scopedMatches.filter((m) => m.fighter_id === secondary.fighterId);
    const secByOpponent = groupByOpponentCharacter(secondaryMatches);
    for (const [opponentCharacterId, secondaryGroup] of secByOpponent) {
      const mainGroup = mainByOpponent.get(opponentCharacterId);
      if (!mainGroup) {
        // The main has never faced this opponent character — nothing to compare against.
        continue;
      }
      const secondaryRate = toRateValue(secondaryGroup);
      const mainRate = toRateValue(mainGroup);

      if (secondaryRate.total < COHORT_MIN_SIDE_GAMES) {
        locked.push({
          secondary,
          opponentCharacterId,
          secondaryRate,
          gamesNeeded: COHORT_MIN_SIDE_GAMES - secondaryRate.total,
        });
        continue;
      }
      if (mainRate.total < COHORT_MIN_SIDE_GAMES) {
        // Not enough main evidence in this pairing to test notability — silently excluded.
        continue;
      }

      const notable = isNotableCohortGap(
        { wins: secondaryRate.wins, total: secondaryRate.total },
        { wins: mainRate.wins, total: mainRate.total },
      );
      if (notable && secondaryRate.rate > mainRate.rate) {
        asserting.push({
          secondary,
          opponentCharacterId,
          secondaryRate,
          mainRate,
          deltaPoints: Math.round((secondaryRate.rate - mainRate.rate) * 100),
        });
      }
    }
  }

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  if (asserting.length > 0) {
    const headline = [...asserting].sort(
      (a, b) =>
        b.deltaPoints - a.deltaPoints ||
        a.secondary.fighterId - b.secondary.fighterId ||
        a.opponentCharacterId - b.opponentCharacterId,
    )[0]!;
    const state: Insight['state'] =
      headline.secondaryRate.total >= SUGGESTION_MIN_GAMES ? 'suggestion' : 'trend';
    const kind: Insight['kind'] = state === 'suggestion' ? 'recommendation' : 'inference';
    const recentClaim = buildRateClaim({
      rate: headline.secondaryRate,
      refreshedAt: nowMs,
      dateRange: matchDateRange(
        scopedMatches.filter(
          (m) =>
            m.fighter_id === headline.secondary.fighterId &&
            m.opponent_id === headline.opponentCharacterId,
        ),
      ),
    });
    const baselineClaim = buildRateClaim({
      rate: headline.mainRate,
      refreshedAt: nowMs,
      dateRange: matchDateRange(
        scopedMatches.filter(
          (m) => m.fighter_id === main.fighterId && m.opponent_id === headline.opponentCharacterId,
        ),
      ),
    });
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind,
      state,
      recent: recentClaim,
      baseline: baselineClaim,
      deltaPoints: headline.deltaPoints,
      window: {
        horizon,
        fromMs: null,
        toMs: null,
        games: headline.secondaryRate.total,
        scoped: false,
      },
      salience: 0,
      copy: {
        key: `insights.${TEMPLATE_ID}.${state}`,
        values: {
          opponent: fighterNameFor(headline.opponentCharacterId),
          secondary: fighterNameFor(headline.secondary.fighterId),
          main: fighterNameFor(main.fighterId),
          secondaryRate: Math.round(headline.secondaryRate.rate * 100),
          mainRate: Math.round(headline.mainRate.rate * 100),
          points: headline.deltaPoints,
        },
      },
      // §13.13a's rejected-DD-09-branch fallback: not window-expressible, so
      // the "Open matchup" route door instead of a counted games door.
      doors: [
        {
          kind: 'matchup',
          axes: {
            ...(scope.axes ?? {}),
            fighter: headline.secondary.fighterId,
            vs: headline.opponentCharacterId,
          },
          count: headline.secondaryRate.total,
        },
      ],
    };
  }

  if (locked.length > 0) {
    const headline = [...locked].sort(
      (a, b) =>
        a.gamesNeeded - b.gamesNeeded ||
        a.secondary.fighterId - b.secondary.fighterId ||
        a.opponentCharacterId - b.opponentCharacterId,
    )[0]!;
    const claim = buildRateClaim({
      rate: headline.secondaryRate,
      refreshedAt: nowMs,
      dateRange: matchDateRange(
        scopedMatches.filter(
          (m) =>
            m.fighter_id === headline.secondary.fighterId &&
            m.opponent_id === headline.opponentCharacterId,
        ),
      ),
    });
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind: 'fact',
      state: 'locked',
      recent: claim,
      baseline: claim,
      deltaPoints: null,
      window: {
        horizon,
        fromMs: null,
        toMs: null,
        games: headline.secondaryRate.total,
        scoped: false,
      },
      salience: 0,
      copy: {
        key: `insights.${TEMPLATE_ID}.locked`,
        values: {
          opponent: fighterNameFor(headline.opponentCharacterId),
          secondary: fighterNameFor(headline.secondary.fighterId),
          count: headline.gamesNeeded,
        },
      },
      doors: [],
      gamesNeeded: headline.gamesNeeded,
    };
  }

  // Nothing asserting, nothing locked: no pairing where a secondary notably
  // beats the main (UI-SPEC §9.4's "Secondaries — no matchup where a
  // secondary notably beats the main.").
  const pooledSecondaryMatches = scopedMatches.filter((m) =>
    model.secondaries.some((s) => s.fighterId === m.fighter_id),
  );
  const steadyClaim = buildRateClaim({
    rate: toRateValue(pooledSecondaryMatches),
    refreshedAt: nowMs,
    dateRange: matchDateRange(pooledSecondaryMatches),
  });
  const mainClaim = buildRateClaim({
    rate: main.rate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(scopedMatches.filter((m) => m.fighter_id === main.fighterId)),
  });
  return {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind: 'fact',
    state: 'steady',
    recent: steadyClaim,
    baseline: mainClaim,
    deltaPoints: null,
    window: { horizon, fromMs: null, toMs: null, games: 0, scoped: false },
    salience: 0,
    copy: { key: `insights.${TEMPLATE_ID}.steady`, values: {} },
    doors: [],
  };
}

/**
 * `SecondaryPayoff` (INS-05, DD-12, UI-SPEC §9.4): for each (opponent
 * character) pairing where both the main and a roster-established secondary
 * have games, compares the secondary's rate against the main's through
 * `isNotableCohortGap`. Notable + high tier -> Suggestion; notable ->
 * Trend; otherwise steady. Below `COHORT_MIN_SIDE_GAMES` on the secondary ->
 * locked with games needed. `windowExpressible: false`: the pairing is a
 * cross-selection (one secondary vs. one opponent character), not a
 * contiguous window; its fallback door is the matchup route (§13.13a).
 */
export const secondaryPayoffTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildSecondaryPayoffInsight(input);
    return insight === null ? [] : [insight];
  },
};
