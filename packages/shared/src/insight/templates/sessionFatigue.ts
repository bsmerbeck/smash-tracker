import type { Match } from '../../match.js';
import { splitIntoSessions } from '../../glicko.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { toRateValue, buildRateClaim, matchDateRange, countedMatchIdsOf } from '../horizon.js';
import { SUGGESTION_MIN_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'sessionFatigue' as const;

/**
 * Session GEOMETRY, not notability policy — declared locally in this file
 * (never in `insight/policy.ts`, which plan 39.1-01 owns and this plan does
 * not edit). The notability DECISION is still `isNotableCohortGap` from the
 * one policy module; these three constants only shape which games fall into
 * which cohort.
 */
const SESSION_LATE_GAME_INDEX = 20; // "game 21 on" (0-based index)
const SESSION_EARLY_GAME_COUNT = 10; // "the first ten"
const SESSION_FATIGUE_MIN_LONG_SESSIONS = 10;

interface SessionCohorts {
  longSessionCount: number;
  late: Match[];
  early: Match[];
}

/**
 * Cohort A ("late") is every game from `SESSION_LATE_GAME_INDEX` onward
 * within a "long" session (one that actually reaches that index). Cohort B
 * ("early") is the first `SESSION_EARLY_GAME_COUNT` games of EVERY session
 * long enough to have that many — not just the long ones — so the baseline
 * reflects ordinary early-session play in general, not only long sessions.
 */
function splitSessionCohorts(matches: Match[]): SessionCohorts {
  const sessions = splitIntoSessions(matches);
  const longSessions = sessions.filter((session) => session.length > SESSION_LATE_GAME_INDEX);

  const late: Match[] = [];
  for (const session of longSessions) {
    late.push(...session.slice(SESSION_LATE_GAME_INDEX));
  }

  const early: Match[] = [];
  for (const session of sessions) {
    if (session.length >= SESSION_EARLY_GAME_COUNT) {
      early.push(...session.slice(0, SESSION_EARLY_GAME_COUNT));
    }
  }

  return { longSessionCount: longSessions.length, late, early };
}

function buildSessionFatigueInsight(input: {
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

  const { longSessionCount, late, early } = splitSessionCohorts(scopedMatches);

  const lateRate = toRateValue(late);
  const earlyRate = toRateValue(early);

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;
  const dateRange = matchDateRange(scopedMatches);
  // The standing caveat value: always carried in `copy.values` so no
  // renderer can ever drop it (UI-SPEC §9.4's "always" row, T-39.1-04-03).
  const caveatValues = { caveat: 1 };

  if (longSessionCount < SESSION_FATIGUE_MIN_LONG_SESSIONS) {
    // Below the declared floor: the template DECLINES TO RENDER (UI-SPEC
    // §9.4's "hidden | fewer than N long sessions → not rendered, not
    // locked"), but still returns a real Insight with `state: 'hidden'` —
    // `rail.ts`'s `assembleRail` drops `hidden` results at assembly time
    // (its own doc comment), `computeInsights` itself returns every built
    // Insight regardless of state.
    const recentClaim = buildRateClaim({ rate: lateRate, refreshedAt: nowMs, dateRange });
    const baselineClaim = buildRateClaim({ rate: earlyRate, refreshedAt: nowMs, dateRange });
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind: 'fact',
      state: 'hidden',
      recent: recentClaim,
      baseline: baselineClaim,
      deltaPoints: null,
      window: { horizon, fromMs: null, toMs: null, games: 0, scoped: false },
      salience: 0,
      copy: {
        key: `insights.${TEMPLATE_ID}.hidden`,
        values: { ...caveatValues, longSessionCount },
      },
      doors: [],
      countedMatchIds: [],
    };
  }

  let state: Insight['state'];
  let kind: Insight['kind'];
  let deltaPoints: number | null = null;

  if (
    isNotableCohortGap(
      { wins: lateRate.wins, total: lateRate.total },
      { wins: earlyRate.wins, total: earlyRate.total },
    )
  ) {
    deltaPoints = Math.round((lateRate.rate - earlyRate.rate) * 100);
    if (late.length >= SUGGESTION_MIN_GAMES) {
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

  const recentClaim = buildRateClaim({
    rate: lateRate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(late),
  });
  const baselineClaim = buildRateClaim({
    rate: earlyRate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(early),
  });

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
      fromMs: dateRange.fromMs,
      toMs: dateRange.toMs,
      games: late.length,
      scoped: false,
    },
    salience: 0,
    copy: {
      key: `insights.${TEMPLATE_ID}.${state}`,
      values: {
        ...caveatValues,
        lateRate: `${Math.round(lateRate.rate * 100)}%`,
        earlyRate: `${Math.round(earlyRate.rate * 100)}%`,
        lateRecord: `${lateRate.wins}–${lateRate.losses}`,
        lateGameNumber: SESSION_LATE_GAME_INDEX + 1,
        earlyGameCount: SESSION_EARLY_GAME_COUNT,
        longSessionCount,
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
      },
    },
    doors: [],
    // Plan 39.1-22: the late-session cohort — the pooled cohort this card's own
    // count (`late.length`/`window.games`) counts.
    countedMatchIds: countedMatchIdsOf(late),
  };

  return insight;
}

/**
 * `SessionFatigue` (TRND-02, D-09, DD-12): compares late-session play (from
 * game `SESSION_LATE_GAME_INDEX + 1` on, within sessions long enough to
 * reach it) against early-session play (the first `SESSION_EARLY_GAME_COUNT`
 * games of every session). `windowExpressible: false` — the late cohort is
 * a non-contiguous, in-session subset the existing drill-down window axes
 * cannot reproduce (UI-SPEC §13.13a). Always below the abstention threshold
 * for a small account, so `hidden` (not `locked`) is the honest floor state.
 */
export const sessionFatigueTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildSessionFatigueInsight(input);
    return insight === null ? [] : [insight];
  },
};
