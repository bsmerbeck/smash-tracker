import { describe, expect, it } from 'vitest';
import {
  buildSessionBucketsMark,
  buildSetStripMark,
  readSessionBucketsMark,
  readSetStripMark,
} from './marks.js';
import type { InsightMark } from './types.js';

/**
 * Plan 39.1-40 (sketch 002-C, D-13, DD-12): the two card-mark payloads the
 * Trends reads rail draws — SessionFatigue's three game-number buckets and
 * LastEventRecap's set strip — and their validating readers. A reader never
 * trusts a payload's shape: any other kind, a missing mark or a malformed
 * payload reads as null (the card then draws no mark).
 */

const BUCKETS = [
  { fromGame: 1, toGame: 10, wins: 60, losses: 40, total: 100 },
  { fromGame: 11, toGame: 20, wins: 45, losses: 45, total: 90 },
  { fromGame: 21, toGame: null, wins: 12, losses: 18, total: 30 },
];

const SETS = [
  { setId: 's1', won: true, opponentName: 'rival', gamesWon: 2, gamesLost: 1 },
  { setId: 's2', won: false, opponentName: null, gamesWon: 1, gamesLost: 3 },
];

describe('marks (39.1-40)', () => {
  it('buildSessionBucketsMark -> readSessionBucketsMark round-trips the three buckets', () => {
    const mark = buildSessionBucketsMark(BUCKETS);
    expect(mark.kind).toBe('sessionBuckets');
    expect(readSessionBucketsMark(mark)).toEqual({ buckets: BUCKETS });
  });

  it('buildSetStripMark -> readSetStripMark round-trips the sets in order', () => {
    const mark = buildSetStripMark(SETS);
    expect(mark.kind).toBe('setStrip');
    expect(readSetStripMark(mark)).toEqual({ sets: SETS });
  });

  it('readers return null for a missing mark or another kind', () => {
    expect(readSessionBucketsMark(undefined)).toBeNull();
    expect(readSetStripMark(undefined)).toBeNull();
    expect(readSessionBucketsMark(buildSetStripMark(SETS))).toBeNull();
    expect(readSetStripMark(buildSessionBucketsMark(BUCKETS))).toBeNull();
    expect(readSessionBucketsMark({ kind: 'meters', data: {} })).toBeNull();
  });

  it.each([
    ['two buckets (wrong length)', { buckets: BUCKETS.slice(0, 2) }],
    ['four buckets (wrong length)', { buckets: [...BUCKETS, BUCKETS[0]] }],
    ['a non-numeric count', { buckets: [{ ...BUCKETS[0], wins: '60' }, BUCKETS[1], BUCKETS[2]] }],
    ['a NaN total', { buckets: [BUCKETS[0], { ...BUCKETS[1], total: Number.NaN }, BUCKETS[2]] }],
    [
      'a total that is not wins + losses',
      { buckets: [{ ...BUCKETS[0], total: 7 }, BUCKETS[1], BUCKETS[2]] },
    ],
    ['buckets not an array', { buckets: 'x' }],
    ['no data', null],
  ])('readSessionBucketsMark rejects a malformed payload: %s', (_label, data) => {
    const mark: InsightMark = { kind: 'sessionBuckets', data };
    expect(readSessionBucketsMark(mark)).toBeNull();
  });

  it.each([
    ['an empty set list', { sets: [] }],
    ['a non-numeric games count', { sets: [{ ...SETS[0], gamesWon: 'two' }] }],
    ['a non-boolean won', { sets: [{ ...SETS[0], won: 1 }] }],
    ['a numeric opponent name', { sets: [{ ...SETS[0], opponentName: 3 }] }],
    ['a missing set id', { sets: [{ ...SETS[0], setId: undefined }] }],
    ['sets not an array', { sets: {} }],
  ])('readSetStripMark rejects a malformed payload: %s', (_label, data) => {
    const mark: InsightMark = { kind: 'setStrip', data };
    expect(readSetStripMark(mark)).toBeNull();
  });
});
