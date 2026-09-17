import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  CONTINUE_SET_MAX_GAP_MS,
  continueSetSharedDefaults,
  defaultContinueFormat,
  findPriorSetGames,
  isFormatSelectable,
  isManualMatch,
  matchToSetGameValues,
} from './continueSetLogic';

/** Base epoch — every match `time` in this file is a relative offset from it. */
const BASE_TIME = 1_700_000_000_000;
const MINUTE = 60_000;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 8,
    time: BASE_TIME,
    map: { id: 2, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  } as Match;
}

describe('isManualMatch', () => {
  it('a match with no source and no externalId is manual', () => {
    expect(isManualMatch(makeMatch())).toBe(true);
  });

  it('source: startgg is NOT manual, even with no externalId', () => {
    expect(isManualMatch(makeMatch({ source: 'startgg' }))).toBe(false);
  });

  it('a parseable externalId is NOT manual', () => {
    expect(isManualMatch(makeMatch({ externalId: 'sgg:12345:g1' }))).toBe(false);
    expect(isManualMatch(makeMatch({ externalId: 'pgg-abc-g2' }))).toBe(false);
  });

  it('an unparseable externalId with no source IS manual', () => {
    expect(isManualMatch(makeMatch({ externalId: 'junk' }))).toBe(true);
  });
});

