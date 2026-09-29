import { describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import {
  WATCHLIST_ITEM_KEY_PATTERN,
  WATCHLIST_ITEM_KINDS,
  WATCHLIST_MAX_ITEMS,
  buildWatchlistItemKey,
  trackedItemScope,
  watchlistItemKeySchema,
  watchlistItemStoredSchema,
  watchlistResponseSchema,
  watchlistTrackInputSchema,
  watchlistTrackResponseSchema,
} from './watchlist.js';

const RTDB_ILLEGAL = ['.', '#', '$', '[', ']', '/'];

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) <= 0x1f || value.charCodeAt(i) === 0x7f) return true;
  }
  return false;
}

function match(overrides: Partial<Match> & Pick<Match, 'id'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    opponent: 'someone',
    time: 1_700_000_000_000,
    win: true,
    matchType: 'none',
    ...overrides,
  };
}

describe('watchlist constants', () => {
  it('caps the list at 25 items and names exactly three kinds', () => {
    expect(WATCHLIST_MAX_ITEMS).toBe(25);
    expect([...WATCHLIST_ITEM_KINDS]).toEqual(['opponent', 'matchup', 'stage']);
  });
});

describe('buildWatchlistItemKey (T-02: deterministic, letter-prefixed, RTDB-safe)', () => {
  it('builds the documented key grammar', () => {
    expect(buildWatchlistItemKey({ kind: 'opponent', ref: 'mkleo' })).toBe('opponent:mkleo');
    expect(buildWatchlistItemKey({ kind: 'matchup', ref: { fighterId: 1, vsFighterId: 10 } })).toBe(
      'matchup:1-10',
    );
    expect(buildWatchlistItemKey({ kind: 'stage', ref: 3 })).toBe('stage:3');
  });

  it('is deterministic', () => {
    const input = { kind: 'matchup', ref: { fighterId: 7, vsFighterId: 8 } } as const;
    expect(buildWatchlistItemKey(input)).toBe(buildWatchlistItemKey({ ...input }));
  });

  it('every key produced for a fuzzed set of valid inputs matches the pattern and has no RTDB-illegal character', () => {
    const tags = ['mkleo', 'a', 'sparg0', 'two words', 'tag-with_dash', 'ünïcode', 'x'.repeat(80)];
    const keys: string[] = [];
    for (const tag of tags) {
      const parsed = watchlistTrackInputSchema.parse({ kind: 'opponent', ref: tag });
      keys.push(buildWatchlistItemKey(parsed));
    }
    for (let f = 1; f <= 90; f += 13) {
      for (let v = 1; v <= 90; v += 17) {
        keys.push(
          buildWatchlistItemKey({ kind: 'matchup', ref: { fighterId: f, vsFighterId: v } }),
        );
      }
    }
    for (let s = 1; s <= 200; s += 19) {
      keys.push(buildWatchlistItemKey({ kind: 'stage', ref: s }));
    }
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      expect(WATCHLIST_ITEM_KEY_PATTERN.test(key), key).toBe(true);
      expect(watchlistItemKeySchema.safeParse(key).success, key).toBe(true);
      expect(hasControlChar(key), key).toBe(false);
      // The kind prefix is the only place a '.', '#' etc. could hide; check the whole key.
      for (const bad of RTDB_ILLEGAL) expect(key.includes(bad), `${key} has ${bad}`).toBe(false);
      // Letter-prefixed: RTDB can never read the keyed map back as an array.
      expect(/^[a-z]/.test(key)).toBe(true);
    }
  });

  it('the key schema rejects illegal characters, wrong kinds and empty refs', () => {
    for (const bad of [
      'opponent:a.b',
      'opponent:a#b',
      'opponent:a$b',
      'opponent:a[b',
      'opponent:a]b',
      'opponent:a/b',
      'opponent:a\u0007b',
      'opponent:',
      'matchup:1',
      'matchup:a-b',
      'stage:',
      'stage:x',
      'player:mkleo',
      '3',
      '',
    ]) {
      expect(watchlistItemKeySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('watchlistTrackInputSchema (client sends kind + ref only)', () => {
  it('normalises an opponent tag (trim + lowercase) like the opponent name schema', () => {
    const parsed = watchlistTrackInputSchema.parse({ kind: 'opponent', ref: '  MkLeo ' });
    expect(parsed).toEqual({ kind: 'opponent', ref: 'mkleo' });
  });

  it('rejects an opponent tag carrying an RTDB-illegal character or a control character', () => {
    for (const ref of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'a\u0000b', '']) {
      expect(
        watchlistTrackInputSchema.safeParse({ kind: 'opponent', ref }).success,
        JSON.stringify(ref),
      ).toBe(false);
    }
  });

  it('rejects an over-long opponent tag', () => {
    expect(
      watchlistTrackInputSchema.safeParse({ kind: 'opponent', ref: 'x'.repeat(81) }).success,
    ).toBe(false);
  });

  it('accepts matchup and stage refs and rejects malformed ones', () => {
    expect(
      watchlistTrackInputSchema.safeParse({
        kind: 'matchup',
        ref: { fighterId: 1, vsFighterId: 10 },
      }).success,
    ).toBe(true);
    expect(watchlistTrackInputSchema.safeParse({ kind: 'stage', ref: 3 }).success).toBe(true);
    for (const bad of [
      { kind: 'matchup', ref: { fighterId: 0, vsFighterId: 10 } },
      { kind: 'matchup', ref: { fighterId: 1.5, vsFighterId: 10 } },
      { kind: 'matchup', ref: 'x' },
      { kind: 'stage', ref: 0 },
      { kind: 'stage', ref: 'battlefield' },
    ]) {
      expect(watchlistTrackInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects an unknown kind and strips createdAt/itemKey the client must never send', () => {
    expect(watchlistTrackInputSchema.safeParse({ kind: 'tier', ref: 'major' }).success).toBe(false);
    const parsed = watchlistTrackInputSchema.parse({
      kind: 'stage',
      ref: 3,
      createdAt: 5,
      itemKey: 'stage:99',
    });
    expect(parsed).toEqual({ kind: 'stage', ref: 3 });
  });
});

describe('watchlistItemStoredSchema (RTDB null-stripping: note is .nullish())', () => {
  it('parses an item with note absent, note null, and a note string', () => {
    const base = { kind: 'stage', ref: 3, createdAt: 1_700_000_000_000 } as const;
    expect(watchlistItemStoredSchema.safeParse(base).success).toBe(true);
    expect(watchlistItemStoredSchema.safeParse({ ...base, note: null }).success).toBe(true);
    expect(watchlistItemStoredSchema.safeParse({ ...base, note: 'watch the ledge' }).success).toBe(
      true,
    );
  });

  it('caps note at 280 characters', () => {
    const base = { kind: 'stage', ref: 3, createdAt: 1 } as const;
    expect(watchlistItemStoredSchema.safeParse({ ...base, note: 'n'.repeat(280) }).success).toBe(
      true,
    );
    expect(watchlistItemStoredSchema.safeParse({ ...base, note: 'n'.repeat(281) }).success).toBe(
      false,
    );
  });

  it('rejects an unknown kind, a negative createdAt and a non-integer createdAt', () => {
    expect(
      watchlistItemStoredSchema.safeParse({ kind: 'tier', ref: 1, createdAt: 1 }).success,
    ).toBe(false);
    expect(
      watchlistItemStoredSchema.safeParse({ kind: 'stage', ref: 1, createdAt: -1 }).success,
    ).toBe(false);
    expect(
      watchlistItemStoredSchema.safeParse({ kind: 'stage', ref: 1, createdAt: 1.5 }).success,
    ).toBe(false);
  });
});

describe('wire schemas', () => {
  it('list and track responses carry itemKey + item; the list is an array on the wire', () => {
    const item = { kind: 'opponent', ref: 'mkleo', createdAt: 1 } as const;
    expect(
      watchlistResponseSchema.safeParse({ items: [{ itemKey: 'opponent:mkleo', item }] }).success,
    ).toBe(true);
    expect(watchlistResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      watchlistTrackResponseSchema.safeParse({ itemKey: 'opponent:mkleo', item }).success,
    ).toBe(true);
    expect(watchlistTrackResponseSchema.safeParse({ itemKey: 'bad.key', item }).success).toBe(
      false,
    );
  });
});

describe('trackedItemScope', () => {
  const matches: Match[] = [
    match({
      id: 'a',
      opponent: 'mkleo',
      fighter_id: 1,
      opponent_id: 10,
      map: { id: 3, name: 'x' },
    }),
    match({ id: 'b', opponent: 'leo', fighter_id: 1, opponent_id: 11 }),
    match({
      id: 'c',
      opponent: 'sparg0',
      fighter_id: 2,
      opponent_id: 10,
      map: { id: 3, name: 'x' },
    }),
    match({
      id: 'd',
      opponent: 'sparg0',
      fighter_id: 1,
      opponent_id: 10,
      map: { id: 0, name: 'none' },
    }),
  ];
  const ids = (list: Match[]) => list.map((m) => m.id);

  it('opponent -> player scope keyed player:<tag> with an { opponent } axis', () => {
    const scope = trackedItemScope({ kind: 'opponent', ref: 'sparg0', createdAt: 1 });
    expect(scope.kind).toBe('player');
    expect(scope.key).toBe('player:sparg0');
    expect(scope.axes).toEqual({ opponent: 'sparg0' });
    expect(ids(scope.filter(matches))).toEqual(['c', 'd']);
  });

  it('opponent scope folds aliases into the canonical tag (the hub identity technique)', () => {
    const scope = trackedItemScope(
      { kind: 'opponent', ref: 'mkleo', createdAt: 1 },
      { opponentAliases: ['leo'] },
    );
    expect(ids(scope.filter(matches))).toEqual(['a', 'b']);
    const withoutAlias = trackedItemScope({ kind: 'opponent', ref: 'mkleo', createdAt: 1 });
    expect(ids(withoutAlias.filter(matches))).toEqual(['a']);
  });

  it('matchup -> character scope keyed matchup:<f>-<v> selecting the exact fighter pairing', () => {
    const scope = trackedItemScope({
      kind: 'matchup',
      ref: { fighterId: 1, vsFighterId: 10 },
      createdAt: 1,
    });
    expect(scope.kind).toBe('character');
    expect(scope.key).toBe('matchup:1-10');
    expect(scope.axes).toEqual({ fighter: 1, vs: 10 });
    expect(ids(scope.filter(matches))).toEqual(['a', 'd']);
  });

  it('stage -> stage scope keyed stage:<id> selecting by the stage bucket id', () => {
    const scope = trackedItemScope({ kind: 'stage', ref: 3, createdAt: 1 });
    expect(scope.kind).toBe('stage');
    expect(scope.key).toBe('stage:3');
    expect(scope.axes).toEqual({ stage: 3 });
    expect(ids(scope.filter(matches))).toEqual(['a', 'c']);
  });
});
