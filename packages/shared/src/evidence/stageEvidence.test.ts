import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { buildStageEvidence, getBestWorstStages, rankStagesByEvidence } from './stageEvidence.js';

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

function matchesOnStage(id: number, name: string, wins: number, losses: number): Match[] {
  const result: Match[] = [];
  for (let i = 0; i < wins; i++) {
    result.push(makeMatch({ id: `${name}-w${i}`, time: i, win: true, map: { id, name } }));
  }
  for (let i = 0; i < losses; i++) {
    result.push(makeMatch({ id: `${name}-l${i}`, time: wins + i, win: false, map: { id, name } }));
  }
  return result;
}

describe('rankStagesByEvidence', () => {
  it('gates a 2-0 stage out under the default floor', () => {
    const twoZero = matchesOnStage(1, 'Two Zero', 2, 0);
    expect(rankStagesByEvidence(twoZero)).toEqual([]);
  });

  it('gates a 2-0 stage out even with an explicit sub-floor minMatches (D-07/R1-HIGH-1)', () => {
    const twoZero = matchesOnStage(1, 'Two Zero', 2, 0);
    expect(rankStagesByEvidence(twoZero, 1)).toEqual([]);
  });

  it('excludes the unknown-stage sentinel and ranks by wilson', () => {
    const matches = [
      ...matchesOnStage(0, 'no selection', 1, 0),
      ...matchesOnStage(1, 'Battlefield', 2, 1),
      ...matchesOnStage(3, 'Smashville', 5, 1),
    ];
    const ranked = rankStagesByEvidence(matches);
    expect(ranked.map((r) => r.stageId)).toEqual([3, 1]);
    expect(ranked.find((r) => r.stageId === 0)).toBeUndefined();
  });
});

describe('buildStageEvidence', () => {
  it('abstains on an empty sample without throwing', () => {
    const result = buildStageEvidence({ matches: [], refreshedAt: 0 });
    expect(result.claim.kind).toBe('abstained');
    if (result.claim.kind !== 'abstained') throw new Error('unreachable');
    expect(result.claim.sample.rawSampleSize).toBe(0);
    expect(result.claim.sample.dateRange).toBeNull();
    expect(result.claim.sample.knownFieldCoverage).toBe(0);
    expect(result.claim.gamesNeeded).toBe(3);
  });

  it('abstains when the only stage record is 2-0', () => {
    const twoZero = matchesOnStage(1, 'Two Zero', 2, 0);
    const result = buildStageEvidence({ matches: twoZero, refreshedAt: 0 });
    expect(result.claim.kind).toBe('abstained');
  });

  it('evidences once a second qualifying stage exists, excluding the below-floor one', () => {
    const matches = [...matchesOnStage(1, 'Two Zero', 2, 0), ...matchesOnStage(2, 'Six Two', 6, 2)];
    const result = buildStageEvidence({ matches, refreshedAt: 0 });
    expect(result.claim.kind).toBe('evidenced');
    if (result.claim.kind !== 'evidenced') throw new Error('unreachable');
    expect(result.claim.value.some((row) => row.total === 2)).toBe(false);
  });

  it('gates an explicit sub-floor minMatches at the public entry point (R1-HIGH-1)', () => {
    const twoZero = matchesOnStage(1, 'Two Zero', 2, 0);
    const result = buildStageEvidence({ matches: twoZero, refreshedAt: 0, minMatches: 1 });
    expect(result.claim.kind).toBe('abstained');
  });

  it('reports an unknown bucket for games with an absent map, or null when none', () => {
    const bare = makeMatch({ id: 'bare', time: 1, win: true });
    delete (bare as Partial<Match>).map;
    const withUnknown = buildStageEvidence({
      matches: [bare, ...matchesOnStage(1, 'Battlefield', 3, 0)],
      refreshedAt: 0,
    });
    expect(withUnknown.unknown).toEqual({ games: 1, wins: 1, losses: 0 });

    const allKnown = buildStageEvidence({
      matches: matchesOnStage(1, 'Battlefield', 3, 0),
      refreshedAt: 0,
    });
    expect(allKnown.unknown).toBeNull();
  });

  it('is identity-independent: rewriting match.opponent leaves the result deep-equal', () => {
    const matches = [...matchesOnStage(1, 'Two Zero', 2, 0), ...matchesOnStage(2, 'Six Two', 6, 2)];
    const rewritten = matches.map((m) => ({ ...m, opponent: `rewritten-${m.id}` }));
    expect(buildStageEvidence({ matches: rewritten, refreshedAt: 0 })).toEqual(
      buildStageEvidence({ matches, refreshedAt: 0 }),
    );
  });
});

