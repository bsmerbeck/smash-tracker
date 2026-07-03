import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { filterBySource, filterByRange } from './useFilteredMatches';

const manual = { id: 'm1', fighter_id: 1, opponent_id: 2, time: 1, win: true } as Match;
const imported = {
  id: 'sgg-1-g1',
  fighter_id: 1,
  opponent_id: 2,
  time: 2,
  win: false,
  source: 'startgg',
  externalId: 'sgg:1:g1',
} as Match;

describe('filterBySource', () => {
  it('passes everything through for all', () => {
    expect(filterBySource([manual, imported], 'all')).toHaveLength(2);
  });

  it('keeps only untagged records for manual', () => {
    expect(filterBySource([manual, imported], 'manual')).toEqual([manual]);
  });

  it('keeps only startgg-tagged records for startgg', () => {
    expect(filterBySource([manual, imported], 'startgg')).toEqual([imported]);
  });
});

describe('filterByRange', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  function matchAt(id: string, time: number): Match {
    return { id, fighter_id: 1, opponent_id: 2, time, win: true } as Match;
  }

  it('passes everything through for all', () => {
    const matches = [matchAt('1', 0), matchAt('2', now)];
    expect(filterByRange(matches, 'all', now)).toEqual(matches);
  });

  it('keeps matches within the trailing window and excludes older ones', () => {
    const within = matchAt('within', now - 10 * DAY_MS);
    const outside = matchAt('outside', now - 200 * DAY_MS);
    expect(filterByRange([within, outside], '3m', now)).toEqual([within]);
  });

  it('includes a match exactly at the cutoff boundary (inclusive)', () => {
    const cutoff = now - 90 * DAY_MS; // 3m = 30*3 days
    const atBoundary = matchAt('boundary', cutoff);
    expect(filterByRange([atBoundary], '3m', now)).toEqual([atBoundary]);
  });

  it('excludes a match one millisecond before the cutoff', () => {
    const cutoff = now - 90 * DAY_MS;
    const justBefore = matchAt('just-before', cutoff - 1);
    expect(filterByRange([justBefore], '3m', now)).toEqual([]);
  });

  it('applies the correct window for 6m and 12m', () => {
    const at6m = matchAt('6m', now - 180 * DAY_MS);
    const at12m = matchAt('12m', now - 360 * DAY_MS);
    const tooOld = matchAt('too-old', now - 400 * DAY_MS);
    expect(filterByRange([at6m, at12m, tooOld], '6m', now)).toEqual([at6m]);
    expect(filterByRange([at6m, at12m, tooOld], '12m', now)).toEqual([at6m, at12m]);
  });
});
