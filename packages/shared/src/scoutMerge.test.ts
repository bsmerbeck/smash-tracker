import { describe, expect, it } from 'vitest';
import { mergeScoutReports } from './scoutMerge.js';
import { isCombinedIdentity, type ScoutReportData } from './startgg.js';

const startggReport: ScoutReportData = {
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239', source: 'startgg' },
  sampledSets: 10,
  sampledGames: 24,
  characters: [
    { fighterId: 67, games: 18, wins: 12 },
    { fighterId: 41, games: 6, wins: 2 },
  ],
  stages: [
    { stageId: 1, games: 14, wins: 9 },
    { stageId: 2, games: 10, wins: 5 },
  ],
  recentEvents: [
    { eventName: 'Big House', lastSetAt: 3000, source: 'startgg', slug: 't/bh/e/singles' },
    { eventName: 'Genesis', lastSetAt: 1000 },
  ],
  commonOpponents: [
    { gamerTag: 'PowPow', sets: 4 },
    { gamerTag: 'Zackray', sets: 2 },
  ],
  games: [
    {
      time: 3000,
      win: true,
      fighterId: 67,
      opponentFighterId: 41,
      opponentTag: 'PowPow',
    },
  ],
};

const parryReport: ScoutReportData = {
  player: {
    gamerTag: 'pandem1c',
    source: 'parrygg',
    parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
  },
  sampledSets: 5,
  sampledGames: 11,
  characters: [
    { fighterId: 67, games: 8, wins: 6 }, // same fighter as start.gg → sums
    { fighterId: 30, games: 3, wins: 1 },
  ],
  stages: [
    { stageId: 1, games: 7, wins: 5 }, // same stage → sums
    { stageId: 3, games: 4, wins: 2 },
  ],
  recentEvents: [
    { eventName: 'Local Weekly', lastSetAt: 2000, source: 'parrygg', slug: 'my-tourney/singles' },
  ],
  commonOpponents: [
    { gamerTag: 'powpow', sets: 3 }, // same person, different casing → merges
    { gamerTag: 'Sparg0', sets: 1 },
  ],
  games: [
    {
      time: 2000,
      win: false,
      fighterId: 67,
      opponentFighterId: 30,
      opponentTag: 'Sparg0',
    },
  ],
};

describe('mergeScoutReports', () => {
  it('sums sampled counts across both sources', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    expect(merged.sampledSets).toBe(15);
    expect(merged.sampledGames).toBe(35);
  });

  it('sums per-character usage by fighterId, most games first', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    // fighterId 67: 18+8 games, 12+6 wins.
    expect(merged.characters[0]).toEqual({ fighterId: 67, games: 26, wins: 18 });
    // Remaining characters unique to each source appear once.
    expect(merged.characters).toContainEqual({ fighterId: 41, games: 6, wins: 2 });
    expect(merged.characters).toContainEqual({ fighterId: 30, games: 3, wins: 1 });
    // Sorted by games desc.
    const games = merged.characters.map((c) => c.games);
    expect(games).toEqual([...games].sort((a, b) => b - a));
  });

  it('sums per-stage usage by stageId', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    expect(merged.stages).toContainEqual({ stageId: 1, games: 21, wins: 14 });
    expect(merged.stages).toContainEqual({ stageId: 2, games: 10, wins: 5 });
    expect(merged.stages).toContainEqual({ stageId: 3, games: 4, wins: 2 });
  });

  it('merges common opponents case-insensitively, keeping first-seen display', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    // PowPow (4) + powpow (3) → one row of 7, display from the first side seen.
    const powpow = merged.commonOpponents.find((o) => o.gamerTag.toLowerCase() === 'powpow');
    expect(powpow).toEqual({ gamerTag: 'PowPow', sets: 7 });
    expect(merged.commonOpponents[0]).toEqual({ gamerTag: 'PowPow', sets: 7 });
  });

  it('concatenates recent events newest-first', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    expect(merged.recentEvents.map((e) => e.lastSetAt)).toEqual([3000, 2000, 1000]);
    // Provenance survives — each event keeps its own source (the oldest event
    // had none, mirroring a pre-V9-B start.gg event).
    expect(merged.recentEvents.map((e) => e.source)).toEqual(['startgg', 'parrygg', undefined]);
  });

  it('concatenates per-game records from both sources', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    expect(merged.games).toHaveLength(2);
    expect(merged.games?.map((g) => g.opponentTag)).toEqual(['PowPow', 'Sparg0']);
  });

  it('builds a combined identity carrying both ids, start.gg display tag + slug', () => {
    const merged = mergeScoutReports(startggReport, parryReport);
    expect(isCombinedIdentity(merged.player)).toBe(true);
    expect(merged.player).toEqual({
      source: 'combined',
      id: 1802316,
      parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      userSlug: 'user/07dc2239',
      gamerTag: 'Pandem1c', // start.gg casing preferred over parry.gg's "pandem1c"
    });
  });

  it('is order-independent (parry-first yields the same combined identity)', () => {
    const a = mergeScoutReports(startggReport, parryReport);
    const b = mergeScoutReports(parryReport, startggReport);
    expect(b.player).toEqual(a.player);
    expect(b.sampledGames).toBe(a.sampledGames);
  });

  it('omits games entirely when neither source carried any', () => {
    const merged = mergeScoutReports(
      { ...startggReport, games: undefined },
      { ...parryReport, games: undefined },
    );
    expect(merged.games).toBeUndefined();
  });

  it('does not mutate the input reports', () => {
    const startggClone = JSON.parse(JSON.stringify(startggReport));
    const parryClone = JSON.parse(JSON.stringify(parryReport));
    mergeScoutReports(startggReport, parryReport);
    expect(startggReport).toEqual(startggClone);
    expect(parryReport).toEqual(parryClone);
  });
});
