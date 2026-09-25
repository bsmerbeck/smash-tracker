import { COHORT_NOTABLE_Z, COHORT_MIN_SIDE_GAMES } from './policy.js';

/**
 * DD-12: the standard pooled two-proportion z statistic, used to test
 * whether two non-recency cohorts (e.g. online vs. offline, `SettingGap`)
 * differ notably. Returns `0` when either total is `0` — no evidence, no
 * signal to test, never `NaN`.
 */
export function twoProportionZ(
  aWins: number,
  aTotal: number,
  bWins: number,
  bTotal: number,
): number {
  if (aTotal === 0 || bTotal === 0) {
    return 0;
  }
  const pA = aWins / aTotal;
  const pB = bWins / bTotal;
  const pooled = (aWins + bWins) / (aTotal + bTotal);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / aTotal + 1 / bTotal));
  if (standardError === 0) {
    return 0;
  }
  return (pA - pB) / standardError;
}

/**
 * DD-12: a cohort gap is notable only when BOTH sides have reached
 * `COHORT_MIN_SIDE_GAMES` and the two-proportion z statistic clears
 * `COHORT_NOTABLE_Z` — the same "both sides evidenced, then test" shape as
 * the honesty ladder's Trend gate (D-07), restated for a two-cohort
 * comparison instead of a recent-vs-baseline one.
 */
export function isNotableCohortGap(
  a: { wins: number; total: number },
  b: { wins: number; total: number },
): boolean {
  if (a.total < COHORT_MIN_SIDE_GAMES || b.total < COHORT_MIN_SIDE_GAMES) {
    return false;
  }
  return Math.abs(twoProportionZ(a.wins, a.total, b.wins, b.total)) >= COHORT_NOTABLE_Z;
}
