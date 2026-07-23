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
    vodUrl: '',
    vodStartSeconds: '',
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

  it('includes vodUrl when provided', () => {
    const input = matchFormValuesToInput(
      baseValues({ vodUrl: 'https://youtube.com/watch?v=abc123' }),
    );
    expect(input.vodUrl).toBe('https://youtube.com/watch?v=abc123');
  });

  it('trims vodUrl before including it', () => {
    const input = matchFormValuesToInput(
      baseValues({ vodUrl: '  https://youtube.com/watch?v=abc123  ' }),
    );
    expect(input.vodUrl).toBe('https://youtube.com/watch?v=abc123');
  });

  it('omits vodUrl when blank or whitespace-only', () => {
    expect('vodUrl' in matchFormValuesToInput(baseValues({ vodUrl: '' }))).toBe(false);
    expect('vodUrl' in matchFormValuesToInput(baseValues({ vodUrl: '   ' }))).toBe(false);
  });

  it('parses and includes vodStartSeconds when vodUrl is present', () => {
    const input = matchFormValuesToInput(
      baseValues({
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodStartSeconds: '1:23:45',
      }),
    );
    expect(input.vodStartSeconds).toBe(5025);
  });

  it('accepts bare-seconds and duration-form vodStartSeconds input', () => {
    expect(
      matchFormValuesToInput(
        baseValues({ vodUrl: 'https://youtube.com/watch?v=abc123', vodStartSeconds: '5025' }),
      ).vodStartSeconds,
    ).toBe(5025);
    expect(
      matchFormValuesToInput(
        baseValues({ vodUrl: 'https://youtube.com/watch?v=abc123', vodStartSeconds: '1h23m45s' }),
      ).vodStartSeconds,
    ).toBe(5025);
  });

  it('omits vodStartSeconds when blank', () => {
    const input = matchFormValuesToInput(
      baseValues({ vodUrl: 'https://youtube.com/watch?v=abc123', vodStartSeconds: '' }),
    );
    expect('vodStartSeconds' in input).toBe(false);
  });

  it('omits vodStartSeconds when vodUrl is blank, even if vodStartSeconds was typed', () => {
    const input = matchFormValuesToInput(baseValues({ vodUrl: '', vodStartSeconds: '1:23:45' }));
    expect('vodStartSeconds' in input).toBe(false);
    expect('vodUrl' in input).toBe(false);
  });

  it('sets map.form when stageForm is one of the three valid members', () => {
    for (const stageForm of ['normal', 'battlefield', 'omega'] as const) {
      const input = matchFormValuesToInput(baseValues({ stageForm }));
      expect(input.map.form).toBe(stageForm);
    }
  });

  it('builds map with NO own `form` property when stageForm is unset', () => {
    const input = matchFormValuesToInput(baseValues());
    expect('form' in input.map).toBe(false);
  });
});
