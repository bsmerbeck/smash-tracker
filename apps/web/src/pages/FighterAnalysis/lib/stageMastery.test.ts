import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  buildStageMasteryCaption,
  buildStageMasteryTiles,
  tintBucketForWilson,
  STRONG_THRESHOLD,
  WEAK_THRESHOLD,
} from './stageMastery';

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'> & { map: Match['map'] },
): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const FD = { id: 2, name: 'Final Destination' };
const SMASHVILLE = { id: 3, name: 'Smashville' };

describe('tintBucketForWilson', () => {
  it('buckets below WEAK_THRESHOLD as weak', () => {
    expect(tintBucketForWilson(WEAK_THRESHOLD - 0.01)).toBe('weak');
    expect(tintBucketForWilson(0)).toBe('weak');
  });

  it('buckets between the thresholds as even', () => {
    expect(tintBucketForWilson(WEAK_THRESHOLD)).toBe('even');
    expect(tintBucketForWilson((WEAK_THRESHOLD + STRONG_THRESHOLD) / 2)).toBe('even');
    expect(tintBucketForWilson(STRONG_THRESHOLD - 0.01)).toBe('even');
  });

  it('buckets at/above STRONG_THRESHOLD as strong', () => {
    expect(tintBucketForWilson(STRONG_THRESHOLD)).toBe('strong');
    expect(tintBucketForWilson(1)).toBe('strong');
  });
});

describe('buildStageMasteryTiles', () => {
  it('includes every stage with at least one game, Wilson-ranked best first', () => {
    const matches = [
      // Battlefield: 1-4 (bad)
      makeMatch({ id: 'bf1', time: 1, win: true, map: BATTLEFIELD }),
      makeMatch({ id: 'bf2', time: 2, win: false, map: BATTLEFIELD }),
      makeMatch({ id: 'bf3', time: 3, win: false, map: BATTLEFIELD }),
      makeMatch({ id: 'bf4', time: 4, win: false, map: BATTLEFIELD }),
      makeMatch({ id: 'bf5', time: 5, win: false, map: BATTLEFIELD }),
      // FD: 10-0 (great — a large enough sample to cross the "strong" Wilson threshold)
      ...Array.from({ length: 10 }, (_, i) =>
        makeMatch({ id: `fd${i}`, time: 10 + i, win: true, map: FD }),
      ),
      // Smashville: 1-0 (single game, thin evidence)
      makeMatch({ id: 'sv1', time: 20, win: true, map: SMASHVILLE }),
    ];

    const tiles = buildStageMasteryTiles(matches);

    expect(tiles.map((t) => t.stageId)).toEqual([FD.id, SMASHVILLE.id, BATTLEFIELD.id]);
    expect(tiles.find((t) => t.stageId === FD.id)?.tint).toBe('strong');
    expect(tiles.find((t) => t.stageId === BATTLEFIELD.id)?.tint).toBe('weak');
  });

  it('excludes the unknown-stage sentinel (id 0)', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 0, name: 'no selection' } }),
    ];
    expect(buildStageMasteryTiles(matches)).toEqual([]);
  });

  it('returns an empty list when there are no matches', () => {
    expect(buildStageMasteryTiles([])).toEqual([]);
  });
});

describe('buildStageMasteryCaption', () => {
  it('reports both a best pick and ban-worthy stage when 2+ stages qualify (>=2 games each)', () => {
    const matches = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeMatch({ id: `fd${i}`, time: i, win: true, map: FD }),
      ),
      makeMatch({ id: 'bf1', time: 10, win: false, map: BATTLEFIELD }),
      makeMatch({ id: 'bf2', time: 11, win: false, map: BATTLEFIELD }),
    ];

    const caption = buildStageMasteryCaption(matches);

    expect(caption.bestPick?.stageId).toBe(FD.id);
    expect(caption.banWorthy?.stageId).toBe(BATTLEFIELD.id);
  });

  it('reports only a best pick when just one stage qualifies', () => {
    const matches = [
      makeMatch({ id: 'fd1', time: 1, win: true, map: FD }),
      makeMatch({ id: 'fd2', time: 2, win: true, map: FD }),
      // Single game elsewhere never reaches the 2-game caption threshold.
      makeMatch({ id: 'sv1', time: 3, win: false, map: SMASHVILLE }),
    ];

    const caption = buildStageMasteryCaption(matches);

    expect(caption.bestPick?.stageId).toBe(FD.id);
    expect(caption.banWorthy).toBeNull();
  });

  it('reports neither when no stage has met the threshold', () => {
    const matches = [makeMatch({ id: 'fd1', time: 1, win: true, map: FD })];
    expect(buildStageMasteryCaption(matches)).toEqual({ bestPick: null, banWorthy: null });
  });

  it('reports neither when there are no matches', () => {
    expect(buildStageMasteryCaption([])).toEqual({ bestPick: null, banWorthy: null });
  });
});
