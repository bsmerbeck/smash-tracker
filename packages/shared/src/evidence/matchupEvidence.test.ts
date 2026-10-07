import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { unknownCharacterOnlyWorkspace } from '../testUtils/index.js';
import {
  rankMatchupsByEvidence,
  getMatchupStageGuide,
  listSubFloorMatchups,
} from './matchupEvidence.js';

/**
 * WR-01: `rankMatchupsByEvidence`'s unknown-character bucketing was applied
 * ONLY inside `buildMatchupEvidence` — this function itself had no
 * `isUnknownCharacter` guard, so its five OTHER direct callers
 * (`apps/web/src/lib/stats.ts`'s `getOpponentProfile`, `opponentEvidence.ts`'s
 * `buildOpponentProfile`, `matchupCoverage.ts`, `FullAnalysisSection.tsx`,
 * `MatchupSnapshot.tsx`) could rank/display a row whose `opponent_id` isn't a
 * known roster member as if it were a real matchup. This file proves the fix
 * lives in the shared ranking entry point itself, so every caller inherits
 * it — using the exact synthetic out-of-roster fixture
 * (`unknownCharacterOnlyWorkspace`, `fighter_id`/`opponent_id` both `0`)
 * `@smash-tracker/shared/testUtils` ships for this purpose (D-25: no live
 * ingestion path produces this today).
 */

function knownMatch(id: string, index: number, win: boolean): Match {
  return {
    id,
    fighter_id: 1,
    opponent_id: 8,
    time: 1_700_000_000_000 + index * 60_000,
    win,
    matchType: 'offline-tourney',
    map: { id: 1, name: 'Battlefield' },
  };
}

describe('rankMatchupsByEvidence — WR-01 unknown-character exclusion', () => {
  it('never ranks a purely unknown-character workspace, even with enough games to clear the floor', () => {
    const unknownOnly = unknownCharacterOnlyWorkspace();
    expect(unknownOnly.length).toBeGreaterThanOrEqual(3); // self-check: enough to clear the D-05 floor if ranked
    expect(rankMatchupsByEvidence(unknownOnly)).toEqual([]);
  });

  it('excludes unknown-character rows while still ranking known matchups correctly, mixed in the same call', () => {
    const knownMatches = [
      knownMatch('k1', 0, true),
      knownMatch('k2', 1, true),
      knownMatch('k3', 2, false),
    ];
    const unknownMatches = unknownCharacterOnlyWorkspace();
    const mixed = [...knownMatches, ...unknownMatches];

    const ranked = rankMatchupsByEvidence(mixed);

    // The known opponent (fighter id 8) is ranked...
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.opponentFighterId).toBe(8);
    expect(ranked[0]?.totalMatches).toBe(3);
    // ...and no row for the unknown sentinel id (0) ever appears, even
    // though `unknownCharacterOnlyWorkspace` alone has enough games (5) to
    // clear the abstention floor if it were mistakenly ranked as a real
    // matchup.
    expect(ranked.some((row) => row.opponentFighterId === 0)).toBe(false);
  });

  it('self-check: without the fix this test would fail — the raw byOpponent grouping would produce a rankable id-0 row', () => {
    // Not a test of the fix itself (covered above); a guard against a
    // silently-vacuous pass if `unknownCharacterOnlyWorkspace` ever stopped
    // producing enough games to clear the floor.
    const unknownMatches = unknownCharacterOnlyWorkspace();
    const wins = unknownMatches.filter((m) => m.win).length;
    expect(unknownMatches.length).toBeGreaterThanOrEqual(3);
    expect(wins).toBeGreaterThan(0);
  });
});

describe('getMatchupStageGuide — WR-01-i2 unknown-character exclusion', () => {
  // Iteration 1 of WR-01 fixed `rankMatchupsByEvidence` but explicitly left
  // this function's own, separately maintained `opponent_id` grouping loop
  // untouched (see the iteration-1 comment this block replaces) — the
  // identical gap `rankMatchupsByEvidence` had before that fix. Iteration 2
  // folds both functions onto the shared `groupKnownCharacterMatchesByOpponent`
  // helper so this drift cannot recur.
  it('still returns a row keyed on a known opponent fighter id from a known-only fixture', () => {
    const rows = getMatchupStageGuide([knownMatch('k1', 0, true), knownMatch('k2', 1, false)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.opponentFighterId).toBe(8);
  });

  it('never produces a row for a purely unknown-character workspace, even with enough games to clear the floor', () => {
    const unknownOnly = unknownCharacterOnlyWorkspace();
    expect(unknownOnly.length).toBeGreaterThanOrEqual(3); // self-check
    expect(getMatchupStageGuide(unknownOnly)).toEqual([]);
  });

  it('excludes unknown-character rows while still returning the known matchup, mixed in the same call', () => {
    const knownMatches = [
      knownMatch('k1', 0, true),
      knownMatch('k2', 1, true),
      knownMatch('k3', 2, false),
    ];
    const unknownMatches = unknownCharacterOnlyWorkspace();
    const mixed = [...knownMatches, ...unknownMatches];

    const rows = getMatchupStageGuide(mixed);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opponentFighterId).toBe(8);
    expect(rows.some((row) => row.opponentFighterId === 0)).toBe(false);
  });
});

describe('listSubFloorMatchups — the disclosure complement of rankMatchupsByEvidence (38-UAT 13/22)', () => {
  function vs(id: string, opponentFighterId: number, index: number, win: boolean): Match {
    return { ...knownMatch(id, index, win), opponent_id: opponentFighterId };
  }

  it('returns exactly the known-character groups rankMatchupsByEvidence drops, most games first then id ascending', () => {
    const matches = [
      vs('s1', 41, 0, true),
      vs('s2', 41, 1, true),
      vs('s3', 41, 2, false), // Sonic: 3 games -> ranked, not sub-floor
      vs('p1', 57, 3, false), // Palutena: 1 game
      vs('m1', 20, 4, true),
      vs('m2', 20, 5, false), // id 20: 2 games
      vs('z1', 10, 6, true), // id 10: 1 game
      ...unknownCharacterOnlyWorkspace(),
    ];

    const ranked = rankMatchupsByEvidence(matches);
    const subFloor = listSubFloorMatchups(matches);

    expect(ranked.map((row) => row.opponentFighterId)).toEqual([41]);
    expect(subFloor.map((row) => row.opponentFighterId)).toEqual([20, 10, 57]);
    expect(subFloor[0]).toEqual({
      opponentFighterId: 20,
      wins: 1,
      losses: 1,
      totalMatches: 2,
      ratio: 50,
    });
    expect(subFloor.some((row) => row.opponentFighterId === 0)).toBe(false);
    // complement: no id in both lists
    const rankedIds = new Set(ranked.map((row) => row.opponentFighterId));
    expect(subFloor.every((row) => !rankedIds.has(row.opponentFighterId))).toBe(true);
  });

  it('an explicit sub-floor minMatches cannot lower the floor (effectiveFloor)', () => {
    const matches = [vs('p1', 57, 0, true), vs('p2', 57, 1, false)];
    expect(rankMatchupsByEvidence(matches, 1)).toEqual([]);
    expect(listSubFloorMatchups(matches, 1).map((row) => row.opponentFighterId)).toEqual([57]);
  });
});
