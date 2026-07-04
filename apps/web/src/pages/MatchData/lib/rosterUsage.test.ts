import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { buildRosterUsage, winRateTone } from './rosterUsage';

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const kirby = SpriteList.find((s) => s.id === 7)!;

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

describe('buildRosterUsage', () => {
  it('returns one row per fighter actually played, ordered by usage (games) descending', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: mario.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, win: true }),
      makeMatch({ id: 'm3', fighter_id: mario.id, win: false }),
      makeMatch({ id: 'm4', fighter_id: luigi.id, win: true }),
    ];

    const rows = buildRosterUsage(matches, [mario, luigi]);

    expect(rows.map((r) => r.fighter.id)).toEqual([mario.id, luigi.id]);
    expect(rows[0]).toMatchObject({ games: 3, wins: 2, losses: 1, usagePercent: 75 });
    expect(rows[1]).toMatchObject({ games: 1, wins: 1, losses: 0, usagePercent: 25 });
  });

  it('omits selected fighters with zero games played', () => {
    const matches = [makeMatch({ fighter_id: mario.id })];

    const rows = buildRosterUsage(matches, [mario, luigi, kirby]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.fighter.id).toBe(mario.id);
  });

  it('breaks ties in usage by fighter name for stable ordering', () => {
    const matches = [
      makeMatch({ id: 'm1', fighter_id: luigi.id }),
      makeMatch({ id: 'm2', fighter_id: mario.id }),
    ];

    const rows = buildRosterUsage(matches, [luigi, mario]);

    // Same games count (1 each) -> alphabetical by name.
    expect(rows.map((r) => r.fighter.name)).toEqual(
      [luigi.name, mario.name].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('returns an empty array when there are no matches', () => {
    expect(buildRosterUsage([], [mario])).toEqual([]);
  });

  it('returns an empty array when the user has no selected fighters', () => {
    expect(buildRosterUsage([makeMatch()], [])).toEqual([]);
  });
});

describe('winRateTone', () => {
  it('is positive at and above 55%', () => {
    expect(winRateTone(55)).toBe('positive');
    expect(winRateTone(100)).toBe('positive');
  });

  it('is neutral between 45% and 55% (exclusive upper handled by positive)', () => {
    expect(winRateTone(45)).toBe('neutral');
    expect(winRateTone(50)).toBe('neutral');
    expect(winRateTone(54)).toBe('neutral');
  });

  it('is negative below 45%', () => {
    expect(winRateTone(44)).toBe('negative');
    expect(winRateTone(0)).toBe('negative');
  });
});
