import { describe, expect, it } from 'vitest';
import {
  buildDefaultGameValues,
  buildSetGamePayloads,
  formatSetScore,
  getSetScore,
  isSetDecided,
  maxGamesFor,
  shouldShowGame,
  winsNeededFor,
  type SetGameValues,
  type SetSharedValues,
} from './setWizardLogic';

function game(result: 'win' | 'loss', overrides: Partial<SetGameValues> = {}): SetGameValues {
  return { result, stageId: 1, ...overrides };
}

describe('winsNeededFor / maxGamesFor', () => {
  it('bo3 needs 2 wins and caps at 3 games', () => {
    expect(winsNeededFor('bo3')).toBe(2);
    expect(maxGamesFor('bo3')).toBe(3);
  });

  it('bo5 needs 3 wins and caps at 5 games', () => {
    expect(winsNeededFor('bo5')).toBe(3);
    expect(maxGamesFor('bo5')).toBe(5);
  });
});

describe('getSetScore', () => {
  it('tallies wins and losses', () => {
    expect(getSetScore([game('win'), game('loss'), game('win')])).toEqual({ wins: 2, losses: 1 });
  });

  it('returns 0-0 for no games', () => {
    expect(getSetScore([])).toEqual({ wins: 0, losses: 0 });
  });
});

describe('isSetDecided', () => {
  it('bo3 is decided at 2 wins', () => {
    expect(isSetDecided('bo3', { wins: 2, losses: 0 })).toBe(true);
    expect(isSetDecided('bo3', { wins: 1, losses: 1 })).toBe(false);
  });

  it('bo3 is decided at 2 losses', () => {
    expect(isSetDecided('bo3', { wins: 0, losses: 2 })).toBe(true);
  });

  it('bo5 is decided at 3 wins or 3 losses, not before', () => {
    expect(isSetDecided('bo5', { wins: 2, losses: 2 })).toBe(false);
    expect(isSetDecided('bo5', { wins: 3, losses: 1 })).toBe(true);
    expect(isSetDecided('bo5', { wins: 1, losses: 3 })).toBe(true);
  });
});

describe('shouldShowGame', () => {
  it('always shows game 1 regardless of prior games', () => {
    expect(shouldShowGame('bo3', 1, [])).toBe(true);
  });

  it('shows game 2 once game 1 has a result and the set is undecided', () => {
    expect(shouldShowGame('bo3', 2, [game('win')])).toBe(true);
  });

  it('does not show game 2 if game 1 has no result yet', () => {
    expect(shouldShowGame('bo3', 2, [{ result: undefined as unknown as 'win', stageId: 0 }])).toBe(
      false,
    );
  });

  it('does not show game 3 in bo3 once the set is decided 2-0', () => {
    expect(shouldShowGame('bo3', 3, [game('win'), game('win')])).toBe(false);
  });

  it('shows game 3 in bo3 when the set is 1-1', () => {
    expect(shouldShowGame('bo3', 3, [game('win'), game('loss')])).toBe(true);
  });

  it('never shows a game beyond the format cap', () => {
    expect(shouldShowGame('bo3', 4, [game('win'), game('loss')])).toBe(false);
  });

  it('bo5 shows game 4 at 2-1 but not once decided 3-0', () => {
    expect(shouldShowGame('bo5', 4, [game('win'), game('loss'), game('win')])).toBe(true);
    expect(shouldShowGame('bo5', 4, [game('win'), game('win'), game('win')])).toBe(false);
  });

  it('bo5 shows game 5 only at 2-2', () => {
    expect(shouldShowGame('bo5', 5, [game('win'), game('loss'), game('win'), game('loss')])).toBe(
      true,
    );
    expect(shouldShowGame('bo5', 5, [game('win'), game('win'), game('loss'), game('loss')])).toBe(
      true,
    );
  });
});

describe('formatSetScore', () => {
  it('formats as wins-losses', () => {
    expect(formatSetScore({ wins: 2, losses: 1 })).toBe('2-1');
    expect(formatSetScore({ wins: 0, losses: 0 })).toBe('0-0');
  });
});

