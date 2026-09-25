import type { Match } from '../../match.js';
import { computeRatingHistory, DEFAULT_RATING, DEFAULT_RD } from '../../glicko.js';
import {
  resolveWindow,
  toRateValue,
  buildRateClaim,
  matchDateRange,
  countedMatchIdsOf,
} from '../horizon.js';
import { classify } from '../ladder.js';
import { ABSTENTION_FLOOR_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'ratingMove' as const;

/**
 * DD-12: a rating move is notable once the absolute change reaches the
 * CURRENT rating deviation — the model's own uncertainty band, not a fixed
 * z-score (that's the two-proportion cohorts' rule, `twoProportion.ts`).
 * Exported so the boundary itself (one point below vs. exactly at the RD)
 * can be asserted directly, without needing a hand-engineered Glicko
 * fixture to land on an exact value (mirrors `twoProportion.ts`'s exported
 * `isNotableCohortGap`).
 */
export function isNotableRatingMove(deltaRating: number, currentRd: number): boolean {
  return Math.abs(deltaRating) >= currentRd;
}

/**
 * Review finding WR-A04: ties break on the match's own stable `id`, mirroring
 * `horizon.ts`'s identical comparator — hygiene fix for consistency (this
 * sort feeds `computeRatingHistory`, whose per-session `updateRating` batches
 * a period's results via order-independent sums, so a tie between two
 * matches in the SAME session does not currently change the output; this
 * guards against that ceasing to hold on a future glicko.ts change).
 */
function byTimeAsc(a: Match, b: Match): number {
  if (a.time !== b.time) {
    return a.time - b.time;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildRatingMoveInsight(input: {
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
  const recentIds = new Set(recentMatches.map((match) => match.id));
  const priorMatches = scopedMatches.filter((match) => !recentIds.has(match.id));

  // `classify` is reused ONLY for its game-count gating branches
  // (locked/thinRecent/collapsed/thin — D-07 branches 1-4, which read only
  // `.total`, never `.rate`). Its own steady/trend/suggestion verdict
  // (branches 5-6, Wilson-interval based) is a WIN-RATE claim and is
  // deliberately ignored below in favour of the RD-band rule (DD-12) — a
  // rating move is a different kind of claim than a win-rate trend.
  const recentRate = toRateValue(recentMatches);
  const baselineRate = toRateValue(priorMatches);
  const gate = classify({
    recent: recentRate,
    baseline: baselineRate,
    scoped: false,
    hasAction: false,
  });

  const endHistory = computeRatingHistory([...scopedMatches].sort(byTimeAsc));
  const endRating = endHistory.current?.rating ?? DEFAULT_RATING;
  const endRd = endHistory.current?.rd ?? DEFAULT_RD;
  const startHistory = computeRatingHistory([...priorMatches].sort(byTimeAsc));
  const startRating = startHistory.current?.rating ?? DEFAULT_RATING;

  let state: Insight['state'];
  let kind: Insight['kind'];
  let deltaPoints: number | null = null;

  if (
    gate.state === 'locked' ||
    gate.state === 'thinRecent' ||
    gate.state === 'collapsed' ||
    gate.state === 'thin'
  ) {
    state = gate.state;
    kind = 'fact';
  } else {
    const delta = endRating - startRating;
    if (isNotableRatingMove(delta, endRd)) {
      state = 'trend';
      kind = 'inference';
      deltaPoints = Math.round(delta);
    } else {
      state = 'steady';
      kind = 'fact';
    }
  }

  const gamesNeeded =
    state === 'locked' ? Math.max(0, ABSTENTION_FLOOR_GAMES - recentRate.total) : undefined;

  const recentClaim = buildRateClaim({
    rate: recentRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: window.fromMs, toMs: window.toMs },
  });
  const baselineClaim = buildRateClaim({
    rate: baselineRate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(priorMatches),
  });

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;
  const direction = deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  const key =
    state === 'trend' ? `insights.${TEMPLATE_ID}.${direction}` : `insights.${TEMPLATE_ID}.${state}`;

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
    window,
    salience: 0,
    copy: {
      key,
      values: {
        startRating: Math.round(startRating),
        endRating: Math.round(endRating),
        band: Math.round(endRd),
        // Review finding CR-A02: `insights.ratingMove.locked_one/_other`
        // reads `{{count}}` as "how many MORE games are needed" — must be
        // `gamesNeeded`, never the games already played.
        count: gamesNeeded !== undefined ? gamesNeeded : window.games,
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
        ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
      },
    },
    // UI-SPEC §8.2: the page-level RatingModelNote banner is demoted to a
    // door on this card.
    doors: [{ kind: 'ratingModel', axes: {}, count: 0 }],
    // Plan 39.1-22: `window` above is `resolveWindow`'s own result and is
    // returned UNCHANGED in every branch (locked/thinRecent/collapsed/thin/
    // steady/trend) — so `recentMatches` is always exactly the games
    // `window.games` counts, regardless of state.
    countedMatchIds: countedMatchIdsOf(recentMatches),
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };

  return insight;
}

/**
 * `RatingMove` (TRND-02, DD-12): the account's session-based Glicko rating
 * change across the active horizon, asserted only once the absolute change
 * reaches the CURRENT rating deviation (`isNotableRatingMove`).
 * `windowExpressible: true` — a rating window is a contiguous scoped window
 * the existing drill-down axes express (UI-SPEC §13.13a).
 */
export const ratingMoveTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildRatingMoveInsight(input);
    return insight === null ? [] : [insight];
  },
};
