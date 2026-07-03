import { describe, expect, it } from 'vitest';
import {
  createMatchInputSchema,
  fighterIdListSchema,
  fighterSchema,
  fighterSelectionSchema,
  healthCheckSchema,
  matchRecordSchema,
  matchSchema,
  matchTypeSchema,
  opponentListSchema,
  opponentMapSchema,
  stageSchema,
  userProfileSchema,
  userSchema,
} from './index.js';

describe('healthCheckSchema', () => {
  it('parses a valid health check payload', () => {
    expect(healthCheckSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it('rejects an invalid status', () => {
    expect(() => healthCheckSchema.parse({ status: 'bad' })).toThrow();
  });
});

describe('userSchema', () => {
  it('parses a valid user', () => {
    expect(userSchema.parse({ email: 'a@example.com' })).toEqual({ email: 'a@example.com' });
  });

  it('rejects an invalid email', () => {
    expect(() => userSchema.parse({ email: 'not-an-email' })).toThrow();
  });
});

describe('userProfileSchema', () => {
  it('parses a full profile', () => {
    const profile = {
      uid: 'abc123',
      email: 'a@example.com',
      fighters: { primary: [1, 2], secondary: [] },
    };
    expect(userProfileSchema.parse(profile)).toEqual(profile);
  });
});

describe('fighter/stage reference schemas', () => {
  it('parses a fighter entry', () => {
    const fighter = { id: 1, name: 'Mario', url: '/assets/sprites/1-mario-sprite.png' };
    expect(fighterSchema.parse(fighter)).toEqual(fighter);
  });

  it('parses a stage entry', () => {
    const stage = { id: 1, name: 'Battlefield', url: '/assets/stages/1-battlefield.jpg' };
    expect(stageSchema.parse(stage)).toEqual(stage);
  });

  it('parses a fighter id list', () => {
    expect(fighterIdListSchema.parse([1, 8, 41])).toEqual([1, 8, 41]);
  });

  it('rejects non-positive fighter ids', () => {
    expect(() => fighterIdListSchema.parse([0])).toThrow();
  });
});

describe('fighterSelectionSchema', () => {
  it('parses primary/secondary selections', () => {
    const selection = { primary: [1, 2], secondary: [3] };
    expect(fighterSelectionSchema.parse(selection)).toEqual(selection);
  });
});

describe('matchTypeSchema', () => {
  it('accepts all legacy match type literals', () => {
    for (const value of [
      'none',
      'quickplay',
      'online-friendly',
      'online-tourney',
      'offline-friendly',
      'offline-tourney',
    ]) {
      expect(matchTypeSchema.parse(value)).toBe(value);
    }
  });

  it('rejects an unknown match type', () => {
    expect(() => matchTypeSchema.parse('ranked')).toThrow();
  });
});

describe('matchRecordSchema', () => {
  it('parses a full legacy-shaped match record', () => {
    const record = {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'someplayer',
      notes: 'close game',
      matchType: 'online-friendly',
      win: true,
    };
    expect(matchRecordSchema.parse(record)).toEqual(record);
  });

  it('parses an old record missing optional fields', () => {
    const record = {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
    };
    expect(matchRecordSchema.parse(record)).toEqual(record);
  });

  it('accepts an empty-string matchType (legacy default)', () => {
    const record = {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      matchType: '',
      win: false,
    };
    expect(matchRecordSchema.parse(record).matchType).toBe('');
  });

  it('rejects a record missing win', () => {
    expect(() =>
      matchRecordSchema.parse({ fighter_id: 1, opponent_id: 8, time: 1700000000000 }),
    ).toThrow();
  });
});

describe('matchSchema', () => {
  it('requires an id in addition to the record fields', () => {
    const match = {
      id: '-Nabc123',
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
    };
    expect(matchSchema.parse(match)).toEqual(match);
  });
});

describe('createMatchInputSchema', () => {
  it('parses a create payload and defaults notes', () => {
    const input = {
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 0, name: 'no selection' },
      opponent: 'someplayer',
      matchType: 'none',
      win: true,
    };
    expect(createMatchInputSchema.parse(input)).toEqual({ ...input, notes: '' });
  });

  it('rejects a blank opponent name', () => {
    expect(() =>
      createMatchInputSchema.parse({
        fighter_id: 1,
        opponent_id: 8,
        map: { id: 0, name: 'no selection' },
        opponent: '',
        matchType: 'none',
        win: true,
      }),
    ).toThrow();
  });

  it('normalizes opponent name casing and whitespace to match legacy client behavior', () => {
    const input = {
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 0, name: 'no selection' },
      opponent: '  SomePlayer  ',
      matchType: 'none',
      win: true,
    };
    expect(createMatchInputSchema.parse(input).opponent).toBe('someplayer');
  });

  it('rejects an opponent name containing RTDB-reserved key characters', () => {
    for (const badName of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b']) {
      expect(() =>
        createMatchInputSchema.parse({
          fighter_id: 1,
          opponent_id: 8,
          map: { id: 0, name: 'no selection' },
          opponent: badName,
          matchType: 'none',
          win: true,
        }),
      ).toThrow();
    }
  });

  it('allows spaces in opponent names (legacy free-text names may contain them)', () => {
    const input = {
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 0, name: 'no selection' },
      opponent: 'team mate',
      matchType: 'none',
      win: true,
    };
    expect(createMatchInputSchema.parse(input).opponent).toBe('team mate');
  });
});

describe('opponent schemas', () => {
  it('parses an opponent map', () => {
    expect(opponentMapSchema.parse({ someplayer: true, other: true })).toEqual({
      someplayer: true,
      other: true,
    });
  });

  it('parses an opponent list', () => {
    expect(opponentListSchema.parse(['someplayer', 'other'])).toEqual(['someplayer', 'other']);
  });
});
