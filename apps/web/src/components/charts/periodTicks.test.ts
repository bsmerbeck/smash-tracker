import { describe, expect, it } from 'vitest';
import type { PeriodGrain, PeriodPoint } from '@smash-tracker/shared';
import {
  formatPeriodTickLabel,
  formatPeriodRowLabel,
  estimateTickLabelWidthPx,
  layoutPeriodTicks,
  MIN_TICK_LABEL_GAP_PX,
  selectPeriodTickLayout,
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

/** Noon UTC — Nov 15 in every host zone from UTC−11 to UTC+11 (fine grains format in local time, WR-02). */
const NOV_15_2023_MS = Date.UTC(2023, 10, 15, 12, 30, 20);

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

  it('at a narrow plot width, no two kept ticks anchored label spans come within the selection gap of each other', () => {
    // WR-09 (39.1-REVIEW.md): the old body asserted only a count, so it
    // passed for any output — including CR-01's overlaps. It now lays the
    // returned ticks out with the RENDERER's anchor rule and asserts the gap.
    const points = weekPoints(60);
    const ticks = selectPeriodTicks(points, { plotWidthPx: 320, locale: 'en' });
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(points.length);
    expect(smallestRenderedGap(points, ticks, 320, 'en')).toBeGreaterThanOrEqual(
      REQUIRED_TICK_GAP_PX,
    );
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

/**
 * CR-01 (39.1-REVIEW.md): the selector must never return a tick set whose
 * labels overlap once the axis renders them. The oracle below is written
 * INDEPENDENTLY of `periodTicks.ts`'s own layout code, from the renderer's
 * documented anchor rule (`TrendLine.tsx`'s period tick renderer): the
 * first SELECTED tick is start-anchored, the last SELECTED tick is
 * end-anchored, every other tick is centred; x is the point's position on
 * a point scale spanning the plot width; the width is
 * `estimateTickLabelWidthPx` of the rendered label text.
 */
const REQUIRED_TICK_GAP_PX = MIN_TICK_LABEL_GAP_PX;

function renderedSpans(
  points: PeriodPoint[],
  ticks: string[],
  plotWidthPx: number,
  locale: string,
): { key: string; left: number; right: number }[] {
  const n = points.length;
  const indexByKey = new Map(points.map((point, i) => [point.key, i]));
  return ticks.map((key, j) => {
    const i = indexByKey.get(key)!;
    const point = points[i]!;
    const x = n > 1 ? (i * plotWidthPx) / (n - 1) : 0;
    const w = estimateTickLabelWidthPx(formatPeriodTickLabel(point, locale));
    const anchor = j === 0 ? 'start' : j === ticks.length - 1 ? 'end' : 'middle';
    if (anchor === 'start') return { key, left: x, right: x + w };
    if (anchor === 'end') return { key, left: x - w, right: x };
    return { key, left: x - w / 2, right: x + w / 2 };
  });
}

function smallestRenderedGap(
  points: PeriodPoint[],
  ticks: string[],
  plotWidthPx: number,
  locale: string,
): number {
  const spans = renderedSpans(points, ticks, plotWidthPx, locale);
  let smallest = Number.POSITIVE_INFINITY;
  for (let j = 1; j < spans.length; j += 1) {
    smallest = Math.min(smallest, spans[j]!.left - spans[j - 1]!.right);
  }
  return smallest;
}

type SweepGrain =
  | 'game'
  | 'set'
  | 'eventSession:session'
  | 'eventSession:tournament'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year';

const SWEEP_GRAINS: SweepGrain[] = [
  'game',
  'set',
  'eventSession:session',
  'eventSession:tournament',
  'week',
  'month',
  'quarter',
  'year',
];

const TOURNAMENT_NAMES = [
  'Genesis 10 Grand Finals',
  'Locals',
  'Smash Summit 15',
  'The Big House 11',
  'Weekly #212',
  'Collision 2024',
];

/** A realistic, evenly spaced engine series for `grain` — the shape `periodSeries.ts` hands the chart. */
function sweepSeries(grain: SweepGrain, count: number): PeriodPoint[] {
  return Array.from({ length: count }, (_, i) => {
    let startMs: number;
    let key: string;
    let label: string;
    let periodGrain: PeriodGrain;
    switch (grain) {
      case 'game':
      case 'set':
      case 'eventSession:session': {
        startMs = Date.UTC(2023, 10, 1 + i, 12);
        periodGrain = grain === 'eventSession:session' ? 'eventSession' : grain;
        key =
          grain === 'eventSession:session' ? `eventSession:session:${startMs}` : `${grain}:${i}`;
        label = new Date(startMs).toISOString();
        break;
      }
      case 'eventSession:tournament': {
        startMs = Date.UTC(2023, 0, 1 + i * 7, 12);
        periodGrain = 'eventSession';
        label = TOURNAMENT_NAMES[i % TOURNAMENT_NAMES.length]!;
        key = `eventSession:tournament:${label}:${startMs}`;
        break;
      }
      case 'week':
        startMs = Date.UTC(2024, 0, 1 + i * 7);
        periodGrain = 'week';
        key = `week:${i}`;
        label = `2024-W${i}`;
        break;
      case 'month':
        startMs = Date.UTC(2022, i, 1);
        periodGrain = 'month';
        key = `month:${i}`;
        label = `m${i}`;
        break;
      case 'quarter':
        startMs = Date.UTC(2012, i * 3, 1);
        periodGrain = 'quarter';
        key = `quarter:${i}`;
        label = `q${i}`;
        break;
      case 'year':
        startMs = Date.UTC(1990 + i, 0, 1);
        periodGrain = 'year';
        key = `year:${i}`;
        label = String(1990 + i);
        break;
    }
    return makePoint({ grain: periodGrain, key, label, startMs, endMs: startMs + 1 });
  });
}

describe('selectPeriodTicks — rendered labels never overlap (CR-01)', () => {
  it('RED case (review): month grain, n=17, plot 262px — the kept ticks render at least the selection gap apart', () => {
    const points = sweepSeries('month', 17);
    const ticks = selectPeriodTicks(points, { plotWidthPx: 262, locale: 'en' });
    expect(smallestRenderedGap(points, ticks, 262, 'en')).toBeGreaterThanOrEqual(
      REQUIRED_TICK_GAP_PX,
    );
  });

  it('RED case (review): game grain, n=10, plot 829px — the kept ticks render at least the selection gap apart', () => {
    const points = sweepSeries('game', 10);
    const ticks = selectPeriodTicks(points, { plotWidthPx: 829, locale: 'en' });
    expect(smallestRenderedGap(points, ticks, 829, 'en')).toBeGreaterThanOrEqual(
      REQUIRED_TICK_GAP_PX,
    );
  });

  it('property: every grain × n=2..60 × plot widths 240..1400px renders no overlapping pair', () => {
    const failures: string[] = [];
    for (const grain of SWEEP_GRAINS) {
      for (let n = 2; n <= 60; n += 1) {
        const points = sweepSeries(grain, n);
        for (let plotWidthPx = 240; plotWidthPx <= 1400; plotWidthPx += 20) {
          const ticks = selectPeriodTicks(points, { plotWidthPx, locale: 'en' });
          const gap = smallestRenderedGap(points, ticks, plotWidthPx, 'en');
          if (gap < REQUIRED_TICK_GAP_PX) {
            failures.push(`${grain} n=${n} plot=${plotWidthPx} gap=${gap.toFixed(1)}`);
          }
        }
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it('property: the same holds for the wide-glyph (ja) and long-month (de) locales at phone and desktop widths', () => {
    const failures: string[] = [];
    for (const locale of ['ja', 'de']) {
      for (const grain of SWEEP_GRAINS) {
        for (let n = 2; n <= 60; n += 1) {
          const points = sweepSeries(grain, n);
          for (const plotWidthPx of [234, 262, 500, 800, 829, 1200]) {
            const ticks = selectPeriodTicks(points, { plotWidthPx, locale });
            const gap = smallestRenderedGap(points, ticks, plotWidthPx, locale);
            if (gap < REQUIRED_TICK_GAP_PX) {
              failures.push(`${locale} ${grain} n=${n} plot=${plotWidthPx} gap=${gap.toFixed(1)}`);
            }
          }
        }
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });
});

describe('layoutPeriodTicks / selectPeriodTickLayout (CR-01: one anchor rule)', () => {
  it('the selection gap stays at 8px (twice guard:layout MIN_TICK_GAP_PX)', () => {
    expect(MIN_TICK_LABEL_GAP_PX).toBe(8);
  });

  it('agrees with the independent renderer-rule oracle for every multi-tick selection', () => {
    for (const grain of SWEEP_GRAINS) {
      for (const n of [8, 17, 33, 60]) {
        const points = sweepSeries(grain, n);
        for (const plotWidthPx of [262, 829]) {
          const layout = selectPeriodTickLayout(points, { plotWidthPx, locale: 'en' });
          if (layout.length < 2) continue;
          const oracle = renderedSpans(
            points,
            layout.map((tick) => tick.key),
            plotWidthPx,
            'en',
          );
          expect(layout.map(({ key, left, right }) => ({ key, left, right }))).toEqual(oracle);
        }
      }
    }
  });

  it('a lone tick anchors towards its nearer plot edge so it stays inside the plot', () => {
    const points = sweepSeries('game', 12);
    const plotWidthPx = 500;
    const [first] = layoutPeriodTicks(points, [points[0]!.key], { plotWidthPx, locale: 'en' });
    const [last] = layoutPeriodTicks(points, [points[11]!.key], { plotWidthPx, locale: 'en' });
    expect(first!.anchor).toBe('start');
    expect(last!.anchor).toBe('end');
    expect(last!.right).toBe(plotWidthPx);
  });

  it('at a width too narrow for two labels, a fine grain keeps its most recent point and a coarse grain its first', () => {
    const game = sweepSeries('game', 2);
    expect(selectPeriodTicks(game, { plotWidthPx: 60, locale: 'en' })).toEqual([game[1]!.key]);
    const month = sweepSeries('month', 13);
    expect(selectPeriodTicks(month, { plotWidthPx: 60, locale: 'en' })).toEqual([month[0]!.key]);
  });
});
