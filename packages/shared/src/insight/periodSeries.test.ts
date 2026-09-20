import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/syntheticMatches.js';
import { MARK_BOUND_LINE_POINTS } from './markBounds.js';
import { buildPeriodSeries } from './periodSeries.js';

/** Minimal, deterministic `Match` builder — only the fields a given test cares about are overridden. */
function makeMatch(id: string, time: number, overrides: Partial<Match> = {}): Match {
  return {
    id,
    fighter_id: 8,
    opponent_id: 23,
    time,
    win: true,
    ...overrides,
  };
}

/**
 * `quarterCount` quarters of 2021 (5th quarter spills into 2022), 3 distinct
 * months and 2 games per month within each quarter — engineered so `game`,
 * `set`/`eventSession` (whether Task 1's placeholder or Task 2's real
 * session grouping) and `week`/`month` grains ALL produce more than the
 * small target this fixture is tested against, while `quarter` (and, once a
 * 5th quarter spills into a new year, `year`) do not.
 */
function buildQuarterBoundaryFixture(quarterCount: 4 | 5): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  for (let q = 0; q < quarterCount; q++) {
    const year = 2021 + Math.floor(q / 4);
    const quarterInYear = q % 4;
    for (let m = 0; m < 3; m++) {
      const month = quarterInYear * 3 + m;
      for (let g = 0; g < 2; g++) {
        const ms = Date.UTC(year, month, 5, g);
        matches.push(makeMatch(`qb-${counter}`, ms, { win: counter % 2 === 0 }));
        counter++;
      }
    }
  }
  return matches;
}

/**
 * Three quarters of 2021: the first and third comfortably clear
 * `ABSTENTION_FLOOR_GAMES`, the middle one (Q2) totals 2 games — sub-floor.
 * Each quarter spreads its games across 3 distinct months so `week`/`month`
 * grain both produce more points than this fixture's target, forcing the
 * ladder down to `quarter`.
 */
function buildSubFloorQuarterFixture(): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  const push = (month: number, count: number): void => {
    for (let i = 0; i < count; i++) {
      const ms = Date.UTC(2021, month, 5, i);
      matches.push(makeMatch(`sf-${counter}`, ms, { win: counter % 2 === 0 }));
      counter++;
    }
  };
  push(0, 4);
  push(1, 4);
  push(2, 4); // Q1 2021: 12 games
  push(3, 1);
  push(4, 1); // Q2 2021: 2 games — sub-floor
  push(6, 4);
  push(7, 4);
  push(8, 4); // Q3 2021: 12 games
  return matches;
}

describe('buildPeriodSeries (VIZ-01) — the grain ladder', () => {
  it('bounds the 8k-game fixture at or under the default line-point cap, with a named grain', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const series = buildPeriodSeries({ matches });
    expect(series.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
    expect(series.grain.length).toBeGreaterThan(0);
    expect(series.points.every((point) => point.total >= 1)).toBe(true);
  });

  it('bounds the 50k-game fixture at or under the default line-point cap', () => {
    const matches = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS);
    const series = buildPeriodSeries({ matches });
    expect(series.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
    expect(series.points.every((point) => point.total >= 1)).toBe(true);
  });

  it('returns an empty series with a named grain and no synthetic period over zero matches, and never throws', () => {
    const series = buildPeriodSeries({ matches: [] });
    expect(series.points).toEqual([]);
    expect(series.grain.length).toBeGreaterThan(0);
    expect(series.totalGames).toBe(0);
    expect(series.boundReached).toBe(true);
  });

  it('selects the grain whose count is exactly the target, and moves one step coarser once one more period appears', () => {
    const atBoundary = buildPeriodSeries({ matches: buildQuarterBoundaryFixture(4), target: 4 });
    expect(atBoundary.grain).toBe('quarter');
    expect(atBoundary.points).toHaveLength(4);

    const overBoundary = buildPeriodSeries({ matches: buildQuarterBoundaryFixture(5), target: 4 });
    expect(overBoundary.grain).toBe('year');
    expect(overBoundary.points).toHaveLength(2);
  });

  it('flags a sub-floor period with its real counts, without dropping it, while adjacent periods at/above the floor stay unflagged', () => {
    const series = buildPeriodSeries({ matches: buildSubFloorQuarterFixture(), target: 5 });
    expect(series.grain).toBe('quarter');
    expect(series.points).toHaveLength(3);
    const [q1, q2, q3] = series.points;
    expect(q1.total).toBe(12);
    expect(q1.subFloor).toBe(false);
    expect(q2.total).toBe(2);
    expect(q2.subFloor).toBe(true);
    expect(q3.total).toBe(12);
    expect(q3.subFloor).toBe(false);
  });

  it('sorts points oldest first by startMs, breaking a tie by ascending key', () => {
    const tiedMs = Date.UTC(2022, 5, 1, 12);
    const matches = [
      makeMatch('zulu', tiedMs, { win: true }),
      makeMatch('alpha', tiedMs, { win: false }),
    ];
    const series = buildPeriodSeries({ matches, target: 60 });
    expect(series.grain).toBe('game');
    expect(series.points.map((point) => point.key)).toEqual(['game:alpha', 'game:zulu']);
  });
});
