import type { Match } from '../../match.js';
import { buildRosterModel, ROSTER_MAIN_MIN_GAMES } from './rosterCore.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { buildRateClaim, matchDateRange, countedMatchIdsOf } from '../horizon.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'pocketCost' as const;

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
    countedMatchIds: [],
  };
}

function buildPocketCostInsight(input: {
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
  if (model.main === null) {
    return null;
  }

  if (model.pockets.games < ROSTER_MAIN_MIN_GAMES) {
    // UI-SPEC §9.4: "hidden | pockets < 20 games → not rendered" — the
    // floor is `ROSTER_MAIN_MIN_GAMES`, reused verbatim (never a second
    // constant for the same number).
    return buildHiddenInsight(scope, horizon, nowMs);
  }

  const pocketFighterIds = new Set(model.pockets.fighterIds);
  const pocketMatches = scopedMatches.filter((m) => pocketFighterIds.has(m.fighter_id));
  const mainMatches = scopedMatches.filter((m) => m.fighter_id === model.main!.fighterId);
  const dateRange = matchDateRange(pocketMatches);

  const notable = isNotableCohortGap(
    { wins: model.pockets.rate.wins, total: model.pockets.rate.total },
    { wins: model.main.rate.wins, total: model.main.rate.total },
  );
  const state: Insight['state'] = notable ? 'fact' : 'steady';

  const recentClaim = buildRateClaim({ rate: model.pockets.rate, refreshedAt: nowMs, dateRange });
  const baselineClaim = buildRateClaim({
    rate: model.main.rate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(mainMatches),
  });

  return {
    id: `${TEMPLATE_ID}:${scope.key}:${horizon}`,
    templateId: TEMPLATE_ID,
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state,
    recent: recentClaim,
    baseline: baselineClaim,
    deltaPoints: null,
    window: {
      horizon,
      fromMs: dateRange.fromMs,
      toMs: dateRange.toMs,
      games: model.pockets.games,
      scoped: false,
    },
    salience: 0,
    copy: {
      key: `insights.${TEMPLATE_ID}.${state}`,
      values: {
        pocketRate: Math.round(model.pockets.rate.rate * 100),
        pocketGames: model.pockets.games,
        mainRate: Math.round(model.main.rate.rate * 100),
      },
    },
    // §13.13a: pocketCost carries NO route door at all — pooled fighters
    // have no single route to link to.
    doors: [],
    // Plan 39.1-22: the pooled pocket group's own games — the same set
    // `model.pockets.games`/`window.games` counts.
    countedMatchIds: countedMatchIdsOf(pocketMatches),
  };
}

/**
 * `PocketCost` (INS-05, DD-12, UI-SPEC §9.4): a direction-free FACT
 * comparing the pooled pocket group's rate against the main's.
 * `assertsDirection: false` — this card presents the comparison, it never
 * ranks a direction (Task 2's own `<behavior>` text mentions no Trend/
 * Suggestion state for this card). `hidden` (not `locked`) below
 * `ROSTER_MAIN_MIN_GAMES` pooled pocket games. `windowExpressible: false`:
 * pooled multi-fighter games are not a contiguous window.
 */
export const pocketCostTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: false,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildPocketCostInsight(input);
    return insight === null ? [] : [insight];
  },
};
