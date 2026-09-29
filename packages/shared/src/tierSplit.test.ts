import { describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import { ABSTENTION_FLOOR_GAMES } from './evidence/policy.js';
import {
  assignMatchesToEntries,
  buildTierSplitStats,
  observedOnlineFor,
  resolveEntryTiers,
  type TierSplitEntry,
} from './tierSplit.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function makeEntry(overrides: Partial<TierSplitEntry> & { entryKey: string }): TierSplitEntry {
  return {
    eventName: 'Ultimate Singles',
    tournamentName: 'Fixture Open',
    firstSetAt: T0,
    lastSetAt: T0 + 60_000,
    ...overrides,
  };
}

let matchCounter = 0;
function makeMatch(overrides: Partial<Match> = {}): Match {
  matchCounter += 1;
  return {
    id: `m-${matchCounter}`,
    fighter_id: 1,
    opponent_id: 2,
    time: T0,
    win: true,
    matchType: 'offline-tourney',
    eventName: 'Ultimate Singles',
    tournamentName: 'Fixture Open',
    ...overrides,
  };
}

function gamesFor(count: number, wins: number, overrides: Partial<Match> = {}): Match[] {
  return Array.from({ length: count }, (_, i) => makeMatch({ ...overrides, win: i < wins }));
}

describe('observedOnlineFor', () => {
  it('is true when any linked match is online-tourney or quickplay, else false', () => {
    const entry = makeEntry({ entryKey: 'a' });
    expect(observedOnlineFor(entry, [makeMatch({ matchType: 'online-tourney' })])).toBe(true);
    expect(observedOnlineFor(entry, [makeMatch({ matchType: 'quickplay' })])).toBe(true);
    expect(observedOnlineFor(entry, [makeMatch(), makeMatch({ matchType: 'none' })])).toBe(false);
    expect(observedOnlineFor(entry, [])).toBe(false);
  });
});

describe('assignMatchesToEntries — a match belongs to at most one entry', () => {
  it('never counts one match for two same-named events one day apart', () => {
    const early = makeEntry({ entryKey: 'early', firstSetAt: T0, lastSetAt: T0 + 60_000 });
    const late = makeEntry({
      entryKey: 'late',
      firstSetAt: T0 + DAY_MS,
      lastSetAt: T0 + DAY_MS + 60_000,
    });
    // Inside `early`'s own window, but also inside `late`'s padded 24h window.
    const inEarly = makeMatch({ time: T0 + 30_000 });
    // Inside `late`'s own window, also inside `early`'s padded window.
    const inLate = makeMatch({ time: T0 + DAY_MS + 30_000 });
    // Between both windows: nearest wins.
    const nearLate = makeMatch({ time: T0 + DAY_MS - 60_000 });

    const assigned = assignMatchesToEntries([late, early], [inEarly, inLate, nearLate]);

    expect(assigned.get('early')?.map((m) => m.id)).toEqual([inEarly.id]);
    expect(
      assigned
        .get('late')
        ?.map((m) => m.id)
        .sort(),
    ).toEqual([inLate.id, nearLate.id].sort());
    const all = [...assigned.values()].flat();
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
  });

  it('breaks an exact tie by entryKey ascending', () => {
    const a = makeEntry({ entryKey: 'a', firstSetAt: T0, lastSetAt: T0 });
    const b = makeEntry({ entryKey: 'b', firstSetAt: T0, lastSetAt: T0 });
    const match = makeMatch({ time: T0 });

    const assigned = assignMatchesToEntries([b, a], [match]);

    expect(assigned.get('a')?.map((m) => m.id)).toEqual([match.id]);
    expect(assigned.get('b')).toEqual([]);
  });

  it('leaves a match with no candidate entry unassigned', () => {
    const entry = makeEntry({ entryKey: 'a' });
    const stray = makeMatch({ eventName: 'Something Else' });
    const assigned = assignMatchesToEntries([entry], [stray]);
    expect(assigned.get('a')).toEqual([]);
  });
});

describe('resolveEntryTiers', () => {
  it('derives observedOnline from the entry own matches so an unknown-setting online event is not estimated', () => {
    const entry = makeEntry({ entryKey: 'a', numEntrants: 2000 });
    const matches = gamesFor(3, 2, { matchType: 'online-tourney' });

    const [resolved] = resolveEntryTiers([entry], matches);

    expect(resolved?.resolution).toMatchObject({ tier: 'unknown', reason: 'online' });
    expect(resolved?.matches).toHaveLength(3);
  });
});

