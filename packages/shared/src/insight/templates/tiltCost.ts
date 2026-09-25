import type { Match } from '../../match.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { toRateValue, buildRateClaim, matchDateRange, countedMatchIdsOf } from '../horizon.js';
import { COHORT_MIN_SIDE_GAMES, SUGGESTION_MIN_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'tiltCost' as const;

/**
 * Cohort geometry (not a notability threshold — those all come from
 * `insight/policy.ts`): how many consecutive losses qualify the next game as
 * a "spot". Declared locally per this plan's own discipline (mirrors
 * `sessionFatigue.ts`'s session-geometry constants, `matchupOrPlayer.ts`'s
 * `MATCHUP_OR_PLAYER_MIN_DISTINCT_OPPONENTS`, and `periodSeries.ts`'s ported
 * `EVENT_SESSION_PROXIMITY_MS`).
 */
const TILT_STREAK_LENGTH = 2;

/** Chronological order (oldest first) — never assumes caller ordering. */
function orderChronologically(matches: Match[]): Match[] {
  return [...matches].sort((a, b) => a.time - b.time);
}

/**
 * Walks the chronological sequence once, classifying each game as a "spot"
 * (it follows at least `TILT_STREAK_LENGTH` consecutive losses) or a
 * baseline game (everything else) — cohort A and cohort B respectively. A
 * spot's own outcome is recorded in cohort A regardless of whether it
 * extends or breaks the streak; the running counter resets on any win.
 */
function splitSpotsAndBaseline(matches: Match[]): { spots: Match[]; baseline: Match[] } {
  const sorted = orderChronologically(matches);
  const spots: Match[] = [];
  const baseline: Match[] = [];
  let consecutiveLosses = 0;
  for (const match of sorted) {
    if (consecutiveLosses >= TILT_STREAK_LENGTH) {
      spots.push(match);
    } else {
      baseline.push(match);
    }
    consecutiveLosses = match.win ? 0 : consecutiveLosses + 1;
  }
  return { spots, baseline };
}

function buildCopyKey(state: Insight['state']): string {
  return `insights.${TEMPLATE_ID}.${state}`;
}

function buildTiltCostInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  const scopedMatches = scope.filter(matches);
  const { spots, baseline } = splitSpotsAndBaseline(scopedMatches);

  if (spots.length === 0) {
    // No two-loss streak has ever occurred in scope yet — nothing to report,
    // distinct from "some spots but not enough" (locked below). Mirrors
    // `formNowTemplate`'s "0 games in scope -> no card at all" branch
    // (formNow.ts) rather than fabricating a locked meter with a full
    // `COHORT_MIN_SIDE_GAMES` shortfall for an account that has literally
    // never had the qualifying streak.
    return null;
  }

  const spotRate = toRateValue(spots);
  const baselineRate = toRateValue(baseline);

  let state: Insight['state'];
  let kind: Insight['kind'];
  let deltaPoints: number | null = null;

  if (spots.length < COHORT_MIN_SIDE_GAMES) {
    state = 'locked';
    kind = 'fact';
  } else if (
    isNotableCohortGap(
      { wins: spotRate.wins, total: spotRate.total },
      { wins: baselineRate.wins, total: baselineRate.total },
    )
  ) {
    deltaPoints = Math.round((spotRate.rate - baselineRate.rate) * 100);
    if (spots.length >= SUGGESTION_MIN_GAMES) {
      state = 'suggestion';
      kind = 'recommendation';
    } else {
      state = 'trend';
      kind = 'inference';
    }
  } else {
    state = 'steady';
    kind = 'fact';
  }

  const spotDateRange = matchDateRange(spots);
  const recentClaim = buildRateClaim({
    rate: spotRate,
    refreshedAt: nowMs,
    dateRange: spotDateRange,
  });
  const baselineClaim = buildRateClaim({
    rate: baselineRate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(baseline),
  });

  const gamesNeeded =
    state === 'locked' ? Math.max(0, COHORT_MIN_SIDE_GAMES - spots.length) : undefined;

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  const insight: Insight = {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind,
    state,
    recent: recentClaim,
    baseline: baselineClaim,
    deltaPoints,
    window: {
      horizon,
      fromMs: spotDateRange.fromMs,
      toMs: spotDateRange.toMs,
      games: spots.length,
      scoped: false,
    },
    // Placeholder until `computeInsights` overwrites this with
    // `salience.ts`'s `scoreInsight` — a template never sets its own final
    // salience (see `engine.ts`'s doc comment).
    salience: 0,
    copy: {
      key: buildCopyKey(state),
      values: {
        spotRate: `${Math.round(spotRate.rate * 100)}%`,
        baselineRate: `${Math.round(baselineRate.rate * 100)}%`,
        spotRecord: `${spotRate.wins}–${spotRate.losses}`,
        spotCount: spotRate.total,
        cue: 'after 2 straight losses',
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
        ...(gamesNeeded !== undefined ? { count: gamesNeeded } : {}),
      },
    },
    doors: [],
    // Plan 39.1-22: the post-2-loss-streak "spot" games — the pooled cohort this
    // card's own count (`spots.length`/`window.games`) counts.
    countedMatchIds: countedMatchIdsOf(spots),
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };

  return insight;
}

/**
 * `TiltCost` (TRND-02, D-09): what a two-loss streak costs the very next
 * game, measured against every other countable game as the baseline —
 * DD-12's two-proportion cohort comparison, never the D-07 recency ladder
 * (there is no "recent vs baseline TIME window" here; both cohorts are
 * pooled across the account's whole history). `windowExpressible: false`:
 * the spot games are a non-contiguous subset the existing drill-down window
 * axes cannot reproduce (UI-SPEC §13.13a) — plan 39.1-19 gives this template
 * a fallback route door instead.
 */
export const tiltCostTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildTiltCostInsight(input);
    return insight === null ? [] : [insight];
  },
};
