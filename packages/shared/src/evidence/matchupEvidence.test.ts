import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { unknownCharacterOnlyWorkspace } from '../testUtils/index.js';
import { rankMatchupsByEvidence, getMatchupStageGuide } from './matchupEvidence.js';

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

describe('getMatchupStageGuide — unaffected by the WR-01 fix (documented, not changed)', () => {
  // WR-01's fix is scoped to `rankMatchupsByEvidence` (the function five
  // OTHER call sites use directly). `getMatchupStageGuide` was not named as
  // one of those five call sites in the review and groups by `opponent_id`
  // independently of `rankMatchupsByEvidence` — left as-is, exercised here
  // only to document that this file's change did not touch it.
  it('still returns a row keyed on a known opponent fighter id from a known-only fixture', () => {
    const rows = getMatchupStageGuide([knownMatch('k1', 0, true), knownMatch('k2', 1, false)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.opponentFighterId).toBe(8);
  });
});
