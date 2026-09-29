import { afterAll, describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import { classify } from './insight/ladder.js';
import type { RateValue } from './insight/types.js';
import { RECENT_GAME_WINDOW } from './insight/policy.js';
import {
  DIGEST_MOVED_ROW_CAP,
  MOVED_FALSE_DIRECTION_BUDGET,
  MOVED_NOTABLE_Z,
  movedTransition,
  selectMovedItems,
  stateClassFor,
  stateClassFromClassify,
  type DigestMovedEntry,
  type DigestStateClass,
} from './digest.js';
import { WATCHLIST_MAX_ITEMS, type WatchlistItem } from './watchlist.js';

/**
 * G14 / CONTEXT multiple-comparisons lesson: the digest runs a max-of-25
 * selection on every visit, so its "moved" threshold is a MEASURED number.
 *
 * This harness simulates at the RATE level for speed (a seeded outcome bit
 * array per item; the REAL `classify` at the z under test) and a cross-check
 * case proves the fast path equals `stateClassFor` over generated `Match`
 * rows, so the harness measures the production path rather than a
 * re-implementation. There is no runtime randomness and no clock: the PRNG is
 * local and every seed is derived from the cell and trial index.
 *
 * A green budget proves nothing unless the wrong threshold fails the same
 * harness — the z = 1.96 control below is that proven failing case.
 */

/**
 * Digests simulated per cell; every digest holds a full 25-item roster.
 *
 * Sized for POWER, not just for speed: at z = 3.09 the true worst-cell rate is
 * about 0.03-0.04 (measured over 4,000 digests per cell), so the 0.05 budget sits
 * about 1.5 standard errors from it at 500 trials and a seeded run can land above
 * it by noise alone (one cell read 0.054 at 500). 2,000 trials cuts the standard
 * error to about 0.4 points (the budget over 3 standard errors from the worst
 * cell) and leaves the budget unchanged.
 */
const N_TRIALS = 2000;

const ITEMS_PER_DIGEST = WATCHLIST_MAX_ITEMS;
const NULL_RATE = 0.5;
const SHIFT_FROM_RATE = 0.5;
const SHIFT_TO_RATE = 0.9;
const SHIFT_NEW_GAMES = 30;
const SHIFT_PRIOR_GAMES = 200;
const SHIFT_MIN_DETECTION = 0.8;
const ENGINE_DEFAULT_Z = 1.96;

const PRIOR_GAMES = [51, 80, 200, 1000] as const;
const NEW_GAMES = [5, 15, 30] as const;
const CELLS = PRIOR_GAMES.flatMap((g0) => NEW_GAMES.map((added) => ({ g0, added })));

/** Local mulberry32 — the same generator family `nullFixtures.ts` uses; no runtime randomness. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(cellIndex: number, trial: number, salt: number): number {
  return (Math.imul(cellIndex + 1, 1_000_003) + Math.imul(trial + 1, 7919) + salt) >>> 0;
}

/** The engine's `RateValue` shape, built exactly as `toRateValue` builds it. */
function rateValue(wins: number, total: number): RateValue {
  const losses = total - wins;
  return { wins, losses, total, rate: total > 0 ? wins / total : 0 };
}

/** One item's outcome history summarised for the two reads a digest compares. */
interface ItemReads {
  before: DigestStateClass;
  after: DigestStateClass;
}

function classOfBits(bits: Uint8Array, upTo: number, z: number): DigestStateClass {
  let allWins = 0;
  for (let i = 0; i < upTo; i += 1) allWins += bits[i]!;
  const recentTotal = Math.min(RECENT_GAME_WINDOW, upTo);
  let recentWins = 0;
  for (let i = upTo - recentTotal; i < upTo; i += 1) recentWins += bits[i]!;
  return stateClassFromClassify(
    classify({
      recent: rateValue(recentWins, recentTotal),
      baseline: rateValue(allWins, upTo),
      scoped: true,
      hasAction: false,
      z,
    }),
  );
}

function drawBits(
  rng: () => number,
  count: number,
  rate: number,
  out: Uint8Array,
  from: number,
): void {
  for (let i = from; i < from + count; i += 1) out[i] = rng() < rate ? 1 : 0;
}

function readItem(params: {
  rng: () => number;
  g0: number;
  added: number;
  newRate: number;
  z: number;
}): ItemReads {
  const { rng, g0, added, newRate, z } = params;
  const bits = new Uint8Array(g0 + added);
  drawBits(rng, g0, NULL_RATE, bits, 0);
  drawBits(rng, added, newRate, bits, g0);
  return { before: classOfBits(bits, g0, z), after: classOfBits(bits, g0 + added, z) };
}

const DIRECTION_TOKENS = new Set(['up', 'down', 'asserting']);

interface CellMeasurement {
  falseDirectionRate: number;
  maxShown: number;
  cappedOk: boolean;
}

const measurementCache = new Map<string, CellMeasurement>();

/** P(a 25-item null digest shows at least one false DIRECTION move) over N_TRIALS seeded digests. */
function measureNullCell(cellIndex: number, g0: number, added: number, z: number): CellMeasurement {
  const cacheKey = `${cellIndex}:${g0}:${added}:${z}`;
  const cached = measurementCache.get(cacheKey);
  if (cached) return cached;

  let digestsWithFalseDirection = 0;
  let maxShown = 0;
  let cappedOk = true;
  for (let trial = 0; trial < N_TRIALS; trial += 1) {
    const rng = makeRng(seedFor(cellIndex, trial, 0x51ed));
    let anyDirection = false;
    const moved: DigestMovedEntry[] = [];
    for (let item = 0; item < ITEMS_PER_DIGEST; item += 1) {
      const reads = readItem({ rng, g0, added, newRate: NULL_RATE, z });
      const token = movedTransition(reads.before, reads.after);
      if (token === null) continue;
      moved.push({ itemKey: `stage:${item + 1}`, token, salience: rng() });
      if (DIRECTION_TOKENS.has(token)) anyDirection = true;
    }
    if (anyDirection) digestsWithFalseDirection += 1;
    const { shown, moreCount } = selectMovedItems(moved);
    maxShown = Math.max(maxShown, shown.length);
    if (shown.length > DIGEST_MOVED_ROW_CAP || shown.length + moreCount !== moved.length) {
      cappedOk = false;
    }
  }
  const result = { falseDirectionRate: digestsWithFalseDirection / N_TRIALS, maxShown, cappedOk };
  measurementCache.set(cacheKey, result);
  return result;
}

function measureShiftDetection(): number {
  let detected = 0;
  for (let trial = 0; trial < N_TRIALS; trial += 1) {
    const rng = makeRng(seedFor(99, trial, 0x5117));
    const bits = new Uint8Array(SHIFT_PRIOR_GAMES + SHIFT_NEW_GAMES);
    drawBits(rng, SHIFT_PRIOR_GAMES, SHIFT_FROM_RATE, bits, 0);
    drawBits(rng, SHIFT_NEW_GAMES, SHIFT_TO_RATE, bits, SHIFT_PRIOR_GAMES);
    const before = classOfBits(bits, SHIFT_PRIOR_GAMES, MOVED_NOTABLE_Z);
    const after = classOfBits(bits, SHIFT_PRIOR_GAMES + SHIFT_NEW_GAMES, MOVED_NOTABLE_Z);
    if (movedTransition(before, after) === 'up') detected += 1;
  }
  return detected / N_TRIALS;
}

const report: string[] = [];

afterAll(() => {
  if (report.length > 0) {
    console.info(
      `digest null-roster harness (N_TRIALS=${N_TRIALS}, ${ITEMS_PER_DIGEST} items, true rate ${NULL_RATE}, z=${MOVED_NOTABLE_Z}):\n${report.join('\n')}`,
    );
  }
});

describe('digest "moved" null-roster budget (G14)', () => {
  it('a full-size roster and a real trial count are simulated', () => {
    expect(ITEMS_PER_DIGEST).toBe(25);
    expect(N_TRIALS).toBeGreaterThanOrEqual(200);
    expect(CELLS).toHaveLength(12);
  });

  it.each(CELLS.map((cell, index) => ({ ...cell, index })))(
    'g0=$g0, +$added games: P(any false direction move in a 25-item digest) is at or below the budget at MOVED_NOTABLE_Z',
    ({ g0, added, index }) => {
      const measured = measureNullCell(index, g0, added, MOVED_NOTABLE_Z);
      report.push(
        `  g0=${String(g0).padStart(4)} +${String(added).padStart(2)}: false-direction rate ${measured.falseDirectionRate.toFixed(4)} (budget ${MOVED_FALSE_DIRECTION_BUDGET})`,
      );
      expect(measured.falseDirectionRate).toBeLessThanOrEqual(MOVED_FALSE_DIRECTION_BUDGET);
    },
  );

  it('discriminating control: the SAME harness at the engine default z = 1.96 exceeds the budget (g0=200, +15)', () => {
    const cellIndex = CELLS.findIndex((cell) => cell.g0 === 200 && cell.added === 15);
    const measured = measureNullCell(cellIndex, 200, 15, ENGINE_DEFAULT_Z);
    report.push(
      `  control z=${ENGINE_DEFAULT_Z} g0= 200 +15: false-direction rate ${measured.falseDirectionRate.toFixed(4)}`,
    );
    expect(measured.falseDirectionRate).toBeGreaterThan(MOVED_FALSE_DIRECTION_BUDGET);
  });

  it('non-vacuity: a true-rate shift 0.5 -> 0.9 over 30 new games at g0=200 is detected in at least 80% of seeded trials', () => {
    const detection = measureShiftDetection();
    report.push(
      `  shift ${SHIFT_FROM_RATE} -> ${SHIFT_TO_RATE} over ${SHIFT_NEW_GAMES} games at g0=${SHIFT_PRIOR_GAMES}: detected ${detection.toFixed(4)}`,
    );
    expect(detection).toBeGreaterThanOrEqual(SHIFT_MIN_DETECTION);
  });

  it('selectMovedItems never returns more than 5 shown items in any simulated digest, and loses none to the count', () => {
    CELLS.forEach((cell, index) => {
      const measured = measureNullCell(index, cell.g0, cell.added, MOVED_NOTABLE_Z);
      expect(measured.maxShown).toBeLessThanOrEqual(DIGEST_MOVED_ROW_CAP);
      expect(measured.cappedOk).toBe(true);
    });
  });
});

describe('anti-drift: the bit-level harness path equals stateClassFor over generated Match rows', () => {
  const NOW_MS = 1_700_000_000_000;
  const HOUR_MS = 3_600_000;

  interface Spec {
    g0: number;
    added: number;
    newRate: number;
  }

  /** A mix that reaches locked, thinRecent, collapsed, steady, up and down — not only the null steady case. */
  function specFor(item: number): Spec {
    if (item === 0) return { g0: 200, added: 30, newRate: 0.9 };
    if (item === 1) return { g0: 200, added: 30, newRate: 0.1 };
    if (item === 2) return { g0: 2, added: 15, newRate: NULL_RATE };
    if (item === 3) return { g0: 5, added: 1, newRate: NULL_RATE };
    return { g0: 80 + (item % 4) * 40, added: 5 + (item % 3) * 10, newRate: NULL_RATE };
  }

  function rowsFor(bits: Uint8Array, upTo: number): Match[] {
    const rows: Match[] = [];
    for (let i = 0; i < upTo; i += 1) {
      rows.push({
        id: `g${String(i).padStart(5, '0')}`,
        fighter_id: 1,
        opponent_id: 10,
        opponent: 'rival',
        time: NOW_MS - (upTo - 1 - i) * HOUR_MS,
        win: bits[i] === 1,
        matchType: 'none',
      });
    }
    return rows;
  }

  const ITEM: WatchlistItem = {
    kind: 'matchup',
    ref: { fighterId: 1, vsFighterId: 10 },
    createdAt: 1,
  };

  it.each([11, 22, 33])('seed %i: every item class (before and after) agrees', (seed) => {
    const rng = makeRng(seed);
    const classesSeen = new Set<DigestStateClass>();
    for (let item = 0; item < ITEMS_PER_DIGEST; item += 1) {
      const { g0, added, newRate } = specFor(item);
      const bits = new Uint8Array(g0 + added);
      drawBits(rng, g0, NULL_RATE, bits, 0);
      drawBits(rng, added, newRate, bits, g0);
      const beforeRows = rowsFor(bits, g0);
      const afterRows = rowsFor(bits, g0 + added);
      // The item's "after" history ends at NOW; its "before" history is a prefix of the same games,
      // so both reads are taken at the same NOW_MS with the same scope.
      const expectedBefore = classOfBits(bits, g0, MOVED_NOTABLE_Z);
      const expectedAfter = classOfBits(bits, g0 + added, MOVED_NOTABLE_Z);
      const gotBefore = stateClassFor({
        matches: beforeRows,
        item: ITEM,
        nowMs: NOW_MS,
        opponentAliases: [],
      });
      const gotAfter = stateClassFor({
        matches: afterRows,
        item: ITEM,
        nowMs: NOW_MS,
        opponentAliases: [],
      });
      expect(gotBefore, `seed ${seed} item ${item} before`).toBe(expectedBefore);
      expect(gotAfter, `seed ${seed} item ${item} after`).toBe(expectedAfter);
      classesSeen.add(gotBefore);
      classesSeen.add(gotAfter);
    }
    // Non-vacuity of the cross-check itself: it compared more than one class.
    expect(classesSeen.size).toBeGreaterThanOrEqual(3);
  });
});
