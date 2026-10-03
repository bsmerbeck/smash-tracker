import type { Match } from '../../match.js';
import { buildRateClaim, countedMatchIdsOf, matchDateRange, toRateValue } from '../horizon.js';
import {
  RHYTHM_BUSIEST_MIN_RATIO,
  RHYTHM_MIN_MONTHS,
  RHYTHM_SEASON_MIN_SPAN_MONTHS,
} from '../policy.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'playRhythm' as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The two comparison windows are a fixed 365 days each (DD-41-07), anchored on `nowMs`. */
const RHYTHM_WINDOW_MS = 365 * MS_PER_DAY;
const MONTHS_PER_YEAR = 12;

/**
 * A UTC calendar month as one integer (`year * 12 + monthIndex`), so a span between two months is a
 * subtraction. Declared locally rather than imported: `volumeForm.ts`'s and `periodSeries.ts`'s month
 * helpers are private to those files, and the activity heat buckets by the SAME UTC rule — a game at
 * 2026-03-01T02:00Z is a March game for every host time zone.
 */
function monthIndexOf(timeMs: number): number {
  const d = new Date(timeMs);
  return d.getUTCFullYear() * MONTHS_PER_YEAR + d.getUTCMonth();
}

/** The month-of-year (1-12, UTC) of a game. */
function monthOfYearOf(timeMs: number): number {
  return new Date(timeMs).getUTCMonth() + 1;
}

interface BusiestMonth {
  /** 1-12. */
  month: number;
  /** The month-of-year's share of every game in scope (0-1). */
  share: number;
}

/**
 * The month-of-year holding the largest share of all games in scope. Ties go to the month whose
 * latest occurrence is the most recent. Returns `null` when no month clears the DD-41-07 ratio over
 * the mean month-of-year share (1/12 — the shares of the twelve calendar months always sum to 1).
 */
function findBusiestMonth(matches: Match[]): BusiestMonth | null {
  const counts = new Map<number, number>();
  const latest = new Map<number, number>();
  for (const match of matches) {
    const month = monthOfYearOf(match.time);
    counts.set(month, (counts.get(month) ?? 0) + 1);
    latest.set(month, Math.max(latest.get(month) ?? Number.NEGATIVE_INFINITY, match.time));
  }

  let best: { month: number; count: number } | null = null;
  for (const [month, count] of counts) {
    if (
      best === null ||
      count > best.count ||
      (count === best.count && latest.get(month)! > latest.get(best.month)!)
    ) {
      best = { month, count };
    }
  }
  if (best === null) {
    return null;
  }

  const share = best.count / matches.length;
  const meanShare = 1 / MONTHS_PER_YEAR;
  return share >= RHYTHM_BUSIEST_MIN_RATIO * meanShare ? { month: best.month, share } : null;
}

function buildPlayRhythmInsight(input: {
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

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  const monthIndexes = scopedMatches.map((match) => monthIndexOf(match.time));
  const monthsPlayed = new Set(monthIndexes).size;
  const monthsSpan = Math.max(...monthIndexes) - Math.min(...monthIndexes) + 1;

  if (monthsPlayed < RHYTHM_MIN_MONTHS) {
    const monthsNeeded = RHYTHM_MIN_MONTHS - monthsPlayed;
    const range = matchDateRange(scopedMatches);
    const allRate = toRateValue(scopedMatches);
    const claim = buildRateClaim({ rate: allRate, refreshedAt: nowMs, dateRange: range });
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
        fromMs: range.fromMs,
        toMs: range.toMs,
        games: scopedMatches.length,
        scoped: false,
      },
      salience: 0,
      copy: {
        key: `insights.${TEMPLATE_ID}.locked`,
        values: { count: monthsNeeded, have: monthsPlayed, need: RHYTHM_MIN_MONTHS },
      },
      doors: [],
      // `window.games` above is every game in scope — the games the month tally describes.
      countedMatchIds: countedMatchIdsOf(scopedMatches),
      gamesNeeded: monthsNeeded,
    };
  }

  const recentFloorMs = nowMs - RHYTHM_WINDOW_MS;
  const priorFloorMs = nowMs - 2 * RHYTHM_WINDOW_MS;
  const recentMatches = scopedMatches.filter(
    (match) => match.time >= recentFloorMs && match.time <= nowMs,
  );
  const priorMatches = scopedMatches.filter(
    (match) => match.time >= priorFloorMs && match.time < recentFloorMs,
  );
  const recentMonths = new Set(recentMatches.map((match) => monthIndexOf(match.time))).size;

  const busiest =
    monthsSpan >= RHYTHM_SEASON_MIN_SPAN_MONTHS ? findBusiestMonth(scopedMatches) : null;

  const recentRange = matchDateRange(recentMatches);
  const recentClaim = buildRateClaim({
    rate: toRateValue(recentMatches),
    refreshedAt: nowMs,
    dateRange: recentRange,
  });
  const priorClaim = buildRateClaim({
    rate: toRateValue(priorMatches),
    refreshedAt: nowMs,
    dateRange: matchDateRange(priorMatches),
  });

  const baseValues: Record<string, number> = {
    recent: recentMatches.length,
    prior: priorMatches.length,
    monthsPlayed,
    monthsSpan,
  };
  // Conditional spread, never an `undefined` member: the clause keys exist only when stated.
  const seasonValues: Record<string, number> = busiest
    ? { month: busiest.month, share: busiest.share }
    : {};

  let copyKey: string;
  let values: Record<string, string | number>;
  if (priorMatches.length === 0) {
    copyKey = `insights.${TEMPLATE_ID}.fact.recentOnly`;
    values = { ...baseValues, ...seasonValues, recentMonths };
  } else if (busiest) {
    copyKey = `insights.${TEMPLATE_ID}.fact.compare`;
    values = { ...baseValues, ...seasonValues };
  } else {
    copyKey = `insights.${TEMPLATE_ID}.fact.compareNoSeason`;
    values = baseValues;
  }

  return {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind: 'fact',
    state: 'fact',
    recent: recentClaim,
    baseline: priorClaim,
    deltaPoints: null,
    window: {
      horizon,
      fromMs: recentRange.fromMs,
      toMs: recentRange.toMs,
      games: recentMatches.length,
      scoped: false,
    },
    salience: 0,
    copy: { key: copyKey, values },
    doors: [],
    // The recent 12-month window's games: the number the verdict leads with, and what its door opens.
    countedMatchIds: countedMatchIdsOf(recentMatches),
  };
}

/**
 * `PlayRhythm` (DD-41-07, B1): a direction-free FACT comparing the last 12 months of play with the 12
 * before, plus a busiest-month-of-year clause only when the history is long and peaked enough to
 * support one. Locked below `RHYTHM_MIN_MONTHS` distinct months with games. `assertsDirection: false`
 * - it never says "more" or "less", so `deltaPoints` is always `null`. `windowExpressible: true` -
 * its counted games are one contiguous 12-month span.
 *
 * The engine never localises: month and share arrive as plain numbers, the host formats them.
 */
export const playRhythmTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildPlayRhythmInsight(input);
    return insight === null ? [] : [insight];
  },
};
