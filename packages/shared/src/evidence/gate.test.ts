import { describe, expect, it } from 'vitest';
import { ABSTENTION_FLOOR_GAMES, confidenceTierFor, effectiveFloor } from './policy.js';
import { gateBySampleSize } from './gate.js';
import { buildStageEvidence, rankStagesByEvidence } from './stageEvidence.js';
import type { Match } from '../match.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function twoZeroFixture(): Match[] {
  return [makeMatch({ id: '1', time: 1, win: true }), makeMatch({ id: '2', time: 2, win: true })];
}

describe('gateBySampleSize (D-07)', () => {
  it('places a { total: 2, wins: 2 } candidate in abstained, never evidenced, under the floor', () => {
    // Deliberately routes through the exported ABSTENTION_FLOOR_GAMES
    // constant (not a bare literal `3`) so this assertion has a genuine
    // failing case when the floor is weakened — verified by temporarily
    // setting ABSTENTION_FLOOR_GAMES to 2 and observing this test fail
    // (recorded in the plan's SUMMARY.md), then restoring it.
    const candidates = [
      { total: 2, wins: 2 },
      { total: 6, wins: 4 },
    ];
    const { evidenced, abstained } = gateBySampleSize(
      candidates,
      (c) => c.total,
      ABSTENTION_FLOOR_GAMES,
    );
    expect(abstained).toEqual([{ total: 2, wins: 2 }]);
    expect(evidenced).toEqual([{ total: 6, wins: 4 }]);
    expect(evidenced.find((c) => c.total === 2)).toBeUndefined();
  });
});

describe('confidenceTierFor boundaries (EVID-03)', () => {
  it('maps the exact boundary set', () => {
    expect(confidenceTierFor(2)).toBeNull();
    expect(confidenceTierFor(3)).toBe('low');
    expect(confidenceTierFor(7)).toBe('low');
    expect(confidenceTierFor(8)).toBe('medium');
    expect(confidenceTierFor(19)).toBe('medium');
    expect(confidenceTierFor(20)).toBe('high');
  });
});

describe('effectiveFloor (R1-HIGH-1)', () => {
  it('raises 1, 2, 3 and undefined to the floor, and passes through a higher explicit value', () => {
    expect(effectiveFloor(1)).toBe(3);
    expect(effectiveFloor(2)).toBe(3);
    expect(effectiveFloor(3)).toBe(3);
    expect(effectiveFloor(undefined)).toBe(3);
    expect(effectiveFloor(5)).toBe(5);
    expect(effectiveFloor(10)).toBe(10);
  });
});

describe('D-07 public-entry-point floor (R1-HIGH-1)', () => {
  it('rankStagesByEvidence gates a 2-0 stage out under an explicit sub-floor minMatches of 1', () => {
    expect(rankStagesByEvidence(twoZeroFixture(), 1)).toEqual([]);
  });

  it('buildStageEvidence abstains under an explicit sub-floor minMatches of 1', () => {
    const result = buildStageEvidence({ matches: twoZeroFixture(), minMatches: 1, refreshedAt: 0 });
    expect(result.claim.kind).toBe('abstained');
  });
});

/**
 * D-07 regression net (the owner's Town-and-City / Final-Destination
 * finding): each assertion below is proven to have a genuine failing case
 * by temporarily weakening the floor/enforcement and observing the
 * assertion fail, then restoring it. The failing runs are recorded in the
 * plan's SUMMARY.md rather than committed as a permanently-broken test,
 * per the plan's fail-fast discipline — this file always asserts the
 * CORRECT (floor-enforcing) behavior.
 */
describe('regression-net self-check', () => {
  it('ABSTENTION_FLOOR_GAMES is 3 (the floor this whole suite assumes)', () => {
    expect(ABSTENTION_FLOOR_GAMES).toBe(3);
  });
});
