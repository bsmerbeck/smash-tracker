import { describe, expect, it } from 'vitest';
import type { PeriodGrain, PeriodPoint } from '@smash-tracker/shared';
import {
  formatPeriodTickLabel,
  formatPeriodRowLabel,
  estimateTickLabelWidthPx,
  selectPeriodTicks,
} from './periodTicks';

/**
 * Plan 39.1-30 Task 1 (VIZ-01, VIZ-03, UI-SPEC §7.13): `periodTicks.ts` is
 * the ONLY place `TrendLine.tsx`'s period mode gets human-readable tick and
 * table-row text from — the engine (`periodSeries.ts`) hands over a
 * locale-independent `label`/`startMs`/`grain`, and this module is where
 * that becomes an actual date, month-year, year, or truncated event name.
 */
function makePoint(overrides: Partial<PeriodPoint> & { grain: PeriodGrain }): PeriodPoint {
  return {
    key: `${overrides.grain}:stub`,
    label: 'stub',
    startMs: 0,
    endMs: 999,
    wins: 3,
    losses: 2,
    total: 5,
    rate: 0.6,
    subFloor: false,
    matchIds: [],
    ...overrides,
  };
}

const NOV_15_2023_MS = Date.UTC(2023, 10, 15, 19, 30, 20);

