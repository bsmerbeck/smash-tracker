import type { Match } from '../../match.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { toRateValue, buildRateClaim, matchDateRange, countedMatchIdsOf } from '../horizon.js';
import { COHORT_MIN_SIDE_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'tierGap' as const;

/** Stands in for a rate no game backs; never a fabricated 0% or 100% (T-39.1-04-02). */
const NO_RATE = '–';

function percentOf(rate: number, total: number): string {
  return total > 0 ? `${Math.round(rate * 100)}%` : NO_RATE;
}

/** Keeps the cohort's games the scope itself admits, so a scope can never leak an id it does not filter to. */
function admitted(cohort: Match[], allowed: Set<string>): Match[] {
  const seen = new Set<string>();
  const result: Match[] = [];
  for (const match of cohort) {
    if (allowed.has(match.id) && !seen.has(match.id)) {
      seen.add(match.id);
      result.push(match);
    }
  }
  return result;
}

function buildTierGapInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  const cohorts = scope.tierCohorts;
  if (cohorts === undefined) {
    return null;
  }

  const allowed = new Set(scope.filter(matches).map((match) => match.id));
  const cohortA = admitted(cohorts.a, allowed);
  const cohortB = admitted(cohorts.b, allowed);
  const aRate = toRateValue(cohortA);
  const bRate = toRateValue(cohortB);

  let state: Insight['state'];
  let kind: Insight['kind'] = 'fact';
  let key: string;
  let deltaPoints: number | null = null;
  let gamesNeeded: number | undefined;
  let shortCount = 0;

  if (cohortA.length === 0 && cohortB.length === 0 && cohorts.knownEvents === 0) {
    // No event carries a known tier at all: a designed non-assertive result,
    // never an empty frame.
    state = 'thin';
    key = 'noTiers';
  } else if (cohortA.length < COHORT_MIN_SIDE_GAMES) {
    state = 'locked';
    key = 'abstained';
    shortCount = cohortA.length;
    gamesNeeded = COHORT_MIN_SIDE_GAMES - cohortA.length;
  } else if (cohortB.length < COHORT_MIN_SIDE_GAMES) {
    state = 'locked';
    key = 'abstainedSmaller';
    shortCount = cohortB.length;
    gamesNeeded = COHORT_MIN_SIDE_GAMES - cohortB.length;
  } else if (
    isNotableCohortGap(
      { wins: aRate.wins, total: aRate.total },
      { wins: bRate.wins, total: bRate.total },
    )
  ) {
    deltaPoints = Math.round((aRate.rate - bRate.rate) * 100);
    state = 'trend';
    kind = 'inference';
    key = deltaPoints < 0 ? 'down' : 'up';
  } else {
    state = 'steady';
    key = 'steady';
  }

  // Cohort order is FIXED (A, majors and above, always leads) and EVERY param is
  // set on EVERY state, so no copy key can leak a literal `{{param}}`
  // (the 39.1-15 lesson). `count` is the short cohort's games when the read
  // abstains, else the games counted.
  const values: Record<string, string | number> = {
    aRate: percentOf(aRate.rate, aRate.total),
    aRecord: `${aRate.wins}–${aRate.losses}`,
    aGames: aRate.total,
    bRate: percentOf(bRate.rate, bRate.total),
    bRecord: `${bRate.wins}–${bRate.losses}`,
    bGames: bRate.total,
    count: gamesNeeded !== undefined || state === 'thin' ? shortCount : aRate.total + bRate.total,
    points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
    estimatedEvents: cohorts.estimatedEvents,
  };

  const counted = [...cohortA, ...cohortB];
  const dateRange = matchDateRange(counted);
  const scopeKey = scope.key;

  return {
    id: `${TEMPLATE_ID}:${scopeKey}:${horizon}`,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind,
    state,
    recent: buildRateClaim({ rate: aRate, refreshedAt: nowMs, dateRange }),
    baseline: buildRateClaim({ rate: bRate, refreshedAt: nowMs, dateRange }),
    deltaPoints,
    window: {
      horizon,
      fromMs: dateRange.fromMs,
      toMs: dateRange.toMs,
      games: counted.length,
      scoped: false,
    },
    salience: 0,
    copy: { key: `insights.${TEMPLATE_ID}.${key}`, values },
    doors: [],
    // Both cohorts, newest first: exactly the games the verdict counted (an
    // Unknown-tier or excluded side event never appears here).
    countedMatchIds: countedMatchIdsOf(counted),
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };
}

/**
 * `TierGap` (TIER-03, DD-11, D-16): majors and above (supermajor + major)
 * against smaller events (minor + regional + local), a two-proportion cohort
 * comparison. A direction is asserted ONLY when both cohorts reach
 * `COHORT_MIN_SIDE_GAMES` AND `isNotableCohortGap` holds; otherwise the read
 * is a steady Fact, an abstained (`locked`) Fact naming the short cohort's
 * count, or the `noTiers` Fact. The cohorts are pre-registered, never tunable
 * per account (T-39.2-37).
 *
 * It reads them only from `InsightScope.tierCohorts` and returns nothing when
 * that member is absent, so no rail or page but the Tournaments page can
 * render it. `windowExpressible: false`: a tier cohort is a partition by an
 * event's resolved tier, not a contiguous window, so its games are reached
 * through the recorded `countedMatchIds` (the `claim=` axis), never a
 * from/to reconstruction. `doors: []`: the web builds the counted-games door
 * from `countedMatchIds`.
 */
export const tierGapTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildTierGapInsight(input);
    return insight === null ? [] : [insight];
  },
};
