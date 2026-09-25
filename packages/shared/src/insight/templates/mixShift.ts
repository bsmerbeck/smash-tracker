import type { Match } from '../../match.js';
import { resolveWindow, matchDateRange, buildRateClaim, countedMatchIdsOf } from '../horizon.js';
import { TREND_MIN_RECENT_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'mixShift' as const;

/**
 * Cohort GEOMETRY, not notability policy — declared locally (never in
 * `insight/policy.ts`, plan 39.1-01's file). The minimum absolute
 * percentage-point shift (recent share vs. lifetime share) before MixShift
 * is worth surfacing at all — UI-SPEC §9.4's own MixShift row states this
 * exact floor ("needs recent n >= 8 and a >= 15-pt share shift").
 */
const MIX_SHIFT_MIN_POINTS = 15;

/** The locale-independent match-type bucket key (`analytics.matchType.*`) — `''`/`'none'`/absent all normalize to `'none'`. */
function matchTypeKeyOf(match: Match): string {
  const type = match.matchType ?? '';
  return type === '' ? 'none' : type;
}

/** Each present match type's share of `matches` (fractions summing to 1, or an empty map for 0 games). */
function sharesByType(matches: Match[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const key = matchTypeKeyOf(match);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shares = new Map<string, number>();
  const total = matches.length;
  for (const [key, count] of counts) {
    shares.set(key, total > 0 ? count / total : 0);
  }
  return shares;
}

interface LargestShift {
  matchType: string;
  recentShare: number;
  lifetimeShare: number;
  absPoints: number;
}

/** The match type whose recent-vs-lifetime share differs by the largest absolute amount, across every type present in either set. */
function findLargestShift(
  recentShares: Map<string, number>,
  lifetimeShares: Map<string, number>,
): LargestShift | null {
  const types = new Set<string>([...recentShares.keys(), ...lifetimeShares.keys()]);
  let best: LargestShift | null = null;
  for (const matchType of types) {
    const recentShare = recentShares.get(matchType) ?? 0;
    const lifetimeShare = lifetimeShares.get(matchType) ?? 0;
    const absPoints = Math.abs(recentShare - lifetimeShare) * 100;
    if (best === null || absPoints > best.absPoints) {
      best = { matchType, recentShare, lifetimeShare, absPoints };
    }
  }
  return best;
}

function buildMixShiftInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return null;
  }

  const { window, matches: recentMatches } = resolveWindow({
    matches: scopedMatches,
    horizon,
    scoped: false,
    nowMs,
  });

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;
  const dateRange = matchDateRange(scopedMatches);

  /** A synthetic `RateValue` carrying a SHARE (not a win rate) in `.rate` — the closest fit `EvidenceClaim<RateValue>` offers for a share claim; `wins`/`losses` are not meaningful for MixShift and are left at 0. */
  function shareRateValue(total: number, share: number): RateValue {
    return { wins: 0, losses: 0, total, rate: share };
  }

  if (recentMatches.length < TREND_MIN_RECENT_GAMES) {
    const hiddenRate = shareRateValue(recentMatches.length, 0);
    const hiddenClaim = buildRateClaim({
      rate: hiddenRate,
      refreshedAt: nowMs,
      dateRange: { fromMs: window.fromMs, toMs: window.toMs },
    });
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind: 'fact',
      state: 'hidden',
      recent: hiddenClaim,
      baseline: hiddenClaim,
      deltaPoints: null,
      window,
      salience: 0,
      copy: { key: `insights.${TEMPLATE_ID}.hidden`, values: { count: recentMatches.length } },
      doors: [],
      // Plan 39.1-22: `window.games` here is `recentMatches.length` (resolveWindow's own result).
      countedMatchIds: countedMatchIdsOf(recentMatches),
    };
  }

  const recentShares = sharesByType(recentMatches);
  const lifetimeShares = sharesByType(scopedMatches);
  const largestShift = findLargestShift(recentShares, lifetimeShares);

  const recentClaim = buildRateClaim({
    rate: shareRateValue(recentMatches.length, largestShift?.recentShare ?? 0),
    refreshedAt: nowMs,
    dateRange: { fromMs: window.fromMs, toMs: window.toMs },
  });
  const lifetimeClaim = buildRateClaim({
    rate: shareRateValue(scopedMatches.length, largestShift?.lifetimeShare ?? 0),
    refreshedAt: nowMs,
    dateRange,
  });

  if (largestShift === null || largestShift.absPoints < MIX_SHIFT_MIN_POINTS) {
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind: 'fact',
      state: 'hidden',
      recent: recentClaim,
      baseline: lifetimeClaim,
      deltaPoints: null,
      window,
      salience: 0,
      copy: {
        key: `insights.${TEMPLATE_ID}.hidden`,
        values: {
          count: recentMatches.length,
          points: largestShift ? Math.round(largestShift.absPoints) : 0,
        },
      },
      doors: [],
      countedMatchIds: countedMatchIdsOf(recentMatches),
    };
  }

  const insight: Insight = {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind: 'fact',
    state: 'fact',
    recent: recentClaim,
    baseline: lifetimeClaim,
    deltaPoints: null,
    window,
    salience: 0,
    copy: {
      key: `insights.${TEMPLATE_ID}.fact`,
      values: {
        matchType: largestShift.matchType,
        recentShare: `${Math.round(largestShift.recentShare * 100)}%`,
        lifetimeShare: `${Math.round(largestShift.lifetimeShare * 100)}%`,
        points: Math.round(largestShift.absPoints),
      },
    },
    doors: [],
    countedMatchIds: countedMatchIdsOf(recentMatches),
  };

  return insight;
}

/**
 * `MixShift` (DD-15, UI-SPEC §7.12): a direction-free FACT comparing the
 * recent window's match-type mix against the lifetime mix, describing in
 * words the same data `ShareBar` renders visually. `assertsDirection:
 * false` — `deltaPoints` is always `null`, even when asserting.
 * `windowExpressible: true` — its recent window is a contiguous span the
 * existing drill-down axes express.
 */
export const mixShiftTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildMixShiftInsight(input);
    return insight === null ? [] : [insight];
  },
};
