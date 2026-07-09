import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { alphaStageList, getGroupedStageOptions } from './stageOptions';

function makeMatch(mapId: number, mapName: string, id: string): Match {
  return {
    id,
    fighter_id: 1,
    opponent_id: 10,
    time: 1_700_000_000_000,
    map: { id: mapId, name: mapName },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
  };
}

// Battlefield played 3x, Final Destination 2x, Small Battlefield 1x.
const matches: Match[] = [
  makeMatch(1, 'Battlefield', 'm1'),
  makeMatch(1, 'Battlefield', 'm2'),
  makeMatch(1, 'Battlefield', 'm3'),
  makeMatch(3, 'Final Destination', 'm4'),
  makeMatch(3, 'Final Destination', 'm5'),
  makeMatch(113, 'Small Battlefield', 'm6'),
];

describe('getGroupedStageOptions', () => {
  it('returns no favorites and usage-ordered most played when no favorites are given', () => {
    const groups = getGroupedStageOptions(matches);

    expect(groups.favorites).toEqual([]);
    expect(groups.mostPlayed.map((s) => s.name)).toEqual([
      'Battlefield',
      'Final Destination',
      'Small Battlefield',
    ]);
    expect(groups.all).toBe(alphaStageList);
  });

  it('returns favorites in the saved order, not alphabetical or usage order', () => {
    const groups = getGroupedStageOptions(matches, [113, 1, 1000]);

    expect(groups.favorites.map((s) => s.name)).toEqual([
      'Small Battlefield',
      'Battlefield',
      '(Gen. Battlefield)',
    ]);
  });

  it('excludes favorited stages from most played (they are already pinned)', () => {
    const groups = getGroupedStageOptions(matches, [1]);

    expect(groups.mostPlayed.map((s) => s.name)).toEqual([
      'Final Destination',
      'Small Battlefield',
    ]);
  });

  it('skips unknown favorite ids instead of throwing', () => {
    const groups = getGroupedStageOptions(matches, [99999, 1]);

    expect(groups.favorites.map((s) => s.name)).toEqual(['Battlefield']);
  });

  it('keeps the full alphabetical list even when stages are favorited', () => {
    const groups = getGroupedStageOptions(matches, [1, 3]);

    expect(groups.all).toBe(alphaStageList);
  });
});
