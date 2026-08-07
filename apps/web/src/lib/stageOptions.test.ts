import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { TOURNAMENT_LEGAL_STAGE_IDS } from '@smash-tracker/shared';
import { STANDARD_ONLINE_STAGE_IDS, alphaStageList, getGroupedStageOptions } from './stageOptions';

// Defined as a literal, not derived from TOURNAMENT_LEGAL_STAGE_IDS, so these
// tests actually prove something rather than tautologically re-deriving the
// expectation from the constant under test.
const EXPECTED_TOURNAMENT_LEGAL_STAGE_NAMES = [
  'Battlefield',
  'Final Destination',
  'Hollow Bastion',
  'Kalos Pokémon League',
  'Lylat Cruise',
  'Northern Cave',
  'Pokémon Stadium 2',
  'Small Battlefield',
  'Smashville',
  'Town and City',
  "Yoshi's Story",
];

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

  it('has no standard group unless the picker asks for one', () => {
    const groups = getGroupedStageOptions(matches, [1]);

    expect(groups.standard).toEqual([]);
  });

  it('returns the standard online trio in game order (Small Battlefield between its siblings)', () => {
    const groups = getGroupedStageOptions(matches, [], STANDARD_ONLINE_STAGE_IDS);

    expect(groups.standard.map((s) => s.name)).toEqual([
      'Battlefield',
      'Small Battlefield',
      'Final Destination',
    ]);
  });

  it('excludes favorited stages from the standard group (they are already pinned)', () => {
    const groups = getGroupedStageOptions(matches, [113], STANDARD_ONLINE_STAGE_IDS);

    expect(groups.standard.map((s) => s.name)).toEqual(['Battlefield', 'Final Destination']);
  });

  it('returns the tournament-legal stage set as standard, in the constant order', () => {
    const groups = getGroupedStageOptions(matches, [], TOURNAMENT_LEGAL_STAGE_IDS);

    expect(groups.standard.map((s) => s.name)).toEqual(EXPECTED_TOURNAMENT_LEGAL_STAGE_NAMES);
  });

  it('excludes a favorited tournament-legal stage from standard, leaving 10 entries', () => {
    // Pokémon Stadium 2 (id 59) favorited.
    const groups = getGroupedStageOptions(matches, [59], TOURNAMENT_LEGAL_STAGE_IDS);

    expect(groups.favorites.map((s) => s.name)).toEqual(['Pokémon Stadium 2']);
    expect(groups.standard).toHaveLength(10);
    expect(groups.standard.map((s) => s.name)).not.toContain('Pokémon Stadium 2');
  });

  it('keeps every tournament-legal stage reachable in the full alphabetical list', () => {
    const groups = getGroupedStageOptions(matches, [], TOURNAMENT_LEGAL_STAGE_IDS);

    expect(groups.all).toBe(alphaStageList);
    const allIds = new Set(groups.all.map((s) => s.id));
    for (const id of TOURNAMENT_LEGAL_STAGE_IDS) {
      expect(allIds.has(id)).toBe(true);
    }
  });
});
