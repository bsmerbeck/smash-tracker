import { ABSTENTION_FLOOR_GAMES } from '../evidence/policy.js';
import { wilsonInterval } from './wilsonInterval.js';
import { TREND_MIN_RECENT_GAMES, SUGGESTION_MIN_GAMES, HORIZON_COLLAPSE_RATIO } from './policy.js';
import type { InsightKind, InsightState, RateValue } from './types.js';

export interface ClassifyResult {
  state: InsightState;
  kind: InsightKind;
  deltaPoints: number | null;
}

/**
 * UI-SPEC §7.8's honesty ladder (D-07), implemented in this EXACT precedence
 * order — each branch below is evaluated only if every earlier one did not
 * match:
 *
 * 1. `recent.total < ABSTENTION_FLOOR_GAMES` -> `locked` (the template
 *    attaches `gamesNeeded`; `classify` itself doesn't need to, since the
 *    caller already has `recent.total` in scope).
 * 2. `scoped` and `recent.total < TREND_MIN_RECENT_GAMES` (after the D-15
 *    12-month bound has already been applied upstream by `resolveWindow`)
 *    -> `thinRecent`.
 * 3. `recent.total >= HORIZON_COLLAPSE_RATIO * baseline.total` -> `collapsed`
 *    (D-06). Using `>=`: exactly 60% collapses, 59.9% does not.
 * 4. `recent.total < TREND_MIN_RECENT_GAMES` (unscoped thin case) -> `thin`.
 * 5. baseline rate inside the recent window's two-sided Wilson interval ->
 *    `steady`.
 * 6. Otherwise a direction is asserted: `suggestion` when `hasAction` is
 *    true AND the recent sample reaches `SUGGESTION_MIN_GAMES` (high tier);
 *    `trend` otherwise.
 *
 * `deltaPoints` is non-null in EXACTLY the `trend` and `suggestion` states.
 */
export function classify(input: {
  recent: RateValue;
  baseline: RateValue;
  scoped: boolean;
  hasAction: boolean;
}): ClassifyResult {
  const { recent, baseline, scoped, hasAction } = input;

  if (recent.total < ABSTENTION_FLOOR_GAMES) {
    return { state: 'locked', kind: 'fact', deltaPoints: null };
  }

  if (scoped && recent.total < TREND_MIN_RECENT_GAMES) {
    return { state: 'thinRecent', kind: 'fact', deltaPoints: null };
  }

  if (baseline.total > 0 && recent.total >= HORIZON_COLLAPSE_RATIO * baseline.total) {
    return { state: 'collapsed', kind: 'fact', deltaPoints: null };
  }

  if (recent.total < TREND_MIN_RECENT_GAMES) {
    return { state: 'thin', kind: 'fact', deltaPoints: null };
  }

  const interval = wilsonInterval(recent.wins, recent.total);
  const baselineInsideInterval = baseline.rate >= interval.lower && baseline.rate <= interval.upper;
  if (baselineInsideInterval) {
    return { state: 'steady', kind: 'fact', deltaPoints: null };
  }

  const deltaPoints = Math.round((recent.rate - baseline.rate) * 100);
  if (hasAction && recent.total >= SUGGESTION_MIN_GAMES) {
    return { state: 'suggestion', kind: 'recommendation', deltaPoints };
  }
  return { state: 'trend', kind: 'inference', deltaPoints };
}
