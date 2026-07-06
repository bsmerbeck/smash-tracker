import { describe, expect, it } from 'vitest';
import type { ScoutGame } from '@smash-tracker/shared';
import { scoutGamesToMatches } from './fullAnalysis';

function makeGame(overrides: Partial<ScoutGame> = {}): ScoutGame {
  return {
    time: 1_700_000_000_000,
    win: true,
    fighterId: 67,
    opponentFighterId: 41,
    stageId: 1,
    stageName: 'Battlefield',
    opponentTag: 'PowPow',
    eventName: 'Ultimate Singles',
    ...overrides,
  };
}

describe('scoutGamesToMatches', () => {
  it('maps every field to its Match equivalent', () => {
    const matches = scoutGamesToMatches([makeGame()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      fighter_id: 67,
      opponent_id: 41,
      time: 1_700_000_000_000,
      win: true,
      opponent: 'PowPow',
      matchType: 'none',
      map: { id: 1, name: 'Battlefield' },
      eventName: 'Ultimate Singles',
    });
  });

  it('assigns each game a unique, stable-order synthetic id', () => {
    const matches = scoutGamesToMatches([makeGame(), makeGame({ win: false })]);
    expect(matches[0]?.id).not.toBe(matches[1]?.id);
  });

  it('omits `map` entirely when the game has no resolved stage', () => {
    const matches = scoutGamesToMatches([makeGame({ stageId: undefined, stageName: undefined })]);
    expect(matches[0]?.map).toBeUndefined();
  });

  it('omits `eventName` when absent', () => {
    const matches = scoutGamesToMatches([makeGame({ eventName: undefined })]);
    expect(matches[0]?.eventName).toBeUndefined();
  });

  it('preserves the fighterId-0 / opponentFighterId-0 sentinels as plain numbers', () => {
    const matches = scoutGamesToMatches([makeGame({ opponentFighterId: 0 })]);
    expect(matches[0]?.opponent_id).toBe(0);
  });

  it('returns an empty array for an empty input', () => {
    expect(scoutGamesToMatches([])).toEqual([]);
  });
});
