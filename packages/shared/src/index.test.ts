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
  opponentAliasMapSchema,
  opponentListSchema,
  opponentMapSchema,
  opponentNameInputSchema,
  stageSchema,
  tournamentEntrySchema,
  updateMatchInputSchema,
  upsertOpponentAliasInputSchema,
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

  it('accepts stocksLeft within 0-3', () => {
    for (const stocksLeft of [0, 1, 2, 3]) {
      const record = {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
        stocksLeft,
      };
      expect(matchRecordSchema.parse(record)).toEqual(record);
    }
  });

  it('rejects stocksLeft outside 0-3', () => {
    for (const stocksLeft of [-1, 4]) {
      expect(() =>
        matchRecordSchema.parse({
          fighter_id: 1,
          opponent_id: 8,
          time: 1700000000000,
          win: true,
          stocksLeft,
        }),
      ).toThrow();
    }
  });

  it('rejects a non-integer stocksLeft', () => {
    expect(() =>
      matchRecordSchema.parse({
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
        stocksLeft: 1.5,
      }),
    ).toThrow();
  });

  it('parses opponentSeed/opponentPlacement/opponentUserSlug when start.gg provides them', () => {
    const record = {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      opponentSeed: 12,
      opponentPlacement: 33,
      opponentUserSlug: 'user/9fb774ae',
    };
    expect(matchRecordSchema.parse(record)).toEqual(record);
  });

  it('omits opponentSeed/opponentPlacement/opponentUserSlug when absent', () => {
    const record = {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
    };
    const parsed = matchRecordSchema.parse(record);
    expect('opponentSeed' in parsed).toBe(false);
    expect('opponentPlacement' in parsed).toBe(false);
    expect('opponentUserSlug' in parsed).toBe(false);
  });

  it('rejects a non-positive opponentSeed or opponentPlacement', () => {
    expect(() =>
      matchRecordSchema.parse({
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
        opponentSeed: 0,
      }),
    ).toThrow();
    expect(() =>
      matchRecordSchema.parse({
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
        opponentPlacement: -1,
      }),
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

  const baseInput = {
    fighter_id: 1,
    opponent_id: 8,
    map: { id: 0, name: 'no selection' },
    opponent: 'someplayer',
    matchType: 'none',
    win: true,
  } as const;

  it('accepts stocksLeft within 0-3', () => {
    for (const stocksLeft of [0, 1, 2, 3]) {
      expect(createMatchInputSchema.parse({ ...baseInput, stocksLeft }).stocksLeft).toBe(
        stocksLeft,
      );
    }
  });

  it('rejects stocksLeft outside 0-3', () => {
    for (const stocksLeft of [-1, 4]) {
      expect(() => createMatchInputSchema.parse({ ...baseInput, stocksLeft })).toThrow();
    }
  });

  it('omits stocksLeft when not provided', () => {
    const parsed = createMatchInputSchema.parse(baseInput);
    expect(parsed.stocksLeft).toBeUndefined();
  });

  it('trims eventName and tournamentName', () => {
    const parsed = createMatchInputSchema.parse({
      ...baseInput,
      eventName: '  Ultimate Singles  ',
      tournamentName: '  The Big House 9  ',
    });
    expect(parsed.eventName).toBe('Ultimate Singles');
    expect(parsed.tournamentName).toBe('The Big House 9');
  });

  it('transforms empty/whitespace-only eventName/tournamentName to undefined, never an empty string', () => {
    const parsed = createMatchInputSchema.parse({
      ...baseInput,
      eventName: '',
      tournamentName: '   ',
    });
    // Zod keeps parsed object keys present with an `undefined` value rather
    // than deleting them; `JSON.stringify` (what actually goes over the
    // wire / into RTDB's .set()) drops `undefined`-valued keys, so this is
    // equivalent to omission for every real caller.
    expect(parsed.eventName).toBeUndefined();
    expect(parsed.tournamentName).toBeUndefined();
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty('eventName');
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty('tournamentName');
  });

  it('omits eventName/tournamentName when not provided at all', () => {
    const parsed = createMatchInputSchema.parse(baseInput);
    expect(parsed.eventName).toBeUndefined();
    expect(parsed.tournamentName).toBeUndefined();
  });

  it('rejects eventName/tournamentName over 80 characters', () => {
    const tooLong = 'a'.repeat(81);
    expect(() => createMatchInputSchema.parse({ ...baseInput, eventName: tooLong })).toThrow();
    expect(() => createMatchInputSchema.parse({ ...baseInput, tournamentName: tooLong })).toThrow();
  });

  it('accepts eventName/tournamentName at exactly 80 characters', () => {
    const max = 'a'.repeat(80);
    const parsed = createMatchInputSchema.parse({
      ...baseInput,
      eventName: max,
      tournamentName: max,
    });
    expect(parsed.eventName).toBe(max);
    expect(parsed.tournamentName).toBe(max);
  });

  it('does not accept source/externalId from client input', () => {
    const parsed = createMatchInputSchema.parse({
      ...baseInput,
      source: 'startgg',
      externalId: 'sgg:123:g1',
    });
    expect((parsed as Record<string, unknown>).source).toBeUndefined();
    expect((parsed as Record<string, unknown>).externalId).toBeUndefined();
  });
});

describe('updateMatchInputSchema', () => {
  it('is the same shape as createMatchInputSchema (full-overwrite semantics)', () => {
    expect(updateMatchInputSchema).toBe(createMatchInputSchema);
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

describe('opponentNameInputSchema', () => {
  it('trims and lowercases', () => {
    expect(opponentNameInputSchema.parse('  SomePlayer  ')).toBe('someplayer');
  });

  it('rejects a blank name', () => {
    expect(() => opponentNameInputSchema.parse('   ')).toThrow();
  });

  it('rejects RTDB-reserved characters', () => {
    for (const badName of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b']) {
      expect(() => opponentNameInputSchema.parse(badName)).toThrow();
    }
  });

  it('allows spaces', () => {
    expect(opponentNameInputSchema.parse('team mate')).toBe('team mate');
  });
});

describe('opponentAliasMapSchema', () => {
  it('parses a flat alias -> canonical map', () => {
    const map = { rivl: 'rival', riv: 'rival' };
    expect(opponentAliasMapSchema.parse(map)).toEqual(map);
  });

  it('parses an empty map', () => {
    expect(opponentAliasMapSchema.parse({})).toEqual({});
  });
});

describe('upsertOpponentAliasInputSchema', () => {
  it('normalizes the canonical name', () => {
    expect(upsertOpponentAliasInputSchema.parse({ canonical: '  Rival  ' })).toEqual({
      canonical: 'rival',
    });
  });

  it('rejects a blank canonical name', () => {
    expect(() => upsertOpponentAliasInputSchema.parse({ canonical: '' })).toThrow();
  });
});

describe('tournamentEntrySchema', () => {
  const base = {
    eventId: 987,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_700_000_000_000,
    lastSetAt: 1_700_000_500_000,
    setsPlayed: 5,
  };

  it('parses the base shape without slug/eventSlug/topStandings', () => {
    expect(tournamentEntrySchema.parse(base)).toEqual(base);
  });

  it('parses slug, eventSlug, and topStandings when present', () => {
    const entry = {
      ...base,
      slug: 'tournament/the-box-juice-box-26',
      eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
      topStandings: [
        { placement: 1, name: 'Champ', gamerTag: 'Champ', userSlug: 'user/abc123' },
        { placement: 2, name: 'RunnerUp' },
      ],
    };
    expect(tournamentEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects a topStandings array longer than 8', () => {
    const topStandings = Array.from({ length: 9 }, (_, i) => ({
      placement: i + 1,
      name: `Player ${i + 1}`,
    }));
    expect(() => tournamentEntrySchema.parse({ ...base, topStandings })).toThrow();
  });

  it('rejects a topStandings entry missing a placement or name', () => {
    expect(() =>
      tournamentEntrySchema.parse({ ...base, topStandings: [{ name: 'NoPlacement' }] }),
    ).toThrow();
    expect(() =>
      tournamentEntrySchema.parse({ ...base, topStandings: [{ placement: 1 }] }),
    ).toThrow();
  });
});
