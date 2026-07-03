import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { buildSeries } from './LastMatchesChart';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

// 25 matches, alternating loss/win, chronological.
const matches: Match[] = Array.from({ length: 25 }, (_, i) =>
  makeMatch({ id: `m${i}`, time: i, win: i % 2 === 1 }),
);

describe('buildSeries', () => {
  it('produces one point per match regardless of window', () => {
    expect(buildSeries(matches, 5)).toHaveLength(25);
    expect(buildSeries(matches, 10)).toHaveLength(25);
    expect(buildSeries(matches, 20)).toHaveLength(25);
    expect(buildSeries(matches, 'cumulative')).toHaveLength(25);
  });

  it('windows of 5/10/20 compute a trailing win rate that differs from the cumulative series', () => {
    const window5 = buildSeries(matches, 5);
    const cumulative = buildSeries(matches, 'cumulative');

    // At the last point (index 25), the trailing-5 window only looks at the
    // last 5 matches (indices 20-24: loss,win,loss,win,loss = 2/5 = 40%),
    // while cumulative looks at the full 25-match history (12/25 = 48%).
    expect(window5[24]?.winRate).toBeCloseTo(40, 5);
    expect(cumulative[24]?.winRate).toBeCloseTo(48, 5);
    expect(window5[24]?.winRate).not.toBeCloseTo(cumulative[24]?.winRate ?? -1, 5);
  });

  it('a smaller window reacts faster to a recent streak than a larger window', () => {
    // Force a losing streak at the end (last 6 matches all losses).
    const streaky: Match[] = [
      ...matches.slice(0, 19),
      ...Array.from({ length: 6 }, (_, i) => makeMatch({ id: `l${i}`, time: 100 + i, win: false })),
    ];

    const window5 = buildSeries(streaky, 5);
    const window20 = buildSeries(streaky, 20);

    const last5 = window5[window5.length - 1]?.winRate ?? -1;
    const last20 = window20[window20.length - 1]?.winRate ?? -1;

    // Window-5 sees an all-loss trailing window (0%); window-20 is diluted
    // by the earlier alternating results and stays higher.
    expect(last5).toBe(0);
    expect(last20).toBeGreaterThan(last5);
  });

  it('cumulative falls back to getRunningWinRateSeries semantics (unrounded, all-time)', () => {
    const twoMatches = [
      makeMatch({ id: 'a', time: 1, win: true }),
      makeMatch({ id: 'b', time: 2, win: false }),
    ];
    const series = buildSeries(twoMatches, 'cumulative');
    expect(series[0]?.winRate).toBe(100);
    expect(series[1]?.winRate).toBe(50);
  });

  it('early points in a rolling window use however many matches exist so far', () => {
    const threeMatches = [
      makeMatch({ id: 'a', time: 1, win: true }),
      makeMatch({ id: 'b', time: 2, win: true }),
      makeMatch({ id: 'c', time: 3, win: false }),
    ];
    const series = buildSeries(threeMatches, 10);
    expect(series[0]?.winRate).toBe(100); // 1/1
    expect(series[1]?.winRate).toBe(100); // 2/2
    expect(series[2]?.winRate).toBeCloseTo(66.6667, 3); // 2/3
  });

  it('returns an empty series for no matches', () => {
    expect(buildSeries([], 10)).toEqual([]);
    expect(buildSeries([], 'cumulative')).toEqual([]);
  });
});
