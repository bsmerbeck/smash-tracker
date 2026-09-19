import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
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
  it('includes every stage with at least the abstention-floor game count, Wilson-ranked best first', () => {
    // Phase 36 (D-05/D-07): `rankStagesByEvidence`'s underlying floor is now
    // ABSTENTION_FLOOR_GAMES (3), so a 1-game stage no longer clears the
    // gate at all — Smashville's single game is excluded entirely rather
    // than appearing as a thin-evidence tile. The inline `1` this component
    // passes is retired in plan 36-02 Task 3; this test only keeps the tree
    // green for this plan.
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
      // Smashville: 1-0 (single game — now abstained below the floor and excluded)
      makeMatch({ id: 'sv1', time: 20, win: true, map: SMASHVILLE }),
    ];

    const tiles = buildStageMasteryTiles(matches);

    expect(tiles.map((t) => t.stageId)).toEqual([FD.id, BATTLEFIELD.id]);
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

/**
 * Phase 38-06 (ADV-03/D-13): `buildStageMasteryCaption` and its dedicated
 * test cases are retired — `StageMastery.tsx`'s caption now comes from
 * `buildStageEvidence` (`@smash-tracker/shared`), asserted at the component
 * level (`StageMastery.test.tsx`) where the engine call and the sample cue
 * render together. The tile-builder and tint-bucketing cases above are
 * unchanged by this retirement.
 */
