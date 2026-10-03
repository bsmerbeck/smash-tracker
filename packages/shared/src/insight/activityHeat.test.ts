import { describe, expect, it } from 'vitest';
import { ACTIVITY_HEAT_MAX_YEARS, buildActivityHeat } from './activityHeat.js';
import type { Match } from '../match.js';

let nextId = 0;

function game(year: number, month1to12: number, day = 10, hour = 12): Match {
  nextId += 1;
  return {
    id: `ah-${nextId}`,
    fighter_id: 8,
    opponent_id: 23,
    time: Date.UTC(year, month1to12 - 1, day, hour),
    win: true,
  } as Match;
}

function games(year: number, month: number, count: number): Match[] {
  return Array.from({ length: count }, (_, i) => game(year, month, 1 + i, 3));
}

describe('buildActivityHeat', () => {
  it('returns an empty heat for no games', () => {
    expect(buildActivityHeat([])).toEqual({
      years: [],
      cells: [],
      yearTotals: [],
      maxCellValue: 0,
      shownYears: 0,
      totalYears: 0,
    });
  });

  it('lists years newest first with sparse cells for months that have games only', () => {
    const heat = buildActivityHeat([
      ...games(2019, 3, 2),
      ...games(2026, 3, 5),
      ...games(2026, 11, 1),
      ...games(2024, 7, 4),
    ]);
    expect(heat.years).toEqual([2026, 2024, 2019]);
    expect(heat.cells.map((c) => [c.year, c.month, c.total])).toEqual([
      [2026, 3, 5],
      [2026, 11, 1],
      [2024, 7, 4],
      [2019, 3, 2],
    ]);
    expect(heat.maxCellValue).toBe(5);
    expect(heat.shownYears).toBe(3);
    expect(heat.totalYears).toBe(3);
    expect(heat.yearTotals).toEqual([
      { year: 2026, total: 6 },
      { year: 2024, total: 4 },
      { year: 2019, total: 2 },
    ]);
  });

  it('gives each cell its exact UTC month range, the end inclusive', () => {
    const heat = buildActivityHeat(games(2026, 2, 1));
    const cell = heat.cells[0]!;
    expect(cell.fromMs).toBe(Date.UTC(2026, 1, 1));
    expect(cell.toMs).toBe(Date.UTC(2026, 2, 1) - 1);
    // The last millisecond still belongs to February; the next one is March.
    expect(new Date(cell.toMs).getUTCMonth()).toBe(1);
    expect(new Date(cell.toMs + 1).getUTCMonth()).toBe(2);
  });

  it('buckets months in UTC: a game at 2026-03-01T02:00Z is a March game, 2026-02-28T23:59Z a February game', () => {
    const heat = buildActivityHeat([
      game(2026, 3, 1, 2),
      { ...game(2026, 2, 28, 23), time: Date.UTC(2026, 1, 28, 23, 59) },
    ]);
    expect(heat.cells.map((c) => [c.month, c.total])).toEqual([
      [2, 1],
      [3, 1],
    ]);
  });

  it('caps the rows at 9 years, newest kept, while reporting every year and total', () => {
    const all = Array.from({ length: 10 }, (_, i) => game(2017 + i, 5));
    const heat = buildActivityHeat(all);
    expect(ACTIVITY_HEAT_MAX_YEARS).toBe(9);
    expect(heat.years).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]);
    expect(heat.shownYears).toBe(9);
    expect(heat.totalYears).toBe(10);
    expect(heat.cells).toHaveLength(9);
    expect(heat.cells.every((c) => c.year >= 2018)).toBe(true);
    // The table twin still lists the dropped year.
    expect(heat.yearTotals.map((y) => y.year)).toContain(2017);
  });

  it('honours maxYears and never exceeds 108 cells', () => {
    const dense = Array.from({ length: 12 * 12 }, (_, i) =>
      game(2015 + Math.floor(i / 12), (i % 12) + 1),
    );
    const heat = buildActivityHeat(dense);
    expect(heat.cells.length).toBeLessThanOrEqual(108);
    expect(buildActivityHeat(dense, { maxYears: 2 }).years).toEqual([2026, 2025]);
  });

  it('does not mutate its input and is deterministic', () => {
    const input = [...games(2026, 4, 3), ...games(2025, 1, 2)];
    const copy = JSON.stringify(input);
    const first = buildActivityHeat(input);
    const second = buildActivityHeat(input);
    expect(JSON.stringify(input)).toBe(copy);
    expect(second).toEqual(first);
  });
});
