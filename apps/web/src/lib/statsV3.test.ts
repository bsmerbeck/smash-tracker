import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  getMatchupMatrix,
  getMonthlyRecords,
  getOnlineOfflineSplit,
  getOpponentProfile,
  getRollingWinRate,
  getSessions,
  rankMatchupsByEvidence,
  rankStagesByEvidence,
  wilsonLowerBound,
} from './stats';

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

describe('wilsonLowerBound', () => {
  it('is 0 for an empty sample', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('matches the closed-form value for known inputs', () => {
    // p=1, n=1, z=1.96: (1 + 1.9208 - 1.96*sqrt(0.9604)/1) / (1 + 3.8416/1)... = 0.2065
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 3);
    // p=0.8, n=15: ≈ 0.5481
    expect(wilsonLowerBound(12, 15)).toBeCloseTo(0.5481, 3);
    // p=0.5, n=100: ≈ 0.4038
    expect(wilsonLowerBound(50, 100)).toBeCloseTo(0.4038, 3);
  });

  it('never lets a small perfect sample outrank a large strong one', () => {
    expect(wilsonLowerBound(1, 1)).toBeLessThan(wilsonLowerBound(12, 15));
  });

  it('is monotonic in sample size at a fixed rate', () => {
    expect(wilsonLowerBound(5, 10)).toBeLessThan(wilsonLowerBound(50, 100));
  });
});

describe('rankMatchupsByEvidence', () => {
  it('ranks a proven record above a lucky 1-0', () => {
    const matches = [
      // 1-0 vs opponent 10
      makeMatch({ id: 'a', time: 1, win: true, opponent_id: 10 }),
      // 8-2 vs opponent 20
      ...Array.from({ length: 8 }, (_, i) =>
        makeMatch({ id: `w${i}`, time: 10 + i, win: true, opponent_id: 20 }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeMatch({ id: `l${i}`, time: 30 + i, win: false, opponent_id: 20 }),
      ),
    ];
    const ranked = rankMatchupsByEvidence(matches);
    expect(ranked[0]?.opponentFighterId).toBe(20);
    expect(ranked[0]?.wilson).toBeGreaterThan(ranked[1]?.wilson ?? 1);
  });

  it('hides rows below minMatches without affecting ranking math', () => {
    const matches = [
      makeMatch({ id: 'a', time: 1, win: true, opponent_id: 10 }),
      makeMatch({ id: 'b', time: 2, win: true, opponent_id: 20 }),
      makeMatch({ id: 'c', time: 3, win: false, opponent_id: 20 }),
    ];
    expect(rankMatchupsByEvidence(matches, 2)).toHaveLength(1);
  });
});

describe('rankStagesByEvidence', () => {
  it('excludes the unknown-stage sentinel and ranks by wilson', () => {
    const stage = (id: number, name: string) => ({ id, name });
    const matches = [
      makeMatch({ id: 'u', time: 1, win: true }), // stage 0 sentinel
      makeMatch({ id: 'b1', time: 2, win: true, map: stage(1, 'Battlefield') }),
      ...Array.from({ length: 6 }, (_, i) =>
        makeMatch({ id: `s${i}`, time: 10 + i, win: i < 5, map: stage(3, 'Smashville') }),
      ),
    ];
    const ranked = rankStagesByEvidence(matches);
    expect(ranked.map((r) => r.stageId)).toEqual([3, 1]); // 5-1 beats 1-0
    expect(ranked.find((r) => r.stageId === 0)).toBeUndefined();
  });
});

describe('getRollingWinRate', () => {
  it('computes trailing-window rates chronologically', () => {
    // W W L L with window 2 -> 100, 100, 50, 0
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
      makeMatch({ id: '4', time: 4, win: false }),
    ];
    const series = getRollingWinRate(matches, 2);
    expect(series.map((p) => p.winRate)).toEqual([100, 100, 50, 0]);
  });
});

describe('getMonthlyRecords', () => {
  it('groups by UTC calendar month in ascending order', () => {
    const jan = Date.UTC(2021, 0, 15);
    const feb = Date.UTC(2021, 1, 2);
    const records = getMonthlyRecords([
      makeMatch({ id: 'f', time: feb, win: false }),
      makeMatch({ id: 'j1', time: jan, win: true }),
      makeMatch({ id: 'j2', time: jan + 1000, win: true }),
    ]);
    expect(records.map((r) => r.month)).toEqual(['2021-01', '2021-02']);
    expect(records[0]).toMatchObject({ wins: 2, losses: 0 });
  });
});

