import { describe, expect, it } from 'vitest';

import { TOURNAMENT_LEGAL_STAGE_IDS, getStageById, stagesById } from './stageData.js';

describe('TOURNAMENT_LEGAL_STAGE_IDS', () => {
  it('resolves every id through stagesById to a defined stage', () => {
    for (const id of TOURNAMENT_LEGAL_STAGE_IDS) {
      expect(stagesById.get(id)).toBeDefined();
    }
  });

  it('resolves to the exact expected stage names, in order', () => {
    const names = TOURNAMENT_LEGAL_STAGE_IDS.map((id) => getStageById(id)?.name);

    expect(names).toEqual([
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
    ]);
  });

  it('has length 11 and no repeated id', () => {
    expect(TOURNAMENT_LEGAL_STAGE_IDS).toHaveLength(11);
    expect(new Set(TOURNAMENT_LEGAL_STAGE_IDS).size).toBe(11);
  });

  it('contains no synthetic generic entries (ids 1000 / 1001)', () => {
    expect(TOURNAMENT_LEGAL_STAGE_IDS).not.toContain(1000);
    expect(TOURNAMENT_LEGAL_STAGE_IDS).not.toContain(1001);
  });
});
