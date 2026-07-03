import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  filterByFighter,
  getBestWorstMatchup,
  getLastNMatches,
  getMatchupStats,
  getOpponentRecords,
  getRecordsByFighter,
  getRunningWinRateSeries,
  getStageRecords,
  getStreakSummary,
  getWinLossRecord,
} from './stats';

/** Builds a minimal valid Match with sane defaults, overridable per test. */
function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('getWinLossRecord', () => {
  it('counts wins and losses and computes a rounded win rate', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
    ];
    expect(getWinLossRecord(matches)).toEqual({
      wins: 2,
      losses: 1,
      total: 3,
      winRate: 67, // 2/3 * 100 = 66.66... rounds to 67
    });
  });

  it('reports 100% win rate when there are no losses', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true })];
    expect(getWinLossRecord(matches).winRate).toBe(100);
  });

  it('reports 100% win rate for an empty match list (legacy n/a-equivalent default)', () => {
    expect(getWinLossRecord([])).toEqual({ wins: 0, losses: 0, total: 0, winRate: 100 });
  });

  it('reports 0% win rate for all losses', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: false }),
      makeMatch({ id: '2', time: 2, win: false }),
    ];
    expect(getWinLossRecord(matches).winRate).toBe(0);
  });
});

describe('filterByFighter', () => {
  it('keeps only matches for the given fighter_id', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: 1 }),
      makeMatch({ id: '2', time: 2, win: true, fighter_id: 2 }),
      makeMatch({ id: '3', time: 3, win: false, fighter_id: 1 }),
    ];
    expect(filterByFighter(matches, 1).map((m) => m.id)).toEqual(['1', '3']);
  });
});

describe('getRecordsByFighter', () => {
  it('groups by fighter_id by default', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: 1 }),
      makeMatch({ id: '2', time: 2, win: false, fighter_id: 1 }),
      makeMatch({ id: '3', time: 3, win: true, fighter_id: 2 }),
    ];
    const records = getRecordsByFighter(matches);
    expect(records).toHaveLength(2);
    const fighter1 = records.find((r) => r.fighterId === 1);
    expect(fighter1).toMatchObject({ wins: 1, losses: 1, total: 2, winRate: 50 });
    const fighter2 = records.find((r) => r.fighterId === 2);
    expect(fighter2).toMatchObject({ wins: 1, losses: 0, total: 1, winRate: 100 });
  });

  it('supports grouping by a custom key (e.g. opponent_id)', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent_id: 9 }),
      makeMatch({ id: '2', time: 2, win: false, opponent_id: 9 }),
    ];
    const records = getRecordsByFighter(matches, (m) => m.opponent_id);
    expect(records).toEqual([{ fighterId: 9, wins: 1, losses: 1, total: 2, winRate: 50 }]);
  });

  it('returns an empty array for no matches', () => {
    expect(getRecordsByFighter([])).toEqual([]);
  });
});

