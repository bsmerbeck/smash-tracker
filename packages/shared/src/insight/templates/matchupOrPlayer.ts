import type { Match } from '../../match.js';
import { resolveOpponentIdentities } from '../../evidence/opponentEvidence.js';
import { SUGGESTION_MIN_GAMES, TREND_MIN_RECENT_GAMES } from '../policy.js';
import { wilsonInterval } from '../wilsonInterval.js';
import { matchDateRange, buildRateClaim } from '../horizon.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'matchupOrPlayer' as const;

/**
 * Review finding C1-L4: cohort GEOMETRY, not a notability threshold — "how many distinct
 * opponents must exist before a player-vs-matchup split is even askable" is a structural
 * question about the shape of the pairing's data, never a Wilson-tier/abstention-floor decision.
 * Every NOTABILITY decision this template makes still comes from `insight/policy.ts`
 * (`SUGGESTION_MIN_GAMES`); this is the one exception, declared here with the same doc-comment
 * discipline plans 39.1-04/39.1-05 use for their own local geometry constants.
 */
const MATCHUP_OR_PLAYER_MIN_DISTINCT_OPPONENTS = 3;

function buildHiddenInsight(scope: InsightScope, horizon: HorizonKey, nowMs: number): Insight {
  const emptyRate: RateValue = { wins: 0, losses: 0, total: 0, rate: 0 };
  const claim = buildRateClaim({
    rate: emptyRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: null, toMs: null },
  });
  return {
    id: `${TEMPLATE_ID}:${scope.key}:${horizon}`,
    templateId: TEMPLATE_ID,
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state: 'hidden',
    recent: claim,
    baseline: claim,
    deltaPoints: null,
    window: { horizon, fromMs: null, toMs: null, games: 0, scoped: false },
    salience: 0,
    copy: { key: `insights.${TEMPLATE_ID}.hidden`, values: {} },
    doors: [],
  };
}

function buildMatchupOrPlayerInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  if (scope.kind !== 'character') {
    return null;
  }
  const pairingMatches = scope.filter(matches);
  if (pairingMatches.length === 0) {
    return null;
  }

  const resolve = resolveOpponentIdentities(pairingMatches, {});
  const byIdentity = new Map<string, Match[]>();
  for (const match of pairingMatches) {
    const identity = resolve(match);
    if (identity === 'unknown' || identity.startsWith('sgg:') || identity.startsWith('pgg:')) {
      continue;
    }
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.push(match);
    } else {
      byIdentity.set(identity, [match]);
    }
  }
  const distinctOpponents = byIdentity.size;
  const total = pairingMatches.length;

  if (
    total < SUGGESTION_MIN_GAMES ||
    distinctOpponents < MATCHUP_OR_PLAYER_MIN_DISTINCT_OPPONENTS
  ) {
    return buildHiddenInsight(scope, horizon, nowMs);
  }

  const losses = pairingMatches.filter((m) => !m.win);
  const lossesByIdentity = new Map<string, number>();
  for (const match of losses) {
    const identity = resolve(match);
    // Review finding CR-A04: apply the SAME exclusion `byIdentity` above
    // already uses — an untagged manual game ('unknown') or a raw
    // start.gg/parry.gg machine key with no bound human tag must never
    // become `topIdentity` (and therefore never `{{opponent}}` in the
    // rendered sentence).
    if (identity === 'unknown' || identity.startsWith('sgg:') || identity.startsWith('pgg:')) {
      continue;
    }
    lossesByIdentity.set(identity, (lossesByIdentity.get(identity) ?? 0) + 1);
  }

  let topIdentity: string | null = null;
  let topLossCount = -1;
  for (const [identity, count] of [...lossesByIdentity.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (count > topLossCount) {
      topIdentity = identity;
      topLossCount = count;
    }
  }

  const rate = buildRateClaim({
    rate: {
      wins: pairingMatches.length - losses.length,
      losses: losses.length,
      total,
      rate: (total - losses.length) / total,
    },
    refreshedAt: nowMs,
    dateRange: matchDateRange(pairingMatches),
  });

  const commonFields = {
    id: `${TEMPLATE_ID}:${scope.key}:${horizon}`,
    templateId: TEMPLATE_ID,
    scopeKey: scope.key,
    horizon,
    recent: rate,
    baseline: rate,
    window: {
      horizon,
      fromMs: matchDateRange(pairingMatches).fromMs,
      toMs: matchDateRange(pairingMatches).toMs,
      games: total,
      scoped: false,
    },
    salience: 0,
    // UI-SPEC §13.13a: not window-expressible, so no counted games door — the opponent hub route
    // door instead (DD-09's fallback for non-contiguous game sets).
    doors: [
      { kind: 'opponent' as const, axes: { ...(scope.axes ?? {}) }, count: distinctOpponents },
    ],
  };

  if (topIdentity !== null && topLossCount > 0) {
    const contributorMatches = pairingMatches.filter((m) => resolve(m) === topIdentity);
    const contributorTotal = contributorMatches.length;
    const contributorReachesMedium = contributorTotal >= TREND_MIN_RECENT_GAMES;
    const overallLossRate = losses.length / total;
    const interval = wilsonInterval(topLossCount, contributorTotal);
    const overallOutsideInterval =
      overallLossRate < interval.lower || overallLossRate > interval.upper;

    if (contributorReachesMedium && overallOutsideInterval) {
      // Review finding WR-A01: `types.ts` documents `deltaPoints` as non-null
      // in EXACTLY the `trend`/`suggestion` states — this branch asserts
      // `trend` but used to leave it `null`, silently zeroing this card's
      // rank in `salience.ts`'s `scoreInsight` regardless of how lopsided the
      // loss concentration is. The magnitude: how far the top contributor's
      // SHARE of total losses sits above an even split across
      // `distinctOpponents` (a value of 0 would mean losses are perfectly
      // spread; higher means more concentrated on one player).
      const lossShareDeltaPoints = Math.round(
        (topLossCount / losses.length - 1 / distinctOpponents) * 100,
      );
      return {
        ...commonFields,
        kind: 'inference',
        state: 'trend',
        deltaPoints: lossShareDeltaPoints,
        copy: {
          key: `insights.${TEMPLATE_ID}.player`,
          values: {
            opponent: topIdentity,
            lossShare: topLossCount,
            totalLosses: losses.length,
            opponentGames: contributorTotal,
            totalGames: total,
          },
        },
      };
    }
  }

  return {
    ...commonFields,
    kind: 'fact',
    state: 'fact',
    deltaPoints: null,
    copy: {
      key: `insights.${TEMPLATE_ID}.matchup`,
      values: { distinctOpponents, totalGames: total },
    },
  };
}

/**
 * "player-driven or matchup-driven" (UI-SPEC §9.4): for a (fighter, opponent-character) pairing,
 * whether one opponent player accounts for a disproportionate share of the pairing's losses (a
 * Trend) or losses are spread across the field (a direction-free Fact). `windowExpressible: false`
 * (review finding C1-H2): its games are the pairing's losses attributed to one opponent player,
 * not a contiguous window the existing drill-down axes can express.
 */
export const matchupOrPlayerTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'character',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildMatchupOrPlayerInsight(input);
    return insight === null ? [] : [insight];
  },
};
