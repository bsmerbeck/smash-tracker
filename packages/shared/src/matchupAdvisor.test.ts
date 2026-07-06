import { describe, expect, it } from 'vitest';
import {
  buildMatchupAdvisor,
  rankMatchup,
  selectMyCandidateFighterIds,
  type MyCharacterRecordVsOpponent,
} from './matchupAdvisor.js';
import { getFighterMeta } from './meta.js';

// Fighter ids used below (see fighterData.ts):
// 82 Steve (S+, zoner/trapper), 36 Snake (S+, zoner/trapper), 8 Fox (S, rushdown),
// 26 Ganondorf (D+, heavy), 52 Little Mac (D+, rushdown/grappler), 75 Piranha Plant (D, trapper/zoner)

describe('rankMatchup', () => {
  it('falls back to tier/archetype prior when there is no data', () => {
    // Steve (S+) vs. Ganondorf (D+) as candidates against some opponent —
    // with zero recorded games for either, the far-higher tier score should
    // win out.
    const ranking = rankMatchup(9 /* opponent: Pikachu */, [82, 26], []);
    expect(ranking.best?.fighterId).toBe(82);
    expect(ranking.worst?.fighterId).toBe(26);
    // No record evidence should be attached when the sample is empty.
    expect(ranking.best?.evidence.record).toBeUndefined();
  });

  it('lets a rich, favorable record overturn a worse tier placement', () => {
    // Little Mac (D+) has a dominant, well-sampled record against this
    // opponent; Steve (S+) has never been played against them. The user's
    // real results should win out over Steve's much higher tier score once
    // the sample is large.
    const records: MyCharacterRecordVsOpponent[] = [{ fighterId: 52, wins: 18, losses: 2 }];
    const ranking = rankMatchup(9, [82, 52], records);
    expect(ranking.best?.fighterId).toBe(52);
    expect(ranking.best?.evidence.record).toBe('18-2');
  });

  it('barely moves off the prior for a thin (1-2 game) sample', () => {
    // A single loss with Little Mac shouldn't be enough to conclude Little
    // Mac is bad against this opponent relative to Steve's much stronger
    // prior — thin samples should shrink toward the prior, not dominate it.
    const records: MyCharacterRecordVsOpponent[] = [{ fighterId: 52, wins: 0, losses: 1 }];
    const ranking = rankMatchup(9, [82, 52], records);
    expect(ranking.best?.fighterId).toBe(82);
  });

  it('shows monotonically increasing confidence in the record as sample size grows', () => {
    // With a consistent 100% win rate, more games sampled should pull the
    // blended score monotonically closer to 1 (fully trusting the record).
    const withFew = rankMatchup(9, [52], [{ fighterId: 52, wins: 2, losses: 0 }]).best!;
    const withMany = rankMatchup(9, [52], [{ fighterId: 52, wins: 20, losses: 0 }]).best!;
    expect(withMany.score).toBeGreaterThan(withFew.score);
  });

  it('degrades gracefully for an unmapped/unknown fighter id', () => {
    const unknownId = 999999;
    expect(() => getFighterMeta(unknownId)).not.toThrow();
    const ranking = rankMatchup(9, [unknownId, 82], []);
    expect(ranking.ranked).toHaveLength(2);
    // Steve's much higher tier score should still beat the mid-pack default
    // assigned to the unknown id.
    expect(ranking.best?.fighterId).toBe(82);
  });

  it('returns null best/worst for an empty candidate list', () => {
    const ranking = rankMatchup(9, [], []);
    expect(ranking.best).toBeNull();
    expect(ranking.worst).toBeNull();
    expect(ranking.ranked).toEqual([]);
  });

  it('returns null worst (not a duplicate of best) for a single candidate', () => {
    const ranking = rankMatchup(9, [82], []);
    expect(ranking.best?.fighterId).toBe(82);
    expect(ranking.worst).toBeNull();
  });

  it('orders every candidate by descending score', () => {
    const ranking = rankMatchup(9, [82, 8, 26, 52], []);
    const scores = ranking.ranked.map((r) => r.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]!);
    }
  });
});

describe('buildMatchupAdvisor', () => {
  it('ranks each opponent fighter id independently', () => {
    const recordsByOpponent = new Map<number, MyCharacterRecordVsOpponent[]>([
      [9, [{ fighterId: 52, wins: 15, losses: 1 }]],
      [36, [{ fighterId: 82, wins: 1, losses: 15 }]],
    ]);
    const rankings = buildMatchupAdvisor([9, 36], [82, 52], recordsByOpponent);
    expect(rankings).toHaveLength(2);
    expect(rankings[0]?.opponentFighterId).toBe(9);
    expect(rankings[0]?.best?.fighterId).toBe(52);
    expect(rankings[1]?.opponentFighterId).toBe(36);
    // Steve's own bad record vs. this opponent should pull it down even
    // though it's a strong tier pick in general.
    expect(rankings[1]?.ranked.find((r) => r.fighterId === 82)?.evidence.record).toBe('1-15');
  });

  it('returns an empty array for an empty opponent list', () => {
    expect(buildMatchupAdvisor([], [82], new Map())).toEqual([]);
  });
});

describe('selectMyCandidateFighterIds', () => {
  it('unions primary/secondary selections with the top-played characters', () => {
    const played = [8, 8, 8, 26, 26, 52]; // Fox x3, Ganondorf x2, Little Mac x1
    const result = selectMyCandidateFighterIds(played, [82], [36]);
    expect(new Set(result)).toEqual(new Set([82, 36, 8, 26, 52]));
  });

  it('de-duplicates when a primary/secondary fighter is also top-played', () => {
    const played = [82, 82, 82];
    const result = selectMyCandidateFighterIds(played, [82], []);
    expect(result).toEqual([82]);
  });

  it('caps the top-played contribution at topCount, independent of primary/secondary', () => {
    const played = [1, 1, 1, 2, 2, 3, 4, 5, 6];
    const result = selectMyCandidateFighterIds(played, [], [], 2);
    // Only the top 2 by games played (1 and 2) should be included.
    expect(new Set(result)).toEqual(new Set([1, 2]));
  });

  it('returns an empty list when there is no data at all', () => {
    expect(selectMyCandidateFighterIds([], [], [])).toEqual([]);
  });
});