describe('buildSetGamePayloads', () => {
  const shared: SetSharedValues = {
    fighterId: 1,
    opponentFighterId: 8,
    opponentName: 'rival',
    matchType: 'offline-tourney',
  };

  it('builds one payload per game with shared fields merged in', () => {
    const games: SetGameValues[] = [game('win', { stageId: 1 }), game('loss', { stageId: 3 })];
    const payloads = buildSetGamePayloads(shared, games);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual({
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'rival',
      notes: '',
      matchType: 'offline-tourney',
      win: true,
    });
    expect(payloads[1]).toEqual({
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 3, name: 'Final Destination' },
      opponent: 'rival',
      notes: '',
      matchType: 'offline-tourney',
      win: false,
    });
  });

  it('includes stocksLeft per-game when tracked, omits it when not', () => {
    const games: SetGameValues[] = [
      game('win', { stocksLeft: 2 }),
      game('loss', { stocksLeft: undefined }),
    ];
    const payloads = buildSetGamePayloads(shared, games);

    expect(payloads[0]?.stocksLeft).toBe(2);
    expect(payloads[1]?.stocksLeft).toBeUndefined();
    expect('stocksLeft' in payloads[1]!).toBe(false);
  });

  it('includes eventName/tournamentName on every game payload when set', () => {
    const payloads = buildSetGamePayloads(
      { ...shared, eventName: 'Ultimate Singles', tournamentName: 'The Big House 9' },
      [game('win'), game('win')],
    );

    for (const payload of payloads) {
      expect(payload.eventName).toBe('Ultimate Singles');
      expect(payload.tournamentName).toBe('The Big House 9');
    }
  });

  it('omits eventName/tournamentName from every payload when not set', () => {
    const payloads = buildSetGamePayloads(shared, [game('win')]);
    expect('eventName' in payloads[0]!).toBe(false);
    expect('tournamentName' in payloads[0]!).toBe(false);
  });

  it('falls back to the "no selection" stage for an unrecognized stageId', () => {
    const payloads = buildSetGamePayloads(shared, [game('win', { stageId: 999999 })]);
    expect(payloads[0]?.map).toEqual({ id: 0, name: 'no selection' });
  });

  it('includes vodUrl on a game payload only when that game has a non-blank trimmed vodUrl', () => {
    const payloads = buildSetGamePayloads(shared, [
      game('win', { vodUrl: '  https://youtube.com/watch?v=abc123  ' }),
      game('win', { vodUrl: '' }),
      game('win', { vodUrl: '   ' }),
      game('win'),
    ]);
    expect(payloads[0]?.vodUrl).toBe('https://youtube.com/watch?v=abc123');
    expect('vodUrl' in payloads[1]!).toBe(false);
    expect('vodUrl' in payloads[2]!).toBe(false);
    expect('vodUrl' in payloads[3]!).toBe(false);
  });

  it('includes vodStartSeconds (a number) only when the game has BOTH a non-blank vodUrl AND a parseable start-time string', () => {
    const payloads = buildSetGamePayloads(shared, [
      game('win', {
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodStartSeconds: '1:23:45',
      }),
      game('win', { vodUrl: 'https://youtube.com/watch?v=abc123' }),
      game('win', { vodStartSeconds: '1:23:45' }),
    ]);
    expect(payloads[0]?.vodStartSeconds).toBe(5025);
    expect('vodStartSeconds' in payloads[1]!).toBe(false);
    expect('vodStartSeconds' in payloads[2]!).toBe(false);
    expect('vodUrl' in payloads[2]!).toBe(false);
  });

  it('a game with a vodUrl but an unparseable start-time string yields vodUrl with NO vodStartSeconds key (never NaN, never undefined)', () => {
    const payloads = buildSetGamePayloads(shared, [
      game('win', {
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodStartSeconds: 'not-a-time',
      }),
    ]);
    expect(payloads[0]?.vodUrl).toBe('https://youtube.com/watch?v=abc123');
    expect('vodStartSeconds' in payloads[0]!).toBe(false);
    expect(payloads[0]?.vodStartSeconds).not.toBeNaN();
  });
});

describe('buildDefaultGameValues', () => {
  it('defaults to the no-selection stage and no result/stocks/vod fields', () => {
    const values = buildDefaultGameValues();
    expect(values.stageId).toBe(0);
    expect(values.result).toBeUndefined();
    expect(values.stocksLeft).toBeUndefined();
    expect(values.vodUrl).toBeUndefined();
    expect(values.vodStartSeconds).toBeUndefined();
  });
});
