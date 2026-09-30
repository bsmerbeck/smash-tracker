import { describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import { classify } from './insight/ladder.js';
import type { RateValue } from './insight/types.js';
import {
  DIGEST_HORIZON,
  DIGEST_MOVED_ROW_CAP,
  DIGEST_STATE_CLASSES,
  MOVED_FALSE_DIRECTION_BUDGET,
  MOVED_NOTABLE_Z,
  digestSnapshotSchema,
  movedTransition,
  parseDigestSnapshot,
  selectMovedItems,
  stateClassFor,
  stateClassFromClassify,
  type DigestMovedToken,
  type DigestStateClass,
} from './digest.js';
import type { WatchlistItem } from './watchlist.js';

const NOW_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

/** Builds `count` Mario(1)-vs-Luigi(10) games ending at `endIndex`, winning per `winAt(i)`. */
function games(params: {
  startIndex: number;
  count: number;
  winAt: (i: number) => boolean;
  fighterId?: number;
  opponentId?: number;
  opponent?: string;
}): Match[] {
  const { startIndex, count, winAt, fighterId = 1, opponentId = 10, opponent = 'rival' } = params;
  const rows: Match[] = [];
  for (let i = startIndex; i < startIndex + count; i += 1) {
    rows.push({
      id: `g${String(i).padStart(5, '0')}`,
      fighter_id: fighterId,
      opponent_id: opponentId,
      opponent,
      time: NOW_MS - (1000 - i) * HOUR_MS,
      win: winAt(i),
      matchType: 'none',
    });
  }
  return rows;
}

const MARIO_LUIGI: WatchlistItem = {
  kind: 'matchup',
  ref: { fighterId: 1, vsFighterId: 10 },
  createdAt: 1,
};

function rate(wins: number, losses: number): RateValue {
  const total = wins + losses;
  return { wins, losses, total, rate: total > 0 ? wins / total : 0 };
}

describe('digest constants', () => {
  it('pins the shipped values the plan and UI-SPEC name', () => {
    expect(MOVED_NOTABLE_Z).toBe(3.09);
    expect(DIGEST_HORIZON).toBe('last30');
    expect(DIGEST_MOVED_ROW_CAP).toBe(5);
    expect(MOVED_FALSE_DIRECTION_BUDGET).toBe(0.05);
    expect([...DIGEST_STATE_CLASSES]).toEqual([
      'up',
      'down',
      'steady',
      'locked',
      'thin',
      'thinRecent',
      'collapsed',
      'none',
    ]);
  });
});

describe('stateClassFromClassify', () => {
  it('maps trend/suggestion by delta sign and other states by name', () => {
    expect(stateClassFromClassify({ state: 'trend', kind: 'inference', deltaPoints: 12 })).toBe(
      'up',
    );
    expect(stateClassFromClassify({ state: 'trend', kind: 'inference', deltaPoints: -12 })).toBe(
      'down',
    );
    expect(
      stateClassFromClassify({ state: 'suggestion', kind: 'recommendation', deltaPoints: 9 }),
    ).toBe('up');
    expect(stateClassFromClassify({ state: 'steady', kind: 'fact', deltaPoints: null })).toBe(
      'steady',
    );
    expect(stateClassFromClassify({ state: 'locked', kind: 'fact', deltaPoints: null })).toBe(
      'locked',
    );
    expect(stateClassFromClassify({ state: 'thin', kind: 'fact', deltaPoints: null })).toBe('thin');
    expect(stateClassFromClassify({ state: 'thinRecent', kind: 'fact', deltaPoints: null })).toBe(
      'thinRecent',
    );
    expect(stateClassFromClassify({ state: 'collapsed', kind: 'fact', deltaPoints: null })).toBe(
      'collapsed',
    );
    expect(stateClassFromClassify({ state: 'hidden', kind: 'fact', deltaPoints: null })).toBe(
      'none',
    );
  });

  it('never asserts a direction from a zero delta', () => {
    expect(stateClassFromClassify({ state: 'trend', kind: 'inference', deltaPoints: 0 })).toBe(
      'steady',
    );
  });
});

describe('stateClassFor: the engine read at the fixed horizon and the stricter z (D-05, F6)', () => {
  it('a Mario-vs-Luigi item with 200 games at 50% reads steady, then up after 30 games at 90%', () => {
    const before = games({ startIndex: 0, count: 200, winAt: (i) => i % 2 === 0 });
    const after = [
      ...before,
      ...games({ startIndex: 200, count: 30, winAt: (i) => (i - 200) % 10 !== 0 }),
    ];
    expect(
      stateClassFor({ matches: before, item: MARIO_LUIGI, nowMs: NOW_MS, opponentAliases: [] }),
    ).toBe('steady');
    expect(
      stateClassFor({ matches: after, item: MARIO_LUIGI, nowMs: NOW_MS, opponentAliases: [] }),
    ).toBe('up');
    expect(movedTransition('steady', 'up')).toBe('up');
  });

  it('reads down when the last 30 fall well below the baseline', () => {
    const before = games({ startIndex: 0, count: 200, winAt: (i) => i % 2 === 0 });
    const after = [
      ...before,
      ...games({ startIndex: 200, count: 30, winAt: (i) => (i - 200) % 10 === 0 }),
    ];
    expect(
      stateClassFor({ matches: after, item: MARIO_LUIGI, nowMs: NOW_MS, opponentAliases: [] }),
    ).toBe('down');
  });

  it('the moved z is stricter than the engine default: a 21-9 last 30 over a 50% baseline is steady here', () => {
    // 21-9 (70%) over a ~44% baseline is a `trend` at z 1.96 but not notable at 3.09.
    const older = games({ startIndex: 0, count: 200, winAt: (i) => i % 5 < 2 });
    const recent = games({ startIndex: 200, count: 30, winAt: (i) => (i - 200) % 10 < 7 });
    const matches = [...older, ...recent];
    expect(stateClassFor({ matches, item: MARIO_LUIGI, nowMs: NOW_MS, opponentAliases: [] })).toBe(
      'steady',
    );
    const recentRate = rate(21, 9);
    // baseline over all 230 games: 80 wins in the older 200 plus the 21 recent wins
    const baseline = rate(80 + 21, 120 + 9);
    expect(classify({ recent: recentRate, baseline, scoped: true, hasAction: false }).state).toBe(
      'trend',
    );
  });

  it('no games in scope is none; one game is locked; a page-switch-free fixed horizon is last30', () => {
    expect(
      stateClassFor({ matches: [], item: MARIO_LUIGI, nowMs: NOW_MS, opponentAliases: [] }),
    ).toBe('none');
    expect(
      stateClassFor({
        matches: games({ startIndex: 0, count: 1, winAt: () => true }),
        item: MARIO_LUIGI,
        nowMs: NOW_MS,
        opponentAliases: [],
      }),
    ).toBe('locked');
  });

  it('ignores games outside the item scope', () => {
    const other = games({ startIndex: 0, count: 60, winAt: () => true, fighterId: 2 });
    expect(
      stateClassFor({ matches: other, item: MARIO_LUIGI, nowMs: NOW_MS, opponentAliases: [] }),
    ).toBe('none');
  });
});

describe('movedTransition (D-05 table; anything unlisted is not a move)', () => {
  const direction: DigestStateClass[] = ['steady', 'up', 'down'];
  const nonAssertive: DigestStateClass[] = ['thin', 'thinRecent', 'collapsed'];

  function expected(prev: DigestStateClass, next: DigestStateClass): DigestMovedToken | null {
    if (direction.includes(prev) && direction.includes(next) && prev !== next) {
      return next as DigestMovedToken;
    }
    if (prev === 'locked' && next !== 'locked' && next !== 'none') return 'unlocked';
    // 39.2-REVIEW SH-WR-05 (D-05 interpretation): out of `none` counts only into a read that
    // asserts a class (steady/up/down); none -> locked/thin/thinRecent/collapsed is not a move.
    if (prev === 'none' && direction.includes(next)) return 'unlocked';
    if (nonAssertive.includes(prev) && (next === 'up' || next === 'down')) return 'asserting';
    return null;
  }

  it('enumerates every (prev, next) pair and is non-null ONLY for the listed transitions', () => {
    let moved = 0;
    for (const prev of DIGEST_STATE_CLASSES) {
      for (const next of DIGEST_STATE_CLASSES) {
        const got = movedTransition(prev, next);
        expect(got, `${prev} -> ${next}`).toBe(expected(prev, next));
        if (got !== null) moved += 1;
      }
    }
    // 6 direction pairs + locked -> 6 non-locked/non-none + 3 x 2 asserting + none -> 3 direction.
    expect(moved).toBe(6 + 6 + 6 + 3);
  });

  it('spot checks the documented examples', () => {
    expect(movedTransition('thin', 'steady')).toBeNull();
    expect(movedTransition('collapsed', 'steady')).toBeNull();
    expect(movedTransition('thin', 'collapsed')).toBeNull();
    expect(movedTransition(undefined, 'up')).toBeNull();
    expect(movedTransition('locked', 'steady')).toBe('unlocked');
    expect(movedTransition('thinRecent', 'down')).toBe('asserting');
    expect(movedTransition('up', 'down')).toBe('down');
    expect(movedTransition('down', 'steady')).toBe('steady');
    expect(movedTransition('steady', 'steady')).toBeNull();
  });

  it('SH-WR-05: a never-played item that now asserts a class moved; one that is merely locked did not', () => {
    expect(movedTransition('none', 'steady')).toBe('unlocked');
    expect(movedTransition('none', 'up')).toBe('unlocked');
    expect(movedTransition('none', 'down')).toBe('unlocked');
    expect(movedTransition('none', 'locked')).toBeNull();
    expect(movedTransition('none', 'thinRecent')).toBeNull();
    expect(movedTransition('none', 'none')).toBeNull();
  });
});

describe('parseDigestSnapshot (T-03: tolerant, corrupt reads as first visit)', () => {
  const good = {
    lastSeenAt: 1_700_000_000_000,
    lastSeenMatchCount: 42,
    tracked: { 'stage:3': 'up' },
  };

  it('parses a valid snapshot from JSON text', () => {
    expect(parseDigestSnapshot(JSON.stringify(good))).toEqual(good);
    expect(digestSnapshotSchema.safeParse(good).success).toBe(true);
  });

  it('returns null for absent, invalid JSON, wrong shape, unknown class and over-25 keys', () => {
    expect(parseDigestSnapshot(null)).toBeNull();
    expect(parseDigestSnapshot(undefined)).toBeNull();
    expect(parseDigestSnapshot('')).toBeNull();
    expect(parseDigestSnapshot('{not json')).toBeNull();
    expect(parseDigestSnapshot('[]')).toBeNull();
    expect(parseDigestSnapshot('"text"')).toBeNull();
    expect(parseDigestSnapshot(JSON.stringify({ ...good, lastSeenAt: 'x' }))).toBeNull();
    expect(parseDigestSnapshot(JSON.stringify({ ...good, lastSeenMatchCount: -1 }))).toBeNull();
    expect(
      parseDigestSnapshot(JSON.stringify({ ...good, tracked: { 'stage:3': 'sideways' } })),
    ).toBeNull();
    expect(parseDigestSnapshot(JSON.stringify({ ...good, tracked: [] }))).toBeNull();
    const many: Record<string, string> = {};
    for (let i = 1; i <= 26; i += 1) many[`stage:${i}`] = 'steady';
    expect(parseDigestSnapshot(JSON.stringify({ ...good, tracked: many }))).toBeNull();
    const exactly25: Record<string, string> = {};
    for (let i = 1; i <= 25; i += 1) exactly25[`stage:${i}`] = 'steady';
    expect(parseDigestSnapshot(JSON.stringify({ ...good, tracked: exactly25 }))).not.toBeNull();
  });

  it('never throws on hostile input', () => {
    for (const raw of [
      'null',
      'true',
      '1',
      '{"tracked":{"__proto__":"up"}}',
      '\u0000',
      '{'.repeat(5000),
    ]) {
      expect(() => parseDigestSnapshot(raw)).not.toThrow();
    }
  });

  it('accepts an empty tracked map (a first visit with no tracked items)', () => {
    expect(parseDigestSnapshot(JSON.stringify({ ...good, tracked: {} }))).toEqual({
      ...good,
      tracked: {},
    });
  });
});

describe('selectMovedItems (D-06: at most 5 shown, ordered by salience)', () => {
  it('over 7 moved items returns 5 shown, highest salience first with ties by itemKey, and moreCount 2', () => {
    const entries = [
      { itemKey: 'stage:7', token: 'up' as const, salience: 10 },
      { itemKey: 'stage:1', token: 'down' as const, salience: 30 },
      { itemKey: 'stage:2', token: 'up' as const, salience: 30 },
      { itemKey: 'stage:3', token: 'asserting' as const, salience: 20 },
      { itemKey: 'stage:4', token: 'steady' as const, salience: 5 },
      { itemKey: 'stage:5', token: 'unlocked' as const, salience: 25 },
      { itemKey: 'stage:6', token: 'up' as const, salience: 1 },
    ];
    const { shown, moreCount } = selectMovedItems(entries);
    expect(shown.map((e) => e.itemKey)).toEqual([
      'stage:1',
      'stage:2',
      'stage:5',
      'stage:3',
      'stage:7',
    ]);
    expect(moreCount).toBe(2);
  });

  it('returns everything with moreCount 0 at or under the cap and does not mutate its input', () => {
    const entries = [
      { itemKey: 'b', token: 'up' as const, salience: 1 },
      { itemKey: 'a', token: 'up' as const, salience: 2 },
    ];
    const snapshot = JSON.stringify(entries);
    const { shown, moreCount } = selectMovedItems(entries);
    expect(shown.map((e) => e.itemKey)).toEqual(['a', 'b']);
    expect(moreCount).toBe(0);
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(selectMovedItems([])).toEqual({ shown: [], moreCount: 0 });
  });
});