describe('buildTierSplitStats', () => {
  const supermajor = makeEntry({
    entryKey: 'sm',
    tournamentName: 'Mega Con',
    numEntrants: 1581,
    isOnline: false,
  });
  const minor = makeEntry({
    entryKey: 'mn',
    tournamentName: 'Minor Cup',
    numEntrants: 300,
    isOnline: false,
    tierOverride: { contractVersion: 1, tier: 'minor', setAtMs: 1 },
  });
  const unknown = makeEntry({ entryKey: 'uk', tournamentName: 'Mystery Meet' });
  const side = makeEntry({
    entryKey: 'sd',
    eventName: 'Squad Strike',
    tournamentName: 'Mega Con',
    numEntrants: 900,
    isOnline: false,
  });

  function fixtureMatches(): Match[] {
    return [
      ...gamesFor(4, 3, { tournamentName: 'Mega Con' }),
      ...gamesFor(2, 1, { tournamentName: 'Minor Cup' }),
      ...gamesFor(3, 0, { tournamentName: 'Mystery Meet' }),
      ...gamesFor(5, 5, { eventName: 'Squad Strike', tournamentName: 'Mega Con' }),
    ];
  }

  it('reports per-tier rows only for tiers with events, in TIER_WORDS order, unknown separate', () => {
    const stats = buildTierSplitStats({
      entries: [unknown, minor, supermajor, side],
      matches: fixtureMatches(),
      includeSideEvents: false,
    });

    expect(stats.rows.map((r) => r.tier)).toEqual(['supermajor', 'minor']);
    expect(stats.rows[0]).toMatchObject({
      tier: 'supermajor',
      events: 1,
      estimatedEvents: 1,
      recordedEvents: 0,
      manualEvents: 0,
      wins: 3,
      losses: 1,
      total: 4,
      rate: 0.75,
      gamesNeeded: 0,
    });
    expect(stats.unknown).toMatchObject({ tier: 'unknown', events: 1, wins: 0, losses: 3 });
  });

  it('abstains below the floor: 2 games is a row with a null rate and gamesNeeded 1', () => {
    const stats = buildTierSplitStats({
      entries: [minor],
      matches: gamesFor(2, 1, { tournamentName: 'Minor Cup' }),
      includeSideEvents: false,
    });

    expect(ABSTENTION_FLOOR_GAMES).toBe(3);
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]).toMatchObject({
      tier: 'minor',
      manualEvents: 1,
      total: 2,
      rate: null,
      gamesNeeded: 1,
    });
  });

  it('has no row for a tier with zero events and a null unknown bucket when nothing is unknown', () => {
    const stats = buildTierSplitStats({
      entries: [supermajor],
      matches: gamesFor(4, 2, { tournamentName: 'Mega Con' }),
      includeSideEvents: false,
    });
    expect(stats.rows.map((r) => r.tier)).toEqual(['supermajor']);
    expect(stats.unknown).toBeNull();
  });

  it('excludes side events from rows and cohorts unless includeSideEvents, counting them in coverage.sideExcluded', () => {
    const excluded = buildTierSplitStats({
      entries: [supermajor, side],
      matches: fixtureMatches(),
      includeSideEvents: false,
    });
    expect(excluded.coverage.sideExcluded).toBe(1);
    expect(excluded.unknown).toBeNull();
    expect(excluded.cohorts.a).toHaveLength(4);

    const included = buildTierSplitStats({
      entries: [supermajor, side],
      matches: fixtureMatches(),
      includeSideEvents: true,
    });
    expect(included.coverage.sideExcluded).toBe(0);
    expect(included.unknown).toMatchObject({ events: 1, total: 5 });
    // A side event still resolves Unknown, so it never enters a cohort.
    expect(included.cohorts.a).toHaveLength(4);
    expect(included.cohorts.b).toHaveLength(0);
  });

  it('builds cohort A (supermajor+major) and B (minor+regional+local); unknown never enters either', () => {
    const major = makeEntry({
      entryKey: 'mj',
      tournamentName: 'Major Bash',
      numEntrants: 600,
      isOnline: false,
    });
    const regional = makeEntry({
      entryKey: 'rg',
      tournamentName: 'Regional Rumble',
      numEntrants: 80,
      isOnline: false,
    });
    const matches = [
      ...gamesFor(4, 3, { tournamentName: 'Mega Con' }),
      ...gamesFor(3, 1, { tournamentName: 'Major Bash' }),
      ...gamesFor(2, 1, { tournamentName: 'Minor Cup' }),
      ...gamesFor(3, 3, { tournamentName: 'Regional Rumble' }),
      ...gamesFor(3, 0, { tournamentName: 'Mystery Meet' }),
    ];

    const stats = buildTierSplitStats({
      entries: [supermajor, major, minor, regional, unknown],
      matches,
      includeSideEvents: false,
    });

    expect(stats.cohorts.a).toHaveLength(7);
    expect(stats.cohorts.b).toHaveLength(5);
    expect(stats.cohorts).toMatchObject({ aEvents: 2, bEvents: 2, estimatedEvents: 3 });
    const cohortIds = new Set([...stats.cohorts.a, ...stats.cohorts.b].map((m) => m.id));
    for (const m of matches.filter((x) => x.tournamentName === 'Mystery Meet')) {
      expect(cohortIds.has(m.id)).toBe(false);
    }
  });

  it('reports coverage with zero values kept', () => {
    const stats = buildTierSplitStats({
      entries: [unknown],
      matches: gamesFor(3, 1, { tournamentName: 'Mystery Meet' }),
      includeSideEvents: false,
    });
    expect(stats.coverage).toEqual({
      total: 1,
      known: 0,
      recorded: 0,
      manual: 0,
      estimated: 0,
      unknown: 1,
      sideExcluded: 0,
    });

    const mixed = buildTierSplitStats({
      entries: [supermajor, minor, unknown, side],
      matches: fixtureMatches(),
      includeSideEvents: false,
    });
    expect(mixed.coverage).toEqual({
      total: 4,
      known: 2,
      recorded: 0,
      manual: 1,
      estimated: 1,
      unknown: 1,
      sideExcluded: 1,
    });
  });

  it('handles an empty input', () => {
    const stats = buildTierSplitStats({ entries: [], matches: [], includeSideEvents: false });
    expect(stats.rows).toEqual([]);
    expect(stats.unknown).toBeNull();
    expect(stats.coverage).toEqual({
      total: 0,
      known: 0,
      recorded: 0,
      manual: 0,
      estimated: 0,
      unknown: 0,
      sideExcluded: 0,
    });
    expect(stats.cohorts).toEqual({ a: [], b: [], aEvents: 0, bEvents: 0, estimatedEvents: 0 });
  });
});
