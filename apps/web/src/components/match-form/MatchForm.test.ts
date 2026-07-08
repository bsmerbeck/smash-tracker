import { describe, expect, it } from 'vitest';
import { matchFormValuesToInput, type MatchFormValues } from './MatchForm';

function baseValues(overrides: Partial<MatchFormValues> = {}): MatchFormValues {
  return {
    fighterId: 1,
    opponentFighterId: 8,
    result: 'win',
    stageId: 1,
    matchType: 'offline-tourney',
    opponentName: 'Rival',
    notes: '',
    gsp: '',
    ...overrides,
  };
}

describe('matchFormValuesToInput', () => {
  it('maps the core fields and lowercases the opponent name', () => {
    const input = matchFormValuesToInput(baseValues());
    expect(input).toEqual({
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'rival',
      notes: '',
      matchType: 'offline-tourney',
      win: true,
    });
  });

  it('maps result "loss" to win: false', () => {
    expect(matchFormValuesToInput(baseValues({ result: 'loss' })).win).toBe(false);
  });

  it('falls back to the "no selection" stage for an unrecognized stageId', () => {
    const input = matchFormValuesToInput(baseValues({ stageId: 999999 }));
    expect(input.map).toEqual({ id: 0, name: 'no selection' });
  });

  it('includes stocksLeft when provided', () => {
    const input = matchFormValuesToInput(baseValues({ stocksLeft: 2 }));
    expect(input.stocksLeft).toBe(2);
  });

  it('omits stocksLeft when undefined', () => {
    const input = matchFormValuesToInput(baseValues());
    expect(input.stocksLeft).toBeUndefined();
    expect('stocksLeft' in input).toBe(false);
  });

  it('trims and includes eventName/tournamentName when provided', () => {
    const input = matchFormValuesToInput(
      baseValues({ eventName: '  Ultimate Singles  ', tournamentName: '  The Big House 9  ' }),
    );
    expect(input.eventName).toBe('Ultimate Singles');
    expect(input.tournamentName).toBe('The Big House 9');
  });

  it('omits eventName/tournamentName when undefined', () => {
    const input = matchFormValuesToInput(baseValues());
    expect('eventName' in input).toBe(false);
    expect('tournamentName' in input).toBe(false);
  });

  it('omits eventName/tournamentName when empty or whitespace-only strings', () => {
    const input = matchFormValuesToInput(baseValues({ eventName: '', tournamentName: '   ' }));
    expect('eventName' in input).toBe(false);
    expect('tournamentName' in input).toBe(false);
  });

  it('parses gsp text (commas/spaces tolerated) into the numeric gsp field', () => {
    expect(matchFormValuesToInput(baseValues({ gsp: '12,400,000' })).gsp).toBe(12_400_000);
    expect(matchFormValuesToInput(baseValues({ gsp: '12 400 000' })).gsp).toBe(12_400_000);
  });

  it('omits gsp when blank', () => {
    const input = matchFormValuesToInput(baseValues({ gsp: '  ' }));
    expect('gsp' in input).toBe(false);
  });
});
