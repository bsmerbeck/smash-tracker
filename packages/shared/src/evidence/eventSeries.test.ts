import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import * as eventSeriesModule from './eventSeries.js';
import {
  buildOpponentEventSeries,
  buildPlayerEventSeries,
  buildStageEventSeries,
} from './eventSeries.js';
import { ABSTENTION_FLOOR_GAMES } from './policy.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: 'tagone',
    ...overrides,
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('buildOpponentEventSeries', () => {
  it('interleaves a session anchor between two tournament anchors on one chronological axis', () => {
    const tournamentA: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 'a2', time: 2_000, win: false, eventName: 'Tourney A' }),
    ];
    const session: Match[] = [makeMatch({ id: 's1', time: 10_000_000, win: true })];
    const tournamentB: Match[] = [
      makeMatch({ id: 'b1', time: 50_000_000, win: true, eventName: 'Tourney B' }),
      makeMatch({ id: 'b2', time: 50_001_000, win: false, eventName: 'Tourney B' }),
    ];
    const series = buildOpponentEventSeries({
      matches: [...tournamentA, ...session, ...tournamentB],
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1,
    });
    expect(series.map((a) => a.kind)).toEqual(['tournament', 'session', 'tournament']);
    expect(series.map((a) => a.startMs)).toEqual([1_000, 10_000_000, 50_000_000]);
  });

  it('two anchors from the same event name a long time apart get different keys', () => {
    const matches: Match[] = [
      makeMatch({ id: 'x1', time: 1_000, win: true, eventName: 'Tourney X' }),
      makeMatch({ id: 'x2', time: 1_000 + 400 * DAY_MS, win: true, eventName: 'Tourney X' }),
    ];
    const series = buildOpponentEventSeries({
      matches,
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1,
    });
    expect(series).toHaveLength(2);
    expect(series[0]!.key).not.toBe(series[1]!.key);
  });

  it('calling the builder twice on the identical input returns identical key arrays', () => {
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 's1', time: 10_000_000, win: true }),
    ];
    const input = { matches, aliasMap: {}, opponentTag: 'tagone', refreshedAt: 1 };
    const first = buildOpponentEventSeries(input);
    const second = buildOpponentEventSeries(input);
    expect(first.map((a) => a.key)).toEqual(second.map((a) => a.key));
  });

  it('an anchor below the abstention floor is present with a null confidence tier', () => {
    const matches: Match[] = [makeMatch({ id: 's1', time: 1_000, win: true })];
    const series = buildOpponentEventSeries({
      matches,
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1,
    });
    expect(series).toHaveLength(1);
    expect(series[0]!.total).toBeLessThan(ABSTENTION_FLOOR_GAMES);
    expect(series[0]!.confidenceTier).toBeNull();
  });

  it('a zero-match input returns an empty array; a single-match input returns exactly one anchor', () => {
    const empty = buildOpponentEventSeries({
      matches: [],
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1,
    });
    expect(empty).toEqual([]);

    const single = buildOpponentEventSeries({
      matches: [makeMatch({ id: 's1', time: 1_000, win: true })],
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1,
    });
    expect(single).toHaveLength(1);
  });

  it('cumulative win rate steps at each anchor plus that anchor own W-L, 0-100 domain', () => {
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 'a2', time: 2_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 'a3', time: 3_000, win: false, eventName: 'Tourney A' }),
      makeMatch({ id: 's1', time: 10_000_000, win: false }),
    ];
    const series = buildOpponentEventSeries({
      matches,
      aliasMap: {},
      opponentTag: 'tagone',
      refreshedAt: 1,
    });
    expect(series).toHaveLength(2);
    expect(series[0]!.cumulativeWins).toBe(2);
    expect(series[0]!.cumulativeLosses).toBe(1);
    expect(series[0]!.cumulativeWinRate).toBe(67);
    expect(series[1]!.cumulativeWins).toBe(2);
    expect(series[1]!.cumulativeLosses).toBe(2);
    expect(series[1]!.cumulativeWinRate).toBe(50);
  });
});

describe('buildStageEventSeries', () => {
  it('produces the same anchor shape as the opponent-scoped entry point, scoped by stage instead of identity', () => {
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, map: { id: 5, name: 'Battlefield' } }),
      makeMatch({ id: 'a2', time: 2_000, win: false, map: { id: 5, name: 'Battlefield' } }),
      makeMatch({ id: 'a3', time: 3_000, win: true, map: { id: 6, name: 'Final Destination' } }),
    ];
    const series = buildStageEventSeries({ matches, stageId: 5, refreshedAt: 1 });
    expect(series).toHaveLength(1);
    expect(series[0]!.total).toBe(2);
    expect(series[0]!.matchIds.sort()).toEqual(['a1', 'a2']);
  });

  it('a stage id with no matches returns an empty anchor array', () => {
    const series = buildStageEventSeries({ matches: [], stageId: 5, refreshedAt: 1 });
    expect(series).toEqual([]);
  });
});