describe('findPriorSetGames', () => {
  it('returns all three manual matches vs the same opponent/event/tournament/matchType, ascending by time, anchor included', () => {
    const m1 = makeMatch({ id: 'g1', time: BASE_TIME });
    const m2 = makeMatch({ id: 'g2', time: BASE_TIME + 8 * MINUTE, win: false });
    const m3 = makeMatch({ id: 'g3', time: BASE_TIME + 8 * MINUTE + 12 * MINUTE });
    const result = findPriorSetGames(m2, [m3, m1, m2]);
    expect(result.map((m) => m.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('excludes a fourth match saved 3 hours later (gap > CONTINUE_SET_MAX_GAP_MS) while keeping the contiguous run intact', () => {
    const m1 = makeMatch({ id: 'g1', time: BASE_TIME });
    const m2 = makeMatch({ id: 'g2', time: BASE_TIME + 8 * MINUTE, win: false });
    const m3 = makeMatch({ id: 'g3', time: BASE_TIME + 20 * MINUTE });
    const m4 = makeMatch({ id: 'g4', time: m3.time + 3 * 60 * MINUTE });
    expect(CONTINUE_SET_MAX_GAP_MS).toBeLessThan(3 * 60 * MINUTE);
    const result = findPriorSetGames(m2, [m1, m2, m3, m4]);
    expect(result.map((m) => m.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('excludes a match differing in opponent, eventName, tournamentName, or matchType', () => {
    const anchor = makeMatch({
      id: 'anchor',
      opponent: 'rival',
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      matchType: 'offline-tourney',
    });
    const sameFields = {
      opponent: 'rival',
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      matchType: 'offline-tourney' as const,
      time: BASE_TIME + 5 * MINUTE,
    };
    const differsOpponent = makeMatch({ id: 'x1', ...sameFields, opponent: 'someone-else' });
    const differsEvent = makeMatch({ id: 'x2', ...sameFields, eventName: 'Other Event' });
    const differsTournament = makeMatch({
      id: 'x3',
      ...sameFields,
      tournamentName: 'Other Tourney',
    });
    const differsMatchType = makeMatch({ id: 'x4', ...sameFields, matchType: 'quickplay' });

    for (const other of [differsOpponent, differsEvent, differsTournament, differsMatchType]) {
      const result = findPriorSetGames(anchor, [anchor, other]);
      expect(
        result.map((m) => m.id),
        other.id,
      ).toEqual(['anchor']);
    }
  });

  it('treats absent eventName/tournamentName as "" and absent/"" matchType as "none" when comparing', () => {
    const anchor = makeMatch({
      id: 'anchor',
      opponent: 'rival',
      eventName: undefined,
      tournamentName: undefined,
      matchType: '',
    });
    const sibling = makeMatch({
      id: 'sib',
      opponent: 'rival',
      eventName: undefined,
      tournamentName: undefined,
      matchType: 'none',
      time: BASE_TIME + 5 * MINUTE,
    });
    const result = findPriorSetGames(anchor, [anchor, sibling]);
    expect(result.map((m) => m.id)).toEqual(['anchor', 'sib']);
  });

  it('never includes synced matches (source or parseable externalId) even when every other field matches', () => {
    const anchor = makeMatch({ id: 'anchor' });
    const syncedBySource = makeMatch({
      id: 'sync-source',
      source: 'startgg',
      time: BASE_TIME + 5 * MINUTE,
    });
    const syncedByExternalId = makeMatch({
      id: 'sync-ext',
      externalId: 'sgg:999:g2',
      time: BASE_TIME + 10 * MINUTE,
    });
    const result = findPriorSetGames(anchor, [anchor, syncedBySource, syncedByExternalId]);
    expect(result.map((m) => m.id)).toEqual(['anchor']);
  });

  it('caps a contiguous run of 7 candidates to 5 — the closest to the anchor in time, anchor always included, ascending', () => {
    const games = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      makeMatch({ id: `g${i}`, time: BASE_TIME + i * 5 * MINUTE }),
    );
    const anchor = games[3]!; // g3, the middle game
    const result = findPriorSetGames(anchor, games);
    expect(result).toHaveLength(5);
    expect(result.map((m) => m.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
    expect(result.some((m) => m.id === 'anchor' || m === anchor)).toBe(true);
    // Ascending by time.
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]!.time).toBeGreaterThanOrEqual(result[i - 1]!.time);
    }
  });

  it('returns [] for an anchor that is not manual (defensive)', () => {
    const anchor = makeMatch({ source: 'startgg' });
    expect(findPriorSetGames(anchor, [anchor])).toEqual([]);
  });

  it('returns exactly [anchor] when the anchor has no same-set siblings', () => {
    const anchor = makeMatch({ id: 'lonely' });
    expect(findPriorSetGames(anchor, [])).toEqual([anchor]);
  });

  it('includes an anchor absent from `matches` (stale cache) exactly once, not duplicated', () => {
    const anchor = makeMatch({ id: 'anchor', time: BASE_TIME });
    const sibling = makeMatch({ id: 'sib', time: BASE_TIME + 5 * MINUTE });
    const result = findPriorSetGames(anchor, [sibling]);
    expect(result.map((m) => m.id)).toEqual(['anchor', 'sib']);
    expect(result.filter((m) => m.id === 'anchor')).toHaveLength(1);
  });
});

describe('matchToSetGameValues', () => {
  it('maps result/stageId/stageForm/stocksLeft and sets fighterId/opponentFighterId explicitly', () => {
    const match = makeMatch({
      win: true,
      map: { id: 5, name: 'Pokémon Stadium 2', form: 'battlefield' },
      stocksLeft: 2,
      fighter_id: 3,
      opponent_id: 9,
    });
    const values = matchToSetGameValues(match);
    expect(values.result).toBe('win');
    expect(values.stageId).toBe(5);
    expect(values.stageForm).toBe('battlefield');
    expect(values.stocksLeft).toBe(2);
    expect(values.fighterId).toBe(3);
    expect(values.opponentFighterId).toBe(9);

    const lossMatch = makeMatch({ win: false });
    expect(matchToSetGameValues(lossMatch).result).toBe('loss');
  });

  it('a match with no map yields stageId: 0 and no stageForm', () => {
    const match = makeMatch({ map: undefined });
    const values = matchToSetGameValues(match);
    expect(values.stageId).toBe(0);
    expect(values.stageForm).toBeUndefined();
  });
});

describe('continueSetSharedDefaults / defaultContinueFormat / isFormatSelectable', () => {
  it('prefills fighter, opponent fighter, opponent name, matchType, eventName, tournamentName from the anchor', () => {
    const anchor = makeMatch({
      fighter_id: 4,
      opponent_id: 11,
      opponent: 'rival',
      matchType: 'offline-tourney',
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
    });
    const defaults = continueSetSharedDefaults(anchor, 2);
    expect(defaults.fighterId).toBe(4);
    expect(defaults.opponentFighterId).toBe(11);
    expect(defaults.opponentName).toBe('rival');
    expect(defaults.matchType).toBe('offline-tourney');
    expect(defaults.eventName).toBe('Ultimate Singles');
    expect(defaults.tournamentName).toBe('The Big House 9');
  });

  it('a blank/absent matchType prefills "none"; a blank/absent opponent prefills "unknown"', () => {
    const blank = continueSetSharedDefaults(makeMatch({ matchType: '', opponent: '' }), 1);
    expect(blank.matchType).toBe('none');
    expect(blank.opponentName).toBe('unknown');

    const absent = continueSetSharedDefaults(
      makeMatch({ matchType: undefined, opponent: undefined }),
      1,
    );
    expect(absent.matchType).toBe('none');
    expect(absent.opponentName).toBe('unknown');
  });

  it('defaultContinueFormat(2) is bo3, defaultContinueFormat(4) is bo5', () => {
    expect(defaultContinueFormat(2)).toBe('bo3');
    expect(defaultContinueFormat(4)).toBe('bo5');
  });

  it('isFormatSelectable reflects whether the format can hold the locked games', () => {
    expect(isFormatSelectable('bo3', 4)).toBe(false);
    expect(isFormatSelectable('bo3', 3)).toBe(true);
    expect(isFormatSelectable('bo5', 5)).toBe(true);
    expect(isFormatSelectable('bo5', 0)).toBe(true);
  });
});
