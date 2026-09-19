/**
 * OPP-03/D-11/C2-H-02: tick DENSITY and tick-label TRUNCATION for the trend
 * primitive's event-anchored mode, decided by the COMPONENT from a pure
 * helper — never delegated to Recharts' own text-measurement-driven
 * thinning. Recharts' `preserveStart`/`preserveStartEnd` interval modes
 * decide what to drop by MEASURING rendered text:
 * `lib/cartesian/getTicks.js:154,157` builds its tick sizes from
 * `getStringSize`, which measures through `getBoundingClientRect` in
 * `lib/util/DOMUtils.js`. jsdom returns all-zero rects, so every tick
 * measures zero width, nothing ever overlaps, and the thinning never fires
 * under test. Naming those modes and binding a criterion to an observed
 * reduction would be a criterion that is red on a correct implementation —
 * so `TrendLine.tsx`'s event mode does not use them at all: it calls
 * `selectEventTicks` below with the anchor keys and the axis's explicit
 * pixel width, and hands the AXIS an explicit `ticks` array. This module has
 * no React import and no chart-library import, so both questions this file
 * answers — WHICH ticks get labelled, and WHAT text a labelled tick shows —
 * are unit-testable with no DOM in play at all.
 */

/** Documented per-label pixel allowance a legible category-axis tick needs (label text plus its surrounding gap). */
const PIXELS_PER_TICK = 60;

/** A hard ceiling on how many ticks may ever be labelled, regardless of how wide the axis is — a huge width must never ask for a tick per anchor at any anchor count. */
export const MAX_EVENT_TICKS = 12;

/** The tick-label formatter's maximum character count before truncation. */
export const MAX_EVENT_TICK_LABEL_LENGTH = 12;

/**
 * Derives the maximum number of ticks that can be legibly labelled at the
 * given explicit pixel width, clamped to `MAX_EVENT_TICKS`. A non-positive
 * width can't derive a sensible count from pixels at all, so it falls back
 * to the single first/last pair `selectEventTicks` always keeps.
 */
function maxLegibleTicks(width: number): number {
  if (!(width > 0)) {
    return 2;
  }
  return Math.max(2, Math.min(MAX_EVENT_TICKS, Math.floor(width / PIXELS_PER_TICK)));
}

/**
 * WHICH ticks the event axis labels — a pure, total, deterministic function
 * of the ordered anchor keys and the axis's explicit pixel width. At or
 * below the derived maximum, every key is returned in input order (the
 * SPARSE case). Above it, a strictly smaller subsequence is returned by a
 * fixed stride (`Math.ceil(count / max)`), always keeping the first and last
 * key — the two a reader needs to orient the series in time (the DENSE
 * case). The result is always a subsequence of the input: same relative
 * order, no key invented, no key duplicated.
 */
export function selectEventTicks(anchorKeys: readonly string[], width: number): string[] {
  const count = anchorKeys.length;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return [...anchorKeys];
  }
  if (!(width > 0)) {
    // `count >= 2` here (0 and 1 are handled above), so both indices are defined.
    const first = anchorKeys[0];
    const last = anchorKeys[count - 1];
    if (first === undefined || last === undefined) {
      return [];
    }
    return first === last ? [first] : [first, last];
  }

  const max = maxLegibleTicks(width);
  if (count <= max) {
    return [...anchorKeys];
  }

  const stride = Math.ceil(count / max);
  const selected: string[] = [];
  for (let i = 0; i < count; i += stride) {
    const key = anchorKeys[i];
    if (key !== undefined) {
      selected.push(key);
    }
  }
  const lastKey = anchorKeys[count - 1];
  if (lastKey !== undefined && selected[selected.length - 1] !== lastKey) {
    selected.push(lastKey);
  }
  return selected;
}

/**
 * WHAT text a labelled tick shows — separate from `selectEventTicks` because
 * the two answer different questions. Total and deterministic, including on
 * the empty string: at or under `MAX_EVENT_TICK_LABEL_LENGTH` the label
 * returns byte-identical, otherwise it returns the first `MAX_EVENT_TICK_LABEL_LENGTH`
 * characters plus a trailing ellipsis. `TrendLine.tsx`'s event mode must not
 * inline a second, private truncation rule — every rendered tick label goes
 * through this one function, and so does the DENSE test case's expected-value
 * derivation, so the assertion pins the component's wiring rather than a
 * fixture's label length.
 */
export function formatEventTickLabel(label: string): string {
  if (label.length <= MAX_EVENT_TICK_LABEL_LENGTH) {
    return label;
  }
  return `${label.slice(0, MAX_EVENT_TICK_LABEL_LENGTH)}…`;
}