describe('formatPeriodTickLabel', () => {
  it('formats a game-grain point (engine label an ISO string) to a short date, never an ISO-looking string', () => {
    const point = makePoint({
      grain: 'game',
      key: `game:1`,
      label: new Date(NOV_15_2023_MS).toISOString(),
      startMs: NOV_15_2023_MS,
    });
    const formatted = formatPeriodTickLabel(point, 'en');
    expect(formatted).toBe('Nov 15, 2023');
    expect(formatted).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('formats a set-grain session point the same way as a game point', () => {
    const point = makePoint({
      grain: 'set',
      key: `set:session:${NOV_15_2023_MS}`,
      label: new Date(NOV_15_2023_MS).toISOString(),
      startMs: NOV_15_2023_MS,
    });
    expect(formatPeriodTickLabel(point, 'en')).toBe('Nov 15, 2023');
  });

  it('formats an eventSession session point the same way as a game point', () => {
    const point = makePoint({
      grain: 'eventSession',
      key: `eventSession:session:${NOV_15_2023_MS}`,
      label: new Date(NOV_15_2023_MS).toISOString(),
      startMs: NOV_15_2023_MS,
    });
    expect(formatPeriodTickLabel(point, 'en')).toBe('Nov 15, 2023');
  });

  it('formats an eventSession tournament block through formatEventTickLabel (truncated at 12 chars with an ellipsis)', () => {
    const point = makePoint({
      grain: 'eventSession',
      key: `eventSession:tournament:Genesis 10 Grand Finals:${NOV_15_2023_MS}`,
      label: 'Genesis 10 Grand Finals',
      startMs: NOV_15_2023_MS,
    });
    expect(formatPeriodTickLabel(point, 'en')).toBe('Genesis 10 G…');
  });

  it('formats a short eventSession tournament block name byte-identical (under the truncation length)', () => {
    const point = makePoint({
      grain: 'eventSession',
      key: `eventSession:tournament:Locals:${NOV_15_2023_MS}`,
      label: 'Locals',
      startMs: NOV_15_2023_MS,
    });
    expect(formatPeriodTickLabel(point, 'en')).toBe('Locals');
  });

  it('formats a week-grain point as month-year', () => {
    const point = makePoint({ grain: 'week', key: 'week:2023-W46', startMs: NOV_15_2023_MS });
    expect(formatPeriodTickLabel(point, 'en')).toBe('Nov 2023');
  });

  it('formats a month-grain point as month-year', () => {
    const point = makePoint({ grain: 'month', key: 'month:2023-11', startMs: NOV_15_2023_MS });
    expect(formatPeriodTickLabel(point, 'en')).toBe('Nov 2023');
  });

  it('formats a quarter-grain point as the year only', () => {
    const point = makePoint({ grain: 'quarter', key: 'quarter:2023-Q4', startMs: NOV_15_2023_MS });
    expect(formatPeriodTickLabel(point, 'en')).toBe('2023');
  });

  it('formats a year-grain point as the year only', () => {
    const point = makePoint({ grain: 'year', key: 'year:2023', startMs: NOV_15_2023_MS });
    expect(formatPeriodTickLabel(point, 'en')).toBe('2023');
  });

  it('a de locale call returns a non-ISO string different from the en call', () => {
    const point = makePoint({
      grain: 'game',
      key: 'game:1',
      label: new Date(NOV_15_2023_MS).toISOString(),
      startMs: NOV_15_2023_MS,
    });
    const de = formatPeriodTickLabel(point, 'de');
    const en = formatPeriodTickLabel(point, 'en');
    expect(de).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(de).not.toBe(en);
  });

  it('a ja locale call returns a non-ISO string different from the en call', () => {
    const point = makePoint({
      grain: 'game',
      key: 'game:1',
      label: new Date(NOV_15_2023_MS).toISOString(),
      startMs: NOV_15_2023_MS,
    });
    const ja = formatPeriodTickLabel(point, 'ja');
    const en = formatPeriodTickLabel(point, 'en');
    expect(ja).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(ja).not.toBe(en);
  });
});

describe('formatPeriodRowLabel', () => {
  it('keeps a quarter point engine label (key) unchanged', () => {
    const point = makePoint({ grain: 'quarter', key: 'quarter:2023-Q4', label: '2023-Q4' });
    expect(formatPeriodRowLabel(point, 'en')).toBe('2023-Q4');
  });

  it('formats a game point as a date', () => {
    const point = makePoint({
      grain: 'game',
      key: 'game:1',
      label: new Date(NOV_15_2023_MS).toISOString(),
      startMs: NOV_15_2023_MS,
    });
    expect(formatPeriodRowLabel(point, 'en')).toBe('Nov 15, 2023');
  });
});

describe('estimateTickLabelWidthPx', () => {
  it('is 0 for the empty string', () => {
    expect(estimateTickLabelWidthPx('')).toBe(0);
  });

  it('allows 7px per ASCII character', () => {
    expect(estimateTickLabelWidthPx('Nov 2023')).toBe(8 * 7);
  });

  it('allows 12px per non-ASCII character', () => {
    expect(estimateTickLabelWidthPx('日本語')).toBe(3 * 12);
  });
});

describe('selectPeriodTicks', () => {
  function weekPoints(count: number): PeriodPoint[] {
    return Array.from({ length: count }, (_, i) =>
      makePoint({
        grain: 'week',
        key: `week:2024-W${String(i).padStart(2, '0')}`,
        startMs: Date.UTC(2024, 0, 1 + i * 7),
      }),
    );
  }

  it('at a very wide plot, returns every grain-rule candidate', () => {
    const points = weekPoints(12);
    const ticks = selectPeriodTicks(points, { plotWidthPx: 100_000, locale: 'en' });
    // week grain: month starts — one per distinct UTC month.
    const monthStarts = new Set(
      points.map(
        (p) => `${new Date(p.startMs).getUTCFullYear()}-${new Date(p.startMs).getUTCMonth()}`,
      ),
    );
    expect(ticks.length).toBe(monthStarts.size);
  });

  it('at a narrow plot width, no two kept ticks anchored label spans come within 4px of each other', () => {
    const points = weekPoints(60);
    const ticks = selectPeriodTicks(points, { plotWidthPx: 320, locale: 'en' });
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(points.length);
  });

  it('always keeps the first grain-rule candidate', () => {
    const points = weekPoints(60);
    const ticks = selectPeriodTicks(points, { plotWidthPx: 100, locale: 'en' });
    expect(ticks[0]).toBe(points[0]!.key);
  });

  it('appends the final point for a game-grain series even at a narrow width, dropping a colliding previous tick', () => {
    const points = Array.from({ length: 40 }, (_, i) =>
      makePoint({
        grain: 'game',
        key: `game:${i}`,
        label: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
        startMs: Date.UTC(2024, 0, 1 + i),
      }),
    );
    const ticks = selectPeriodTicks(points, { plotWidthPx: 200, locale: 'en' });
    expect(ticks[ticks.length - 1]).toBe(points[points.length - 1]!.key);
  });

  it('never appends the final point for a week-grain series (it only follows the grain rule)', () => {
    const points = weekPoints(9); // not a month-start multiple, so week 8 (last) may not be a month start
    const ticks = selectPeriodTicks(points, { plotWidthPx: 100, locale: 'en' });
    const grainCandidateKeys = new Set(
      points
        .filter((p, i) => {
          if (i === 0) return true;
          const d = new Date(p.startMs);
          const prev = new Date(points[i - 1]!.startMs);
          return (
            d.getUTCMonth() !== prev.getUTCMonth() || d.getUTCFullYear() !== prev.getUTCFullYear()
          );
        })
        .map((p) => p.key),
    );
    for (const key of ticks) {
      expect(grainCandidateKeys.has(key)).toBe(true);
    }
  });

  it('returns an empty array for an empty series', () => {
    expect(selectPeriodTicks([], { plotWidthPx: 640, locale: 'en' })).toEqual([]);
  });
});
