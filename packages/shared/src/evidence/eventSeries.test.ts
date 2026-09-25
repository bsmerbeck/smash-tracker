import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { buildOpponentEventSeries, buildStageEventSeries } from './eventSeries.js';
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
