import { WILSON_Z } from './policy.js';

/**
 * The two-sided Wilson score interval (default z = 1.96 ≈ 95%) — the
 * "baseline rate lies outside the recent window's interval" test D-07's
 * Trend gate depends on. Sibling to, not inside, `evidence/rank.ts`'s
 * `wilsonLowerBound`: this reuses the exact same `centre`/`spread`/
 * `denominator` algebra with a symmetric `±` instead of taking only the
 * lower half. `wilsonLowerBound` is the one-sided RANKING function (best
 * pick first) and is NOT interchangeable with this — this function answers
 * "is the baseline rate plausible given the recent sample?", not "which row
 * ranks higher?". Returns `{ lower: 0, upper: 1 }` for an empty sample (no
 * evidence rules nothing out).
 */
export function wilsonInterval(
  wins: number,
  total: number,
  z = WILSON_Z,
): { lower: number; upper: number } {
  if (total === 0) {
    return { lower: 0, upper: 1 };
  }
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return {
    lower: Math.max(0, (centre - spread) / denominator),
    upper: Math.min(1, (centre + spread) / denominator),
  };
}
