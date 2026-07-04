import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import {
  ALL_FILTER_VALUE,
  DEFAULT_MATCH_TABLE_FILTERS,
  applyMatchTableFilters,
  getMatchTableFilterOptions,
  tournamentLabel,
} from './matchTableFilters';

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

describe('tournamentLabel', () => {
  it('prefers tournamentName over eventName', () => {
    expect(tournamentLabel(makeMatch({ tournamentName: 'TBH9', eventName: 'Singles' }))).toBe(
      'TBH9',
    );
  });

  it('falls back to eventName when tournamentName is absent', () => {
    expect(tournamentLabel(makeMatch({ eventName: 'Singles' }))).toBe('Singles');
  });

  it('falls back to the em dash when neither is present', () => {
    expect(tournamentLabel(makeMatch())).toBe('—');
  });
});

describe('getMatchTableFilterOptions', () => {
  it('derives sorted, deduped option lists from the dataset', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: mario.id, matchType: 'quickplay' }),
      makeMatch({ id: 'm2', fighter_id: luigi.id, matchType: 'quickplay' }),
      makeMatch({ id: 'm3', fighter_id: mario.id, matchType: 'offline-tourney' }),
    ];

    const options = getMatchTableFilterOptions(matches);

    expect(options.fighters).toEqual([luigi.name, mario.name].sort((a, b) => a.localeCompare(b)));
    expect(options.matchTypes).toEqual(['offline-tourney', 'quickplay']);
  });

  it('excludes an empty-string matchType from the options list', () => {
    const options = getMatchTableFilterOptions([makeMatch({ matchType: '' })]);
    expect(options.matchTypes).toEqual([]);
  });

  it('includes the "—" tournament fallback as an option when present', () => {
    const options = getMatchTableFilterOptions([makeMatch()]);
    expect(options.tournaments).toEqual(['—']);
  });
});

describe('applyMatchTableFilters', () => {
  const matches = [
    makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, matchType: 'quickplay' }),
    makeMatch({ id: 'm2', fighter_id: luigi.id, opponent_id: mario.id, matchType: 'quickplay' }),
    makeMatch({
      id: 'm3',
      fighter_id: mario.id,
      opponent_id: mario.id,
      matchType: 'offline-tourney',
      map: { id: 3, name: 'Battlefield' },
    }),
  ];

  it('returns every match when all filters are "All"', () => {
    expect(applyMatchTableFilters(matches, DEFAULT_MATCH_TABLE_FILTERS)).toHaveLength(3);
  });

  it('filters by "Your Fighter"', () => {
    const result = applyMatchTableFilters(matches, {
      ...DEFAULT_MATCH_TABLE_FILTERS,
      fighter: mario.name,
    });
    expect(result.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('filters by opponent fighter', () => {
    const result = applyMatchTableFilters(matches, {
      ...DEFAULT_MATCH_TABLE_FILTERS,
      opponentFighter: luigi.name,
    });
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('filters by stage', () => {
    const result = applyMatchTableFilters(matches, {
      ...DEFAULT_MATCH_TABLE_FILTERS,
      stage: 'Battlefield',
    });
    expect(result.map((m) => m.id)).toEqual(['m3']);
  });

  it('filters by match type', () => {
    const result = applyMatchTableFilters(matches, {
      ...DEFAULT_MATCH_TABLE_FILTERS,
      matchType: 'offline-tourney',
    });
    expect(result.map((m) => m.id)).toEqual(['m3']);
  });

  it('composes multiple column filters with AND', () => {
    const result = applyMatchTableFilters(matches, {
      ...DEFAULT_MATCH_TABLE_FILTERS,
      fighter: mario.name,
      matchType: 'quickplay',
    });
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('filters by tournament, including the "—" fallback', () => {
    const withTournament = [
      makeMatch({ id: 't1', tournamentName: 'TBH9' }),
      makeMatch({ id: 't2' }),
    ];
    const result = applyMatchTableFilters(withTournament, {
      ...DEFAULT_MATCH_TABLE_FILTERS,
      tournament: '—',
    });
    expect(result.map((m) => m.id)).toEqual(['t2']);
  });

  it('sanity-checks the sentinel value used for "All"', () => {
    expect(ALL_FILTER_VALUE).toBe('__all__');
  });
});