describe('getRunningWinRateSeries', () => {
  it('computes an unrounded running win rate in chronological order', () => {
    const matches = [
      makeMatch({ id: '3', time: 300, win: false }),
      makeMatch({ id: '1', time: 100, win: true }),
      makeMatch({ id: '2', time: 200, win: true }),
    ];
    const series = getRunningWinRateSeries(matches);
    expect(series.map((p) => p.match.id)).toEqual(['1', '2', '3']);
    expect(series.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(series[0]?.winRate).toBe(100); // 1/1
    expect(series[1]?.winRate).toBe(100); // 2/2
    expect(series[2]?.winRate).toBeCloseTo((2 / 3) * 100); // 2/3, unrounded
  });

  it('returns an empty series for no matches', () => {
    expect(getRunningWinRateSeries([])).toEqual([]);
  });
});

describe('getLastNMatches', () => {
  it('returns the most recent N matches, newest first', () => {
    const matches = [
      makeMatch({ id: '1', time: 100, win: true }),
      makeMatch({ id: '2', time: 200, win: false }),
      makeMatch({ id: '3', time: 300, win: true }),
      makeMatch({ id: '4', time: 400, win: false }),
    ];
    expect(getLastNMatches(matches, 2).map((m) => m.id)).toEqual(['4', '3']);
  });

  it('returns all matches (still newest first) when limit exceeds the count', () => {
    const matches = [
      makeMatch({ id: '1', time: 100, win: true }),
      makeMatch({ id: '2', time: 200, win: false }),
    ];
    expect(getLastNMatches(matches, 10).map((m) => m.id)).toEqual(['2', '1']);
  });

  it('returns an empty array for no matches', () => {
    expect(getLastNMatches([], 5)).toEqual([]);
  });
});

describe('getMatchupStats', () => {
  function buildMatchesAgainst(opponentId: number, wins: number, losses: number): Match[] {
    const out: Match[] = [];
    for (let i = 0; i < wins; i++) {
      out.push(
        makeMatch({ id: `w-${opponentId}-${i}`, time: i, win: true, opponent_id: opponentId }),
      );
    }
    for (let i = 0; i < losses; i++) {
      out.push(
        makeMatch({ id: `l-${opponentId}-${i}`, time: i, win: false, opponent_id: opponentId }),
      );
    }
    return out;
  }

  it('excludes matchups below the minimum match threshold', () => {
    const matches = buildMatchesAgainst(1, 2, 1); // 3 total, below default threshold of 5
    expect(getMatchupStats(matches)).toEqual([]);
  });

  it('includes matchups meeting the threshold and computes ratio', () => {
    const matches = buildMatchesAgainst(1, 4, 1); // 5 total, 80% win rate
    const stats = getMatchupStats(matches);
    expect(stats).toEqual([
      { opponentFighterId: 1, wins: 4, losses: 1, totalMatches: 5, ratio: 80 },
    ]);
  });

  it('sorts by ratio descending, tie-broken by legacy formula', () => {
    const matches = [
      ...buildMatchesAgainst(1, 3, 3), // 50% ratio, tie-break: (b.wins+b.losses)-(a.wins-a.losses)
      ...buildMatchesAgainst(2, 4, 4), // 50% ratio
    ];
    const stats = getMatchupStats(matches, 5);
    // Both have ratio 50; comparator(a=1,b=2) = (4+4)-(3-3) = 8 > 0 -> b (2) sorts after a (1)
    // is NOT swapped, so 1 stays ahead of 2 (matches legacy's exact comparator behavior).
    expect(stats.map((s) => s.opponentFighterId)).toEqual([1, 2]);
  });

  it('gives a 100% ratio for a matchup with no losses', () => {
    const matches = buildMatchesAgainst(1, 5, 0);
    expect(getMatchupStats(matches)[0]?.ratio).toBe(100);
  });

  it('respects a custom minMatches threshold', () => {
    const matches = buildMatchesAgainst(1, 2, 1); // 3 total
    expect(getMatchupStats(matches, 3)).toHaveLength(1);
    expect(getMatchupStats(matches, 4)).toHaveLength(0);
  });
});

describe('getBestWorstMatchup', () => {
  function buildMatchesAgainst(opponentId: number, wins: number, losses: number): Match[] {
    const out: Match[] = [];
    for (let i = 0; i < wins; i++) {
      out.push(
        makeMatch({ id: `w-${opponentId}-${i}`, time: i, win: true, opponent_id: opponentId }),
      );
    }
    for (let i = 0; i < losses; i++) {
      out.push(
        makeMatch({ id: `l-${opponentId}-${i}`, time: i, win: false, opponent_id: opponentId }),
      );
    }
    return out;
  }

  it('returns empty best/worst when nothing meets the threshold', () => {
    const matches = buildMatchesAgainst(1, 1, 1);
    expect(getBestWorstMatchup(matches)).toEqual({ best: [], worst: [] });
  });

  it('returns a single best/worst entry when only one matchup qualifies', () => {
    const matches = buildMatchesAgainst(1, 4, 1);
    const result = getBestWorstMatchup(matches);
    expect(result.best).toHaveLength(1);
    expect(result.worst).toHaveLength(1);
    expect(result.best[0]?.opponentFighterId).toBe(1);
    expect(result.worst[0]?.opponentFighterId).toBe(1);
  });

  it('splits qualifying matchups into best (top) and worst (bottom), capped at 3', () => {
    // 8 qualifying matchups with distinct ratios -> bwCount = floor(8/2) capped at 3 = 3
    const matches = [
      ...buildMatchesAgainst(1, 5, 0), // 100%
      ...buildMatchesAgainst(2, 4, 1), // 80%
      ...buildMatchesAgainst(3, 3, 2), // 60%
      ...buildMatchesAgainst(4, 2, 3), // 40%... total 5
      ...buildMatchesAgainst(5, 1, 4), // 20%
      ...buildMatchesAgainst(6, 5, 5), // 50%, total 10
      ...buildMatchesAgainst(7, 1, 9), // 10%, total 10
      ...buildMatchesAgainst(8, 9, 1), // 90%, total 10
    ];
    const result = getBestWorstMatchup(matches, 5);
    expect(result.best).toHaveLength(3);
    expect(result.worst).toHaveLength(3);
    // Best should start with the highest-ratio opponent.
    expect(result.best[0]?.opponentFighterId).toBe(1);
    // Worst[0] is the single worst (lowest ratio) opponent, taken from the tail.
    expect(result.worst[0]?.opponentFighterId).toBe(7);
  });
});

describe('getStreakSummary', () => {
  it('returns zeroed defaults for no matches', () => {
    expect(getStreakSummary([])).toEqual({
      bestWinStreak: 0,
      worstLossStreak: 0,
      currentStreak: 0,
      currentStreakIsWin: true,
    });
  });

  it('computes best win streak, worst loss streak, and current streak', () => {
    // Chronological: W W L L L W W W L
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
      makeMatch({ id: '4', time: 4, win: false }),
      makeMatch({ id: '5', time: 5, win: false }),
      makeMatch({ id: '6', time: 6, win: true }),
      makeMatch({ id: '7', time: 7, win: true }),
      makeMatch({ id: '8', time: 8, win: true }),
      makeMatch({ id: '9', time: 9, win: false }),
    ];
    expect(getStreakSummary(matches)).toEqual({
      bestWinStreak: 3,
      worstLossStreak: 3,
      currentStreak: 1,
      currentStreakIsWin: false,
    });
  });

  it('treats a single match as a streak of 1', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true })];
    expect(getStreakSummary(matches)).toEqual({
      bestWinStreak: 1,
      worstLossStreak: 0,
      currentStreak: 1,
      currentStreakIsWin: true,
    });
  });

  it('handles out-of-order input by sorting on time first', () => {
    const matches = [
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '3', time: 3, win: true }),
    ];
    expect(getStreakSummary(matches).currentStreak).toBe(3);
  });
});