describe('rankStagesByEvidence — legal-stage filter (plan 37-05, EVID-05)', () => {
  it('with the legal-stage argument omitted, behaves exactly as before (identity)', () => {
    const matches = [
      ...matchesOnStage(1, 'Battlefield', 5, 0),
      ...matchesOnStage(3, 'Smashville', 4, 1),
    ];
    expect(rankStagesByEvidence(matches, 3, undefined)).toEqual(rankStagesByEvidence(matches, 3));
  });

  it('excludes a stage outside an explicit legal set even when it has more games than the floor', () => {
    const matches = [
      ...matchesOnStage(1, 'Battlefield', 5, 0),
      ...matchesOnStage(3, 'Smashville', 10, 0),
    ];
    const ranked = rankStagesByEvidence(matches, 3, new Set([1]));
    expect(ranked.map((r) => r.stageId)).toEqual([1]);
  });

  it('an EMPTY legal set means nothing is legal, not "no filter" — returns empty even when several stages clear the floor', () => {
    const matches = [
      ...matchesOnStage(1, 'Battlefield', 5, 0),
      ...matchesOnStage(3, 'Smashville', 10, 0),
    ];
    expect(rankStagesByEvidence(matches, 3, new Set())).toEqual([]);
  });
});

describe('buildStageEvidence — legal-stage filter (plan 37-05, R1-HIGH-2)', () => {
  it('describes the LEGAL cohort when a filter is supplied: a known-but-illegal game sits in neither the denominator nor the unknown bucket', () => {
    const legalMatches = matchesOnStage(1, 'Battlefield', 4, 1); // 5 legal games
    const illegalMatches = matchesOnStage(2, 'Big Battlefield', 3, 0); // 3 known-but-illegal games
    const unknownMatches = matchesOnStage(0, 'no selection', 2, 0); // 2 unknown-stage games
    const allMatches = [...legalMatches, ...illegalMatches, ...unknownMatches];

    const filtered = buildStageEvidence({
      matches: allMatches,
      refreshedAt: 0,
      legalStageIds: new Set([1]),
    });
    expect(filtered.claim.sample.rawSampleSize).toBe(10);
    expect(filtered.claim.sample.eligibleDenominator).toBe(5);
    expect(filtered.unknown?.games).toBe(2);
    // 5 legal + 2 unknown = 7, strictly less than 10 by exactly the 3 illegal games.
    expect(filtered.claim.sample.eligibleDenominator + (filtered.unknown?.games ?? 0)).toBe(
      filtered.claim.sample.rawSampleSize - 3,
    );

    const unfiltered = buildStageEvidence({ matches: allMatches, refreshedAt: 0 });
    expect(unfiltered.claim.sample.eligibleDenominator + (unfiltered.unknown?.games ?? 0)).toBe(
      unfiltered.claim.sample.rawSampleSize,
    );
  });

  it('reports a games-needed of at least 1 when the eligible denominator already meets the floor but no single stage does', () => {
    const matches = [
      ...matchesOnStage(1, 'Battlefield', 1, 1), // 2 games, below the per-stage floor
      ...matchesOnStage(3, 'Smashville', 1, 1), // 2 games, below the per-stage floor
    ]; // denominator = 4, at/above the floor of 3, but no stage individually clears it
    const result = buildStageEvidence({ matches, refreshedAt: 0 });
    expect(result.claim.kind).toBe('abstained');
    if (result.claim.kind !== 'abstained') throw new Error('unreachable');
    expect(result.claim.sample.eligibleDenominator).toBeGreaterThanOrEqual(3);
    expect(result.claim.gamesNeeded).not.toBe(0);
    expect(result.claim.gamesNeeded).toBeGreaterThanOrEqual(1);
  });
});

describe('getBestWorstStages', () => {
  it('applies the same floor as rankStagesByEvidence even to an explicit sub-floor minMatches', () => {
    const twoZero = matchesOnStage(1, 'Two Zero', 2, 0);
    expect(getBestWorstStages(twoZero, 1)).toEqual({ best: null, worst: null });
  });
});
