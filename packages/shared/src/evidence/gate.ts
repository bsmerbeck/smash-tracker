/**
 * D-07's GATE half: partitions candidates into `evidenced` (>= floor) and
 * `abstained` (< floor) by whatever sample-size accessor the caller
 * provides. Independently callable — not private to any one ranking
 * function — so a caller building a new ranked claim can reuse the gate
 * without re-deriving the partition logic.
 */
export function gateBySampleSize<T>(
  candidates: T[],
  sampleOf: (item: T) => number,
  floor: number,
): { evidenced: T[]; abstained: T[] } {
  const evidenced: T[] = [];
  const abstained: T[] = [];
  for (const item of candidates) {
    if (sampleOf(item) >= floor) {
      evidenced.push(item);
    } else {
      abstained.push(item);
    }
  }
  return { evidenced, abstained };
}
