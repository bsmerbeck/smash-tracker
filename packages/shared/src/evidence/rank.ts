import { effectiveFloor } from './policy.js';
import { gateBySampleSize } from './gate.js';

/**
 * Lower bound of the Wilson score interval (default z = 1.96 ≈ 95%): a
 * pessimistic-but-fair estimate of the true win rate given the sample size.
 * Ranking by this instead of the raw rate keeps a lucky 1-0 from outranking
 * a proven 12-3. Returns 0 for an empty sample.
 *
 * Relocated verbatim from `apps/web/src/lib/stats.ts` (V7-D) — the math was
 * never the bug; only its ranking callers needed the D-05/D-07 floor this
 * package adds around it.
 */
export function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (total === 0) {
    return 0;
  }
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - spread) / denominator);
}

/**
 * Maps each already-evidenced item to itself plus its Wilson lower bound,
 * sorted descending by that bound. Ties break by larger `totalOf` (more
 * proven), then by ascending `keyOf` (the row's own key — a numeric stage
 * id or opponent fighter id for the stage/matchup axes, a string opponent
 * identity for the opponent axis) so the same input array always produces
 * the same output order regardless of input ordering (EVID-02/ordering).
 *
 * `evidenced` is expected to already be the `evidenced` half of a
 * `gateBySampleSize` partition — this function does not gate on its own.
 */
export function rankByWilson<T>(
  evidenced: T[],
  winsOf: (item: T) => number,
  totalOf: (item: T) => number,
  keyOf: (item: T) => number | string,
): (T & { wilson: number })[] {
  return evidenced
    .map((item) => ({ ...item, wilson: wilsonLowerBound(winsOf(item), totalOf(item)) }))
    .sort((a, b) => {
      if (b.wilson !== a.wilson) {
        return b.wilson - a.wilson;
      }
      const totalA = totalOf(a);
      const totalB = totalOf(b);
      if (totalB !== totalA) {
        return totalB - totalA;
      }
      const keyA = keyOf(a);
      const keyB = keyOf(b);
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      return 0;
    });
}

/**
 * `gateBySampleSize` over `effectiveFloor(minGames)`, then `rankByWilson`
 * keyed on each row's `total` and `wilsonUngated` — the only supported way
 * to rank opponents (R3-LOW-2). `opponentEvidence.ts`'s inventory is
 * guarded against containing a floor at all; the floor belongs at the
 * INFERENCE, which is this function, not the inventory. Nothing in Phase 36
 * calls it — it exists so a Phase 37/38 consumer wanting a ranked "toughest
 * opponents" claim has a gated entry point to reach for instead of sorting
 * `rows` on the raw `wilsonUngated` field and shipping a 1-0 recommendation.
 */
export function rankOpponentsByEvidence<
  T extends { total: number; wins: number; wilsonUngated: number; identity: string },
>(rows: T[], minGames?: number): (T & { wilson: number })[] {
  const floor = effectiveFloor(minGames);
  const { evidenced } = gateBySampleSize(rows, (row) => row.total, floor);
  return rankByWilson(
    evidenced,
    (row) => row.wins,
    (row) => row.total,
    (row) => row.identity,
  );
}