describe('buildPlayerEventSeries (plan 41-12)', () => {
  it('over games that all face one opponent it deep-equals the opponent entry point (anchoring parity)', () => {
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 'a2', time: 2_000, win: false, eventName: 'Tourney A' }),
      makeMatch({ id: 's1', time: 10_000_000, win: true }),
      makeMatch({ id: 'b1', time: 50_000_000, win: true, eventName: 'Tourney B' }),
    ];
    expect(buildPlayerEventSeries({ matches, refreshedAt: 1 })).toEqual(
      buildOpponentEventSeries({ matches, aliasMap: {}, opponentTag: 'tagone', refreshedAt: 1 }),
    );
  });

  it('two opponents inside one same-named event share ONE tournament anchor holding both games', () => {
    const matches: Match[] = [
      makeMatch({
        id: 'x1',
        time: 1_000,
        win: true,
        eventName: 'Ultimate Singles',
        opponent: 'ann',
      }),
      makeMatch({
        id: 'x2',
        time: 2_000 + DAY_MS,
        win: false,
        eventName: 'Ultimate Singles',
        opponent: 'bob',
      }),
    ];
    const series = buildPlayerEventSeries({ matches, refreshedAt: 1 });
    expect(series).toHaveLength(1);
    expect(series[0]!.kind).toBe('tournament');
    expect([...series[0]!.matchIds].sort()).toEqual(['x1', 'x2']);
  });

  it('a game with no event name becomes a session anchor interleaved by time; cumulative values run across anchors', () => {
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 's1', time: 10_000_000, win: false }),
      makeMatch({ id: 'b1', time: 50_000_000, win: true, eventName: 'Tourney B' }),
    ];
    const series = buildPlayerEventSeries({ matches, refreshedAt: 1 });
    expect(series.map((a) => a.kind)).toEqual(['tournament', 'session', 'tournament']);
    expect(series.map((a) => a.cumulativeWins)).toEqual([1, 1, 2]);
    expect(series.map((a) => a.cumulativeLosses)).toEqual([0, 1, 1]);
  });

  it('an empty input yields an empty series, and two calls on one input are deep-equal', () => {
    expect(buildPlayerEventSeries({ matches: [], refreshedAt: 0 })).toEqual([]);
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: 1_000, win: true, eventName: 'Tourney A' }),
      makeMatch({ id: 's1', time: 10_000_000, win: false }),
    ];
    expect(buildPlayerEventSeries({ matches, refreshedAt: 1 })).toEqual(
      buildPlayerEventSeries({ matches, refreshedAt: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Plan 39.1-39 (VIZ-01, UI-SPEC section 11 "line points at most 60"): the ONE
// event-anchor derivation also bins a long series for DISPLAY. Read through
// the module namespace so a RED run fails on an assertion, not an import.
// ---------------------------------------------------------------------------

type BinFn = (
  series: ReturnType<typeof buildStageEventSeries>,
  options?: { maxPoints?: number },
) => Array<{
  key: string;
  kind: string;
  grain?: string;
  label: string;
  startMs: number;
  endMs: number;
  wins: number;
  losses: number;
  total: number;
  cumulativeWins: number;
  cumulativeLosses: number;
  cumulativeWinRate: number;
  confidenceTier: string | null;
  matchIds: string[];
}>;

function binFn(): BinFn {
  const fn = (eventSeriesModule as Record<string, unknown>).binEventSeries;
  expect(typeof fn, 'binEventSeries is exported').toBe('function');
  return fn as BinFn;
}

/** `count` one-game sessions, one a day from 2026-01-05 (a Monday) 18:00 UTC, alternating results. */
function dailySessions(count: number, startMs = Date.UTC(2026, 0, 5, 18)): Match[] {
  return Array.from({ length: count }, (_, i) =>
    makeMatch({
      id: `d${String(i).padStart(3, '0')}`,
      time: startMs + i * DAY_MS,
      win: i % 3 !== 0,
      map: { id: 1, name: 'Battlefield' },
    }),
  );
}

function stageSeries(matches: Match[]) {
  return buildStageEventSeries({ matches, stageId: 1, refreshedAt: 1 });
}

describe('binEventSeries (plan 39.1-39)', () => {
  it('bound: a 150-anchor series spanning ~5 months becomes at most 60 bins at the finest fitting grain (week)', () => {
    const series = stageSeries(dailySessions(150));
    expect(series).toHaveLength(150);
    const bins = binFn()(series);
    expect(bins.length).toBeLessThanOrEqual(60);
    expect(bins.length).toBeGreaterThan(1);
    expect(new Set(bins.map((b) => b.kind))).toEqual(new Set(['bin']));
    expect(new Set(bins.map((b) => b.grain))).toEqual(new Set(['week']));
    // 150 days from a Monday: 21 full weeks + 3 days -> 22 weekly bins.
    expect(bins).toHaveLength(22);
  });

  it('picks a coarser grain only when the finer one exceeds the bound (450 daily anchors = 65 weeks -> month)', () => {
    const bins = binFn()(stageSeries(dailySessions(450)));
    expect(bins.length).toBeLessThanOrEqual(60);
    expect(new Set(bins.map((b) => b.grain))).toEqual(new Set(['month']));
  });

  it('identity: a series of 60 or fewer anchors is returned as the SAME array reference', () => {
    const series = stageSeries(dailySessions(60));
    expect(binFn()(series)).toBe(series);
    const small = stageSeries(dailySessions(3));
    expect(binFn()(small)).toBe(small);
  });

  it('partition: the bins partition the input matchIds (union equal, no duplicate, none dropped)', () => {
    const series = stageSeries(dailySessions(150));
    const bins = binFn()(series);
    const inputIds = series.flatMap((a) => a.matchIds);
    const binIds = bins.flatMap((b) => b.matchIds);
    expect(binIds).toHaveLength(inputIds.length);
    expect(new Set(binIds).size).toBe(binIds.length);
    expect([...binIds].sort()).toEqual([...inputIds].sort());
  });

  it("cumulative at bin end: each bin's record is the sum of its members and its cumulative values equal its LAST member's", () => {
    const series = stageSeries(dailySessions(150));
    const bins = binFn()(series);
    for (const bin of bins) {
      const members = series.filter((a) => a.matchIds.some((id) => bin.matchIds.includes(id)));
      expect(bin.wins).toBe(members.reduce((sum, a) => sum + a.wins, 0));
      expect(bin.losses).toBe(members.reduce((sum, a) => sum + a.losses, 0));
      expect(bin.total).toBe(members.reduce((sum, a) => sum + a.total, 0));
      const last = members[members.length - 1]!;
      expect(bin.cumulativeWins).toBe(last.cumulativeWins);
      expect(bin.cumulativeLosses).toBe(last.cumulativeLosses);
      expect(bin.cumulativeWinRate).toBe(last.cumulativeWinRate);
      expect(bin.startMs).toBe(members[0]!.startMs);
      expect(bin.endMs).toBe(last.endMs);
    }
    expect(bins[bins.length - 1]!.cumulativeWinRate).toBe(
      series[series.length - 1]!.cumulativeWinRate,
    );
  });

  it('stable keys: bin:<grain>:<bucketStartMs>, identical across calls', () => {
    const matches = dailySessions(150);
    const a = binFn()(stageSeries(matches));
    const b = binFn()(stageSeries([...matches].reverse()));
    expect(a.map((bin) => bin.key)).toEqual(b.map((bin) => bin.key));
    expect(a[0]!.key).toBe(`bin:week:${Date.UTC(2026, 0, 5)}`);
    for (const bin of a) expect(bin.key).toMatch(/^bin:week:\d+$/);
  });

  it('confidenceTier follows the bin total (a 7-game bin is tiered, never null)', () => {
    const bins = binFn()(stageSeries(dailySessions(150)));
    const full = bins.find((b) => b.total === 7)!;
    expect(full).toBeDefined();
    expect(full.confidenceTier).not.toBeNull();
  });

  it('empty series -> empty', () => {
    expect(binFn()([])).toEqual([]);
  });

  it("resolveEventBin: a bin key resolves to exactly that bucket's members at any grain; a non-bin or unknown key is null", () => {
    const resolve = (eventSeriesModule as Record<string, unknown>).resolveEventBin as (
      series: ReturnType<typeof buildStageEventSeries>,
      key: string,
    ) => { matchIds: string[]; total: number } | null;
    expect(typeof resolve).toBe('function');
    const series = stageSeries(dailySessions(150));
    const bins = binFn()(series);
    const resolved = resolve(series, bins[2]!.key)!;
    expect([...resolved.matchIds].sort()).toEqual([...bins[2]!.matchIds].sort());
    expect(resolved.total).toBe(bins[2]!.total);
    // A month key resolves too, even though this series bins weekly.
    const january = resolve(series, `bin:month:${Date.UTC(2026, 0, 1)}`)!;
    expect(january.matchIds).toHaveLength(27); // Jan 5 .. Jan 31
    expect(resolve(series, series[0]!.key)).toBeNull();
    expect(resolve(series, `bin:month:${Date.UTC(2030, 0, 1)}`)).toBeNull();
  });
});
