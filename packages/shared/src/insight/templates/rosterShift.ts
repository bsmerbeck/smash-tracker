import type { Match } from '../../match.js';
import { resolveWindow, buildRateClaim } from '../horizon.js';
import { TREND_MIN_RECENT_GAMES, HORIZON_COLLAPSE_RATIO } from '../policy.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'rosterShift' as const;

/**
 * Cohort GEOMETRY (not a notability threshold — `insight/policy.ts`'s own
 * doc comment on that distinction), declared locally per this plan's
 * discipline: the minimum absolute percentage-point shift in a fighter's
 * SHARE OF PLAY, recent window vs. lifetime baseline, before `RosterShift`
 * asserts a direction. This plan's own engineering choice (Assumption
 * A-05-1), at the same scale `mixShift.ts`'s `MIX_SHIFT_MIN_POINTS` (15)
 * uses for its own share-shift comparison.
 */
const ROSTER_SHIFT_MIN_POINTS = 15;

function groupByFighterId(matches: Match[]): Map<number, Match[]> {
  const groups = new Map<number, Match[]>();
  for (const match of matches) {
    const existing = groups.get(match.fighter_id);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.fighter_id, [match]);
    }
  }
  return groups;
}

interface ShareCandidate {
  fighterId: number;
  recentGames: number;
  baselineGames: number;
  recentShare: number;
  baselineShare: number;
  shiftPoints: number;
}

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

function buildRosterShiftInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  if (scope.kind !== 'account') {
    // "Which fighter's share of play is moving" is an account-wide question
    // — same scope-kind guard as `rosterCore.ts`'s own doc comment.
    return null;
  }
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return null;
  }

  const { matches: recentMatches } = resolveWindow({
    matches: scopedMatches,
    horizon,
    scoped: false,
    nowMs,
  });
  const baselineTotal = scopedMatches.length;
  const recentTotal = recentMatches.length;

  // D-06's collapse ratio, mapped to the 'hidden' state (not 'collapsed'):
  // unlike `formNow`'s collapsed state (a rendered FACT — "the whole
  // record IS the recent window"), UI-SPEC §9.4's RosterShift row states
  // this same condition is "not rendered" — the same treatment
  // `sessionFatigue`/`mixShift` give their own below-floor branches
  // (a real, materialized Insight `rail.ts`'s `assembleRail` drops, not an
  // empty `build()` result).
  if (baselineTotal > 0 && recentTotal >= HORIZON_COLLAPSE_RATIO * baselineTotal) {
    return buildHiddenInsight(scope, horizon, nowMs);
  }

  const baselineGroups = groupByFighterId(scopedMatches);
  const recentGroups = groupByFighterId(recentMatches);
  const fighterIds = new Set<number>([...baselineGroups.keys(), ...recentGroups.keys()]);

  const candidates: ShareCandidate[] = [];
  for (const fighterId of fighterIds) {
    const baselineGames = baselineGroups.get(fighterId)?.length ?? 0;
    const recentGames = recentGroups.get(fighterId)?.length ?? 0;
    const baselineShare = baselineTotal > 0 ? baselineGames / baselineTotal : 0;
    const recentShare = recentTotal > 0 ? recentGames / recentTotal : 0;
    candidates.push({
      fighterId,
      recentGames,
      baselineGames,
      recentShare,
      baselineShare,
      shiftPoints: Math.round((recentShare - baselineShare) * 100),
    });
  }

  const belowMedium = recentTotal < TREND_MIN_RECENT_GAMES;
  const headline = [...candidates].sort(
    (a, b) => Math.abs(b.shiftPoints) - Math.abs(a.shiftPoints) || a.fighterId - b.fighterId,
  )[0];

  const asserting =
    !belowMedium &&
    headline !== undefined &&
    Math.abs(headline.shiftPoints) >= ROSTER_SHIFT_MIN_POINTS;

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;
  const window = { horizon, fromMs: null, toMs: null, games: recentTotal, scoped: false };

  if (!asserting) {
    const emptyRate: RateValue = { wins: 0, losses: 0, total: 0, rate: 0 };
    const claim = buildRateClaim({
      rate: emptyRate,
      refreshedAt: nowMs,
      dateRange: { fromMs: null, toMs: null },
    });
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind: 'fact',
      state: 'steady',
      recent: claim,
      baseline: claim,
      deltaPoints: null,
      window,
      salience: 0,
      copy: { key: `insights.${TEMPLATE_ID}.steady`, values: {} },
      doors: [],
    };
  }

  const recentRate: RateValue = {
    wins: headline.recentGames,
    losses: recentTotal - headline.recentGames,
    total: recentTotal,
    rate: headline.recentShare,
  };
  const baselineRate: RateValue = {
    wins: headline.baselineGames,
    losses: baselineTotal - headline.baselineGames,
    total: baselineTotal,
    rate: headline.baselineShare,
  };
  const recentClaim = buildRateClaim({
    rate: recentRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: null, toMs: null },
  });
  const baselineClaim = buildRateClaim({
    rate: baselineRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: null, toMs: null },
  });

  const direction = headline.shiftPoints < 0 ? 'down' : 'up';

  return {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind: 'inference',
    state: 'trend',
    recent: recentClaim,
    baseline: baselineClaim,
    deltaPoints: headline.shiftPoints,
    window,
    salience: 0,
    copy: {
      key: `insights.${TEMPLATE_ID}.${direction}`,
      values: {
        fighter: headline.fighterId,
        points: Math.abs(headline.shiftPoints),
        count: recentTotal,
      },
    },
    doors: [{ kind: 'games', axes: { ...(scope.axes ?? {}) }, count: recentTotal }],
  };
}

/**
 * `RosterShift` (INS-05, UI-SPEC §8.4/§9.4): compares each fighter's SHARE OF
 * PLAY, recent window vs. lifetime baseline, and asserts a direction only
 * once the recent sample reaches the medium confidence tier AND the shift
 * clears `ROSTER_SHIFT_MIN_POINTS`. `windowExpressible: true`: the games
 * referenced are the account's own recent window, a contiguous span
 * reproducible from the existing drill-down axes with no fighter narrowing.
 */
export const rosterShiftTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildRosterShiftInsight(input);
    return insight === null ? [] : [insight];
  },
};
