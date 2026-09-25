/**
 * Deterministic PRNG utilities for the synthetic fixture generator (FIXT-02,
 * D-18, SCL-01). `mulberry32` is a compact, well-known 32-bit generator — no
 * dependency is added here; RESEARCH.md's "Don't Hand-Roll" table explicitly
 * rules out a benchmarking/randomness library for this phase, and a ~10-line
 * seeded generator is exactly what it recommends instead.
 *
 * Every helper here is a pure function of its `rng` argument — no
 * module-level mutable state — so two calls with the same seed always
 * produce the same sequence, and two generators built from different seeds
 * never interfere with each other.
 */

/**
 * A mulberry32 PRNG seeded by `seed`. Returns a closure that yields a new
 * float in `[0, 1)` on every call. The seed is coerced to a 32-bit integer
 * (`>>> 0`) so any finite number is a valid seed.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a uniformly random element from `items` using `rng`. Throws on an empty array — there is nothing deterministic to return. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick: items must be non-empty');
  }
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index]!;
}

/**
 * Picks a weighted-random element from `entries` (value/weight pairs).
 * Weights need not sum to 1 — they are normalized against their own total.
 * Throws when every weight is zero/negative, since there is then nothing to
 * weight toward.
 */
export function weightedPick<T>(rng: () => number, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) {
    throw new Error('weightedPick: total weight must be positive');
  }
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) {
      return value;
    }
  }
  // Floating-point rounding can leave `roll` fractionally positive after the
  // loop; the last entry is the correct fallback either way.
  return entries[entries.length - 1]![0];
}

/** A random integer in `[minInclusive, maxInclusive]` (inclusive on both ends). */
export function intBetween(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}
