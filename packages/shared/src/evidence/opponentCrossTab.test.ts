import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Match } from '../match.js';
import { generateSyntheticMatches, EIGHT_K_FIXTURE_OPTIONS } from '../testUtils/index.js';
import { buildOpponentCrossTab } from './opponentCrossTab.js';
import { buildOpponentProfile } from './opponentEvidence.js';
import { COUNTABLE_GAME_UPSTREAM_RULES, UNKNOWN_STAGE_ID } from './predicate.js';
import * as predicateModule from './predicate.js';
import { ABSTENTION_FLOOR_GAMES } from './policy.js';

vi.mock('./predicate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./predicate.js')>();
  return {
    ...actual,
    isCountableGame: vi.fn(actual.isCountableGame),
  };
});

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win' | 'fighter_id' | 'opponent_id'>,
): Match {
  return {
    opponent: '',
    ...overrides,
  };
}

describe('buildOpponentCrossTab', () => {
  it('merges two raw tags resolving to one identity into a single cross-tab whose total equals the merged game count', () => {
    const matches: Match[] = [
      makeMatch({
        id: 'm1',
        time: 1,
        win: true,
        fighter_id: 1,
        opponent_id: 2,
        opponent: 'tagone',
        map: { id: 10, name: 'Stage A' },
      }),
      makeMatch({
        id: 'm2',
        time: 2,
        win: false,
        fighter_id: 1,
        opponent_id: 2,
        opponent: 'tagtwo',
        map: { id: 10, name: 'Stage A' },
      }),
    ];
    const result = buildOpponentCrossTab({
      matches,
      aliasMap: { tagtwo: 'tagone' },
      opponentTag: 'tagone',
      refreshedAt: 1000,
    });
    const totalGames = result.cells.reduce((sum, cell) => sum + cell.total, 0);
    expect(totalGames).toBe(2);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.wins).toBe(1);
    expect(result.cells[0]!.losses).toBe(1);
  });

  it('a cell at exactly ABSTENTION_FLOOR_GAMES has a non-null tier; one fewer has a null tier and a fact claim kind', () => {
    const atFloor: Match[] = Array.from({ length: ABSTENTION_FLOOR_GAMES }, (_, i) =>
      makeMatch({
        id: `at-floor-${i}`,
        time: i,
        win: true,
        fighter_id: 1,
        opponent_id: 2,
        opponent: 'tagone',
        map: { id: 10, name: 'Stage A' },
      }),
    );
    const belowFloor: Match[] = Array.from({ length: ABSTENTION_FLOOR_GAMES - 1 }, (_, i) =>
      makeMatch({
        id: `below-floor-${i}`,
        time: i,
        win: true,
        fighter_id: 1,
        opponent_id: 3,
        opponent: 'tagone',
        map: { id: 10, name: 'Stage A' },
      }),
    );
    const result = buildOpponentCrossTab({
      matches: [...atFloor, ...belowFloor],
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1000,
    });
    const atFloorCell = result.cells.find((c) => c.rowKey === '1:2');
    const belowFloorCell = result.cells.find((c) => c.rowKey === '1:3');
    expect(atFloorCell!.confidenceTier).not.toBeNull();
    expect(belowFloorCell!.confidenceTier).toBeNull();
    expect(belowFloorCell!.kind).toBe('fact');
  });

  it('routes every cell through isCountableGame: mocking it to reject one row removes that row from its cell', () => {
    const mocked = vi.mocked(predicateModule.isCountableGame);
    mocked.mockImplementation((m) => m.id !== 'reject-me');
    try {
      const matches: Match[] = [
        makeMatch({
          id: 'keep-1',
          time: 1,
          win: true,
          fighter_id: 1,
          opponent_id: 2,
          opponent: 'tagone',
          map: { id: 10, name: 'Stage A' },
        }),
        makeMatch({
          id: 'reject-me',
          time: 2,
          win: false,
          fighter_id: 1,
          opponent_id: 2,
          opponent: 'tagone',
          map: { id: 10, name: 'Stage A' },
        }),
      ];
      const result = buildOpponentCrossTab({
        matches,
        aliasMap: {},
        opponentTag: 'tagone',
        refreshedAt: 1000,
      });
      const cell = result.cells.find((c) => c.rowKey === '1:2' && c.colKey === '10');
      expect(cell).toBeDefined();
      expect(cell!.total).toBe(1);
      expect(cell!.wins).toBe(1);
      expect(cell!.losses).toBe(0);
    } finally {
      mocked.mockRestore();
    }
  });

  it('COUNTABLE_GAME_UPSTREAM_RULES still carries five entries whose paths exist on disk (the upstream half of the routing claim)', () => {
    expect(COUNTABLE_GAME_UPSTREAM_RULES).toHaveLength(5);
    for (const rule of COUNTABLE_GAME_UPSTREAM_RULES) {
      const [filePath] = rule.where.split(':');
      // this file lives at packages/shared/src/evidence/; repo root is four levels up.
      const repoRelative = new URL(`../../../../${filePath}`, import.meta.url);
      expect(existsSync(repoRelative), `rule ${rule.id} path ${filePath}`).toBe(true);
    }
  });

  it('the unknown-stage column is last even when its total exceeds a known stage total', () => {
    const knownStage: Match[] = Array.from({ length: 2 }, (_, i) =>
      makeMatch({
        id: `known-${i}`,
        time: i,
        win: true,
        fighter_id: 1,
        opponent_id: 2,
        opponent: 'tagone',
        map: { id: 10, name: 'Stage A' },
      }),
    );
    const unknownStageMatches: Match[] = Array.from({ length: 5 }, (_, i) =>
      makeMatch({
        id: `unknown-${i}`,
        time: 100 + i,
        win: true,
        fighter_id: 1,
        opponent_id: 2,
        opponent: 'tagone',
      }),
    );
    const result = buildOpponentCrossTab({
      matches: [...knownStage, ...unknownStageMatches],
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1000,
    });
    expect(result.cols.length).toBeGreaterThan(1);
    const last = result.cols[result.cols.length - 1]!;
    expect(last.stageId).toBe(UNKNOWN_STAGE_ID);
    expect(last.total).toBeGreaterThan(result.cols[0]!.total);
  });

  it('is deterministic across repeat calls, and orders equal-total rows by ascending myFighterId', () => {
    const matches: Match[] = [
      makeMatch({
        id: 'a1',
        time: 1,
        win: true,
        fighter_id: 5,
        opponent_id: 2,
        opponent: 'tagone',
        map: { id: 10, name: 'Stage A' },
      }),
      makeMatch({
        id: 'b1',
        time: 2,
        win: true,
        fighter_id: 3,
        opponent_id: 2,
        opponent: 'tagone',
        map: { id: 10, name: 'Stage A' },
      }),
    ];
    const first = buildOpponentCrossTab({
      matches,
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1000,
    });
    const second = buildOpponentCrossTab({
      matches,
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1000,
    });
    expect(first.rows.map((r) => r.rowKey)).toEqual(second.rows.map((r) => r.rowKey));
    expect(first.cols.map((c) => c.colKey)).toEqual(second.cols.map((c) => c.colKey));
    // Both rows have total 1 (equal) — ascending myFighterId breaks the tie.
    expect(first.rows.map((r) => r.myFighterId)).toEqual([3, 5]);
  });

  it('an empty matches array returns a well-formed zero result with no NaN denominator', () => {
    const result = buildOpponentCrossTab({
      matches: [],
      aliasMap: {},
      opponentTag: 'nobody',
      refreshedAt: 1000,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.cols).toHaveLength(0);
    expect(result.sample.rawSampleSize).toBe(0);
    expect(Number.isFinite(result.sample.knownFieldCoverage)).toBe(true);
    expect(Number.isNaN(result.sample.knownFieldCoverage)).toBe(false);
  });

  it('seeded fixture: the alias-split identity resolves to one cross-tab whose total matches buildOpponentProfile for the same identity', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const aliasMap = { nightowl: 'shadowfox' };
    const profile = buildOpponentProfile({
      matches,
      aliasMap,
      opponentTag: 'shadowfox',
      refreshedAt: 1000,
    });
    expect(profile).not.toBeNull();
    const crossTab = buildOpponentCrossTab({
      matches,
      aliasMap,
      opponentTag: 'shadowfox',
      refreshedAt: 1000,
    });
    const totalGames =
      crossTab.cells.reduce((sum, cell) => sum + cell.total, 0) +
      (crossTab.unknownCharacter?.games ?? 0);
    expect(totalGames).toBe(profile!.record.total);
  });
});