describe('getOnlineOfflineSplit', () => {
  it('buckets quickplay and online-* as online, offline-* as offline', () => {
    const split = getOnlineOfflineSplit([
      makeMatch({ id: '1', time: 1, win: true, matchType: 'quickplay' }),
      makeMatch({ id: '2', time: 2, win: false, matchType: 'online-tourney' }),
      makeMatch({ id: '3', time: 3, win: true, matchType: 'offline-friendly' }),
      makeMatch({ id: '4', time: 4, win: true, matchType: 'none' }),
      makeMatch({ id: '5', time: 5, win: false, matchType: '' }),
    ]);
    expect(split.online).toMatchObject({ wins: 1, losses: 1, total: 2 });
    expect(split.offline).toMatchObject({ wins: 1, losses: 0, total: 1 });
    expect(split.unspecified).toMatchObject({ wins: 1, losses: 1, total: 2 });
  });
});

describe('getSessions', () => {
  const HOUR = 60 * 60 * 1000;

  it('splits on gaps beyond the threshold and tracks intra-session tilt', () => {
    const sessions = getSessions(
      [
        // session 1: W L L L (tilt run 3)
        makeMatch({ id: '1', time: 0, win: true }),
        makeMatch({ id: '2', time: HOUR, win: false }),
        makeMatch({ id: '3', time: 2 * HOUR, win: false }),
        makeMatch({ id: '4', time: 2.5 * HOUR, win: false }),
        // 5h gap -> session 2: W W
        makeMatch({ id: '5', time: 7.5 * HOUR, win: true }),
        makeMatch({ id: '6', time: 8 * HOUR, win: true }),
      ],
      3 * HOUR,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ wins: 1, losses: 3, longestLossRun: 3 });
    expect(sessions[1]).toMatchObject({ wins: 2, losses: 0, longestLossRun: 0 });
    expect(sessions[0]?.start).toBe(0);
    expect(sessions[0]?.end).toBe(2.5 * HOUR);
  });

  it('returns no sessions for no matches', () => {
    expect(getSessions([])).toEqual([]);
  });
});

describe('getOpponentProfile', () => {
  it('builds a head-to-head profile with their characters ranked', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent: 'powpow', opponent_id: 41 }),
      makeMatch({ id: '2', time: 2, win: false, opponent: 'powpow', opponent_id: 41 }),
      makeMatch({ id: '3', time: 3, win: true, opponent: 'powpow', opponent_id: 7 }),
      makeMatch({ id: '4', time: 4, win: true, opponent: 'someone-else', opponent_id: 41 }),
    ];
    const profile = getOpponentProfile(matches, 'powpow');
    expect(profile).not.toBeNull();
    expect(profile?.record).toMatchObject({ wins: 2, losses: 1, total: 3 });
    expect(profile?.firstPlayedAt).toBe(1);
    expect(profile?.lastPlayedAt).toBe(3);
    expect(profile?.byTheirFighter.map((f) => f.opponentFighterId).sort((a, b) => a - b)).toEqual([
      7, 41,
    ]);
    expect(profile?.recent[0]?.id).toBe('3'); // newest first
  });

  it('returns null for an opponent never played', () => {
    expect(getOpponentProfile([], 'ghost')).toBeNull();
  });
});

describe('getMatchupMatrix', () => {
  it('orders axes by usage and emits one cell per faced pairing', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: 75, opponent_id: 41 }),
      makeMatch({ id: '2', time: 2, win: false, fighter_id: 75, opponent_id: 41 }),
      makeMatch({ id: '3', time: 3, win: true, fighter_id: 75, opponent_id: 7 }),
      makeMatch({ id: '4', time: 4, win: true, fighter_id: 12, opponent_id: 41 }),
    ];
    const matrix = getMatchupMatrix(matches);
    expect(matrix.fighterIds).toEqual([75, 12]); // by usage
    expect(matrix.opponentFighterIds).toEqual([41, 7]);
    expect(matrix.cells).toHaveLength(3);
    const cell = matrix.cells.find((c) => c.fighterId === 75 && c.opponentFighterId === 41);
    expect(cell).toMatchObject({ wins: 1, losses: 1, total: 2 });
    expect(cell?.wilson).toBeGreaterThan(0);
  });
});
