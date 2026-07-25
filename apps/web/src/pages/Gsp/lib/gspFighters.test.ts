import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { getGspFighterOptions } from './gspFighters';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'quickplay',
    ...overrides,
  };
}

describe('getGspFighterOptions', () => {
  it('returns an empty list with no matches and no fighter selections', () => {
    expect(getGspFighterOptions([])).toEqual([]);
  });

  it('includes a fighter with at least one gsp-bearing match', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true, fighter_id: 1, gsp: 1000 })];
    const options = getGspFighterOptions(matches);
    expect(options.map((f) => f.id)).toContain(1);
  });

  it('excludes fighters with matches but no gsp reading', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true, fighter_id: 1 })];
    expect(getGspFighterOptions(matches)).toEqual([]);
  });

  it('includes primary/secondary fighters even with no gsp matches', () => {
    const options = getGspFighterOptions([], [1], [2]);
    expect(options.map((f) => f.id).sort()).toEqual([1, 2]);
  });

  it('de-duplicates fighters appearing in both matches and selections', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true, fighter_id: 1, gsp: 1000 })];
    const options = getGspFighterOptions(matches, [1]);
    expect(options.filter((f) => f.id === 1)).toHaveLength(1);
  });

  it('sorts results alphabetically by name (default English fallback)', () => {
    // Fighter ids 1 (Mario) and 8 (Fox) per fighterData — Fox should sort before Mario.
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: 1, gsp: 1000 }),
      makeMatch({ id: '2', time: 2, win: true, fighter_id: 8, gsp: 1000 }),
    ];
    const options = getGspFighterOptions(matches);
    const names = options.map((f) => f.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('ignores unknown fighter ids gracefully', () => {
    const options = getGspFighterOptions([], [999999]);
    expect(options).toEqual([]);
  });

  // 260725-Q1: sorts by the caller-supplied localized name resolver instead
  // of the roster's English `.name`, so GspPage's locale-aware picker sorts
  // correctly for every locale — not just en.
  it('sorts by a caller-supplied localized name resolver when provided', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: 1, gsp: 1000 }), // Mario
      makeMatch({ id: '2', time: 2, win: true, fighter_id: 8, gsp: 1000 }), // Fox
      makeMatch({ id: '3', time: 3, win: true, fighter_id: 13, gsp: 1000 }), // Jigglypuff
    ];
    // A fake "localized" resolver where Jigglypuff (13) translates to
    // "Zzz" — should sort dead last instead of its English alphabetical
    // position (before Mario).
    const localizedName = (id: number) => (id === 13 ? 'Zzz' : id === 1 ? 'Mario' : 'Fox');
    const options = getGspFighterOptions(matches, [], [], localizedName);
    expect(options.map((f) => f.id)).toEqual([8, 1, 13]);
  });
});
