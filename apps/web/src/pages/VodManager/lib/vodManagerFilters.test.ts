import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { ALL_FILTER_VALUE } from '@/pages/MatchData/lib/matchTableFilters';
import {
  DEFAULT_VOD_MANAGER_FILTERS,
  applyVodManagerFilters,
  getVodManagerFilterOptions,
  sortByRecency,
} from './vodManagerFilters';

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
    vodUrl: 'https://youtube.com/watch?v=abc123',
    ...overrides,
  };
}

describe('DEFAULT_VOD_MANAGER_FILTERS', () => {
  it('defaults fighter/opponentFighter/stage/tournament/opponent to ALL_FILTER_VALUE and tags to []', () => {
    expect(DEFAULT_VOD_MANAGER_FILTERS).toEqual({
      fighter: ALL_FILTER_VALUE,
      opponentFighter: ALL_FILTER_VALUE,
      stage: ALL_FILTER_VALUE,
      tournament: ALL_FILTER_VALUE,
      opponent: ALL_FILTER_VALUE,
      tags: [],
    });
  });

  it('does not carry a matchType field (excluded from Phase 1 per D-08)', () => {
    expect('matchType' in DEFAULT_VOD_MANAGER_FILTERS).toBe(false);
  });
});

describe('applyVodManagerFilters', () => {
  const matches = [
    makeMatch({ id: 'm1', opponent: 'Zackray', fighter_id: mario.id }),
    makeMatch({ id: 'm2', opponent: 'MkLeo', fighter_id: luigi.id }),
    makeMatch({ id: 'm3', opponent: 'Zackray', fighter_id: luigi.id }),
  ];

  it('filters to matches whose canonical opponent matches exactly', () => {
    const result = applyVodManagerFilters(matches, {
      ...DEFAULT_VOD_MANAGER_FILTERS,
      opponent: 'Zackray',
    });
    expect(result.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('returns every match when opponent filter is ALL_FILTER_VALUE', () => {
    expect(applyVodManagerFilters(matches, DEFAULT_VOD_MANAGER_FILTERS)).toHaveLength(3);
  });

  it('still AND-composes fighter/opponentFighter/stage/tournament identically to applyMatchTableFilters (delegation, not divergence)', () => {
    const result = applyVodManagerFilters(matches, {
      ...DEFAULT_VOD_MANAGER_FILTERS,
      fighter: mario.name,
      opponent: 'Zackray',
    });
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  describe('tags', () => {
    const tagMatches = [
      makeMatch({ id: 'm1', opponent: 'Zackray', tags: ['bad-matchup'] }),
      makeMatch({ id: 'm2', opponent: 'MkLeo', tags: ['tournament-set'] }),
      makeMatch({
        id: 'm3',
        opponent: 'Light',
        tags: [],
        vodTimestamps: [{ id: 'n1', seconds: 10, note: 'punish', tags: ['punish'] }],
      }),
      makeMatch({ id: 'm4', opponent: 'Tweek' }),
    ];

    it('surfaces a match whose match-level tags contain the selected tag', () => {
      const result = applyVodManagerFilters(tagMatches, {
        ...DEFAULT_VOD_MANAGER_FILTERS,
        tags: ['bad-matchup'],
      });
      expect(result.map((m) => m.id)).toEqual(['m1']);
    });

    it('surfaces a match whose ONLY hit is a note-level tag', () => {
      const result = applyVodManagerFilters(tagMatches, {
        ...DEFAULT_VOD_MANAGER_FILTERS,
        tags: ['punish'],
      });
      expect(result.map((m) => m.id)).toEqual(['m3']);
    });

    it('ORs within multiple selected tags', () => {
      const result = applyVodManagerFilters(tagMatches, {
        ...DEFAULT_VOD_MANAGER_FILTERS,
        tags: ['bad-matchup', 'punish'],
      });
      expect(result.map((m) => m.id).sort()).toEqual(['m1', 'm3']);
    });

    it('AND-composes with the dropdown filters — a tag hit excluded by opponent does not surface', () => {
      const result = applyVodManagerFilters(tagMatches, {
        ...DEFAULT_VOD_MANAGER_FILTERS,
        opponent: 'MkLeo',
        tags: ['bad-matchup'],
      });
      expect(result).toHaveLength(0);
    });

    it('returns the delegated result unchanged when tags is empty', () => {
      const result = applyVodManagerFilters(tagMatches, DEFAULT_VOD_MANAGER_FILTERS);
      expect(result).toHaveLength(4);
    });
  });
});

describe('sortByRecency', () => {
  const matches = [
    makeMatch({ id: 'm1', time: 100 }),
    makeMatch({ id: 'm2', time: 300 }),
    makeMatch({ id: 'm3', time: 200 }),
  ];

  it('orders newest-first by descending time', () => {
    const result = sortByRecency(matches, 'newest');
    expect(result.map((m) => m.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('orders oldest-first by ascending time', () => {
    const result = sortByRecency(matches, 'oldest');
    expect(result.map((m) => m.id)).toEqual(['m1', 'm3', 'm2']);
  });

  it('returns a new array without mutating the input order', () => {
    const original = [...matches];
    sortByRecency(matches, 'newest');
    expect(matches).toEqual(original);
  });
});

describe('getVodManagerFilterOptions', () => {
  it('returns fighters/opponentFighters/stages/tournaments plus a sorted deduped opponents list', () => {
    const matches = [
      makeMatch({ id: 'm1', opponent: 'Zackray' }),
      makeMatch({ id: 'm2', opponent: 'MkLeo' }),
      makeMatch({ id: 'm3', opponent: 'Zackray' }),
      makeMatch({ id: 'm4', opponent: '' }),
    ];

    const options = getVodManagerFilterOptions(matches);

    expect(options.fighters).toBeDefined();
    expect(options.opponentFighters).toBeDefined();
    expect(options.stages).toBeDefined();
    expect(options.tournaments).toBeDefined();
    expect(options.opponents).toEqual(['MkLeo', 'Zackray']);
  });

  it('derives tagsInUse from both match.tags and note tags, sorted and deduped, excluding zero-use presets', () => {
    const matches = [
      makeMatch({ id: 'm1', tags: ['bad-matchup', 'to-review'] }),
      makeMatch({
        id: 'm2',
        tags: ['bad-matchup'],
        vodTimestamps: [{ id: 'n1', seconds: 5, note: 'n', tags: ['punish', 'edgeguard'] }],
      }),
      makeMatch({ id: 'm3', tags: [] }),
    ];

    const options = getVodManagerFilterOptions(matches);

    expect(options.tagsInUse).toEqual(['bad-matchup', 'edgeguard', 'punish', 'to-review']);
    expect(options.tagsInUse).not.toContain('tournament-set');
  });
});
