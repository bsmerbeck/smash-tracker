import { describe, expect, it } from 'vitest';
import { playRhythmTemplate } from './playRhythm.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import {
  RHYTHM_BUSIEST_MIN_RATIO,
  RHYTHM_MIN_MONTHS,
  RHYTHM_SEASON_MIN_SPAN_MONTHS,
} from '../policy.js';
import type { Match } from '../../match.js';

const NOW_MS = Date.UTC(2026, 5, 15, 12); // 2026-06-15

let nextId = 0;

/** One game on `day` of the UTC month (`year`, `month1to12`). */
function gameIn(year: number, month1to12: number, day = 10, hour = 12): Match {
  nextId += 1;
  return {
    id: `pr-${nextId}`,
    fighter_id: 8,
    opponent_id: 23,
    time: Date.UTC(year, month1to12 - 1, day, hour),
    win: nextId % 2 === 0,
  } as Match;
}

/** One game on the 10th of every month in the inclusive (year, month) range. */
function monthlyGames(from: [number, number], to: [number, number]): Match[] {
  const games: Match[] = [];
  let [year, month] = from;
  while (year < to[0] || (year === to[0] && month <= to[1])) {
    games.push(gameIn(year, month));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return games;
}

function extraGames(year: number, month: number, count: number): Match[] {
  // Days 11-25 and hours 1+ keep every extra inside the month.
  return Array.from({ length: count }, (_, i) =>
    gameIn(year, month, 11 + (i % 15), 1 + Math.floor(i / 15)),
  );
}

function build(matches: Match[], nowMs = NOW_MS) {
  const result = playRhythmTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('playRhythmTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const found = COHORT_TEMPLATES.filter((t) => t.id === 'playRhythm');
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(playRhythmTemplate);
  });

  it('declares a direction-free, window-expressible account FACT template', () => {
    expect(playRhythmTemplate.scopeKind).toBe('account');
    expect(playRhythmTemplate.assertsDirection).toBe(false);
    expect(playRhythmTemplate.windowExpressible).toBe(true);
  });

  it('keeps the DD-41-07 policy constants', () => {
    expect(RHYTHM_MIN_MONTHS).toBe(12);
    expect(RHYTHM_SEASON_MIN_SPAN_MONTHS).toBe(24);
    expect(RHYTHM_BUSIEST_MIN_RATIO).toBe(1.5);
  });

  it('returns nothing for 0 matches', () => {
    expect(build([])).toBeNull();
  });

  it('is locked below 12 distinct months, with a meter and no doors', () => {
    const insight = build(monthlyGames([2025, 8], [2026, 6])); // 11 months
    expect(insight).not.toBeNull();
    expect(insight!.state).toBe('locked');
    expect(insight!.copy.key).toBe('insights.playRhythm.locked');
    expect(insight!.copy.values).toEqual({ count: 1, have: 11, need: 12 });
    expect(insight!.doors).toEqual([]);
    expect(insight!.countedMatchIds).toHaveLength(11);
    expect(insight!.window.games).toBe(11);
  });

  it('counts distinct months, not games: many games in 11 months stays locked', () => {
    const games = [...monthlyGames([2025, 8], [2026, 6]), ...extraGames(2026, 6, 40)];
    expect(build(games)!.state).toBe('locked');
  });

  it('is a fact at exactly 12 distinct months', () => {
    const insight = build(monthlyGames([2025, 7], [2026, 6]));
    expect(insight!.state).toBe('fact');
  });

  describe('30 months of games with a March peak', () => {
    const games = [
      ...monthlyGames([2024, 1], [2026, 6]),
      ...extraGames(2024, 3, 5),
      ...extraGames(2025, 3, 5),
      ...extraGames(2026, 3, 5),
    ];
    const insight = build(games)!;

    it('is fact.compare with the busiest month and its share', () => {
      expect(insight.state).toBe('fact');
      expect(insight.kind).toBe('fact');
      expect(insight.copy.key).toBe('insights.playRhythm.fact.compare');
      expect(insight.copy.values.month).toBe(3);
      expect(insight.copy.values.share).toBeCloseTo(18 / 45, 10);
      expect(insight.copy.values.monthsPlayed).toBe(30);
      expect(insight.copy.values.monthsSpan).toBe(30);
    });

    it('compares the last 12 months with the 12 before', () => {
      // Whole UTC months: NOW is 2026-06-15, so recent = Jul 2025 .. Jun 2026, prior = Jul 2024 .. Jun 2025.
      const recentStart = Date.UTC(2025, 6, 1);
      const priorStart = Date.UTC(2024, 6, 1);
      const expectedRecent = games.filter((m) => m.time >= recentStart && m.time <= NOW_MS);
      const expectedPrior = games.filter((m) => m.time >= priorStart && m.time < recentStart);
      expect(insight.copy.values.recent).toBe(expectedRecent.length);
      expect(insight.copy.values.prior).toBe(expectedPrior.length);
      expect(expectedPrior.length).toBeGreaterThan(0);
    });

    it('counts exactly the last-12-month games, newest first, with their real first/last times', () => {
      const recentStart = Date.UTC(2025, 6, 1);
      const expected = games.filter((m) => m.time >= recentStart && m.time <= NOW_MS);
      expect(new Set(insight.countedMatchIds)).toEqual(new Set(expected.map((m) => m.id)));
      expect(insight.countedMatchIds).toHaveLength(expected.length);
      expect(insight.window.games).toBe(expected.length);
      expect(insight.window.fromMs).toBe(Math.min(...expected.map((m) => m.time)));
      expect(insight.window.toMs).toBe(Math.max(...expected.map((m) => m.time)));
      const times = insight.countedMatchIds.map((id) => games.find((m) => m.id === id)!.time);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('builds the id from the scope key and horizon and never asserts a direction', () => {
      expect(insight.id).toBe('playRhythm:account:last30');
      expect(insight.deltaPoints).toBeNull();
      expect(insight.copy.key).not.toMatch(/\.(up|down)$/);
      expect(insight.doors).toEqual([]);
    });

    it('holds only numbers in copy.values (the host formats month and share)', () => {
      for (const value of Object.values(insight.copy.values)) {
        expect(typeof value).toBe('number');
      }
    });
  });

  describe('the busiest-month clause gates', () => {
    it('no month at 1.5x the mean share -> fact.compareNoSeason', () => {
      const insight = build(monthlyGames([2024, 1], [2026, 6]))!;
      expect(insight.copy.key).toBe('insights.playRhythm.fact.compareNoSeason');
      expect(insight.copy.values.month).toBeUndefined();
      expect(insight.copy.values.share).toBeUndefined();
    });

    it('a peak one game below the ratio stays noSeason; one game above states it', () => {
      // 24 months, 2 games per calendar month; March gains extra games.
      const base = monthlyGames([2024, 1], [2025, 12]);
      const now = Date.UTC(2025, 11, 20);
      // 3 / 25 = 12.0% < 12.5% (1.5 x 1/12)
      expect(build([...base, ...extraGames(2024, 3, 1)], now)!.copy.key).toBe(
        'insights.playRhythm.fact.compareNoSeason',
      );
      // 4 / 26 = 15.4% >= 12.5%
      expect(build([...base, ...extraGames(2024, 3, 2)], now)!.copy.key).toBe(
        'insights.playRhythm.fact.compare',
      );
    });

    it('a 14-month span never states a busiest month, however peaked', () => {
      const games = [...monthlyGames([2025, 5], [2026, 6]), ...extraGames(2025, 9, 30)];
      const insight = build(games)!;
      expect(insight.copy.values.monthsSpan).toBe(14);
      expect(insight.copy.key).toBe('insights.playRhythm.fact.compareNoSeason');
    });

    it('a 24-month span is the first that may state one', () => {
      const games = [...monthlyGames([2024, 7], [2026, 6]), ...extraGames(2025, 9, 30)];
      const insight = build(games)!;
      expect(insight.copy.values.monthsSpan).toBe(24);
      expect(insight.copy.key).toBe('insights.playRhythm.fact.compare');
      expect(insight.copy.values.month).toBe(9);
    });

    it('a 23-month span is not enough', () => {
      const games = [...monthlyGames([2024, 8], [2026, 6]), ...extraGames(2025, 9, 30)];
      const insight = build(games)!;
      expect(insight.copy.values.monthsSpan).toBe(23);
      expect(insight.copy.key).toBe('insights.playRhythm.fact.compareNoSeason');
    });

    it('ties go to the month whose latest occurrence is the most recent', () => {
      // Two years, 2 games per calendar month; March and October each gain 3 (5 of 30 each).
      const base = monthlyGames([2024, 1], [2025, 12]);
      const games = [...base, ...extraGames(2025, 3, 3), ...extraGames(2025, 10, 3)];
      const insight = build(games, Date.UTC(2025, 11, 20))!;
      expect(insight.copy.key).toBe('insights.playRhythm.fact.compare');
      expect(insight.copy.values.month).toBe(10);
    });
  });

  describe('an empty prior window', () => {
    it('is fact.recentOnly with the months played inside the recent window', () => {
      // 12 old months (outside both windows) + 3 recent months.
      const games = [...monthlyGames([2020, 1], [2020, 12]), ...monthlyGames([2026, 3], [2026, 5])];
      const insight = build(games)!;
      expect(insight.state).toBe('fact');
      expect(insight.copy.key).toBe('insights.playRhythm.fact.recentOnly');
      expect(insight.copy.values.prior).toBe(0);
      expect(insight.copy.values.recent).toBe(3);
      expect(insight.copy.values.recentMonths).toBe(3);
      expect(insight.copy.values.monthsPlayed).toBe(15);
    });

    it('a recent window with no games states the zero and counts no games', () => {
      const insight = build(monthlyGames([2020, 1], [2020, 12]))!;
      expect(insight.copy.key).toBe('insights.playRhythm.fact.recentOnly');
      expect(insight.copy.values.recent).toBe(0);
      expect(insight.countedMatchIds).toEqual([]);
      expect(insight.window.games).toBe(0);
      expect(insight.window.fromMs).toBeNull();
    });
  });

  // 41-REVIEW WR-02: the windows are whole UTC calendar months (the 12 ending with the current month,
  // and the 12 before), so "the last 12 months" is literally true and `recentMonths` never exceeds 12.
  describe('whole-month windows (WR-02)', () => {
    const MID_MARCH_MS = Date.UTC(2026, 2, 15, 12);
    // A game each month Mar 2025 .. Mar 2026 (13 months touched by a rolling 365 days) + 12 old months.
    const games = [
      ...monthlyGames([2020, 1], [2020, 12]),
      gameIn(2025, 3, 20),
      ...monthlyGames([2025, 4], [2026, 3]),
    ];

    it('the recent window is the 12 calendar months ending with the current one, never 13', () => {
      const insight = build(games, MID_MARCH_MS)!;
      expect(insight.state).toBe('fact');
      // Apr 2025 .. Mar 2026: 12 games. The 2025-03-20 game is in the prior 12 months, not the recent.
      expect(insight.copy.values.recent).toBe(12);
      expect(insight.copy.values.prior).toBe(1);
      expect(insight.window.games).toBe(12);
      expect(insight.window.fromMs).toBe(Date.UTC(2025, 3, 10, 12));
    });

    it('recentMonths never states more than 12 months, whatever the day of the month', () => {
      for (const day of [10, 14, 28, 31]) {
        const nowMs = Date.UTC(2026, 2, day, 12);
        const dense = [
          ...monthlyGames([2020, 1], [2020, 12]),
          ...monthlyGames([2025, 3], [2026, 3]),
        ];
        const insight = build(dense, nowMs)!;
        const months = insight.copy.values.recentMonths;
        if (months !== undefined) expect(months).toBeLessThanOrEqual(12);
        expect(insight.copy.values.recent).toBe(12);
      }
    });

    it('the prior window is the 12 calendar months before the recent one', () => {
      const insight = build(
        [...monthlyGames([2024, 7], [2025, 6]), ...monthlyGames([2025, 7], [2026, 6])],
        NOW_MS,
      )!;
      // NOW = 2026-06-15: recent = Jul 2025 .. Jun 2026, prior = Jul 2024 .. Jun 2025.
      expect(insight.copy.values.recent).toBe(12);
      expect(insight.copy.values.prior).toBe(12);
    });
  });

  it('buckets months in UTC: a game at 2026-03-01T02:00Z is a March game', () => {
    const games = [
      ...monthlyGames([2025, 7], [2026, 2]),
      gameIn(2026, 3, 1, 2),
      ...monthlyGames([2026, 4], [2026, 6]),
    ];
    const insight = build(games)!;
    // Jul 2025 .. Jun 2026 inclusive, one game each: all 12 months present only if the
    // 2026-03-01T02:00Z game lands in March.
    expect(insight.state).toBe('fact');
    expect(insight.copy.values.monthsPlayed).toBe(12);
  });
});