describe('getStageRecords', () => {
  it('groups by map.id', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, map: { id: 5, name: 'Battlefield' } }),
      makeMatch({ id: '2', time: 2, win: false, map: { id: 5, name: 'Battlefield' } }),
      makeMatch({ id: '3', time: 3, win: true, map: { id: 6, name: 'FD' } }),
    ];
    const records = getStageRecords(matches);
    expect(records).toHaveLength(2);
    const stage5 = records.find((r) => r.stageId === 5);
    expect(stage5).toMatchObject({ wins: 1, losses: 1, total: 2, winRate: 50 });
  });

  it('defaults matches missing map to stage id 0, matching legacy coalescing', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, map: undefined }),
      makeMatch({ id: '2', time: 2, win: true, map: { id: 0, name: 'no selection' } }),
    ];
    const records = getStageRecords(matches);
    expect(records).toEqual([{ stageId: 0, wins: 2, losses: 0, total: 2, winRate: 100 }]);
  });
});

describe('getOpponentRecords', () => {
  it('groups by opponent name, ignoring matches with no opponent recorded', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent: 'rival' }),
      makeMatch({ id: '2', time: 2, win: false, opponent: 'rival' }),
      makeMatch({ id: '3', time: 3, win: true, opponent: '' }),
      makeMatch({ id: '4', time: 4, win: true, opponent: undefined }),
    ];
    const records = getOpponentRecords(matches);
    expect(records).toEqual([{ opponent: 'rival', wins: 1, losses: 1, total: 2, winRate: 50 }]);
  });

  it('returns an empty array when no matches have an opponent name', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true, opponent: '' })];
    expect(getOpponentRecords(matches)).toEqual([]);
  });
});
