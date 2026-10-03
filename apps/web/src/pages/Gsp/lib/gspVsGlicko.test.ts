import { describe, expect, it } from 'vitest';
import type { GspPoint } from '@smash-tracker/shared';
import { VALUE_SERIES_GRAIN_LADDER } from '@smash-tracker/shared';
import type { RatingPeriodResult } from '@/lib/glicko';
import { toMmrSeries } from './gspMmrModel';
import {
  GSP_VS_GLICKO_MIN_POINTS,
  buildGspVsGlickoPanels,
  shouldShowGspVsGlicko,
} from './gspVsGlicko';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 0, 6, 18);

function ratingPeriod(overrides: Partial<RatingPeriodResult>): RatingPeriodResult {
  return { start: 0, end: 0, games: 1, rating: 1500, rd: 100, volatility: 0.06, ...overrides };
}

function gspSeriesOf(count: number, stepMs: number): GspPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    time: START_MS + i * stepMs,
    gsp: 9_800_000 + i * 20_000,
    win: i % 4 !== 0,
  }));
}

function periodsOf(count: number, stepMs: number): RatingPeriodResult[] {
  return Array.from({ length: count }, (_, i) =>
    ratingPeriod({
      start: START_MS + i * stepMs,
      end: START_MS + i * stepMs + 2 * 60 * 60 * 1000,
      rating: 1400 + i,
      rd: 80 + (i % 5),
    }),
  );
}

describe('shouldShowGspVsGlicko', () => {
  it('is true only when BOTH series reach the minimum point count', () => {
    expect(GSP_VS_GLICKO_MIN_POINTS).toBe(3);
    expect(shouldShowGspVsGlicko(3, 3)).toBe(true);
    expect(shouldShowGspVsGlicko(40, 300)).toBe(true);
  });

  it('is false when either series is below the minimum', () => {
    expect(shouldShowGspVsGlicko(2, 10)).toBe(false);
    expect(shouldShowGspVsGlicko(10, 2)).toBe(false);
    expect(shouldShowGspVsGlicko(0, 0)).toBe(false);
  });
});

describe('buildGspVsGlickoPanels', () => {
  it('puts both panels at the same (coarser) grain, each within 60 points', () => {
    // 40 readings stay at reading grain on their own; 300 daily closes need a coarser grain.
    const mmr = toMmrSeries(gspSeriesOf(40, DAY_MS * 7));
    const periods = periodsOf(300, DAY_MS);
    const panels = buildGspVsGlickoPanels({ mmr, periods });

    expect(panels.mmr.grain).toBe(panels.glicko.grain);
    expect(panels.grain).toBe(panels.glicko.grain);
    expect(panels.mmr.grain).not.toBe('reading');
    expect(panels.mmr.points.length).toBeLessThanOrEqual(60);
    expect(panels.glicko.points.length).toBeLessThanOrEqual(60);
    expect(panels.mmr.points.length).toBeGreaterThan(0);
  });

  it('keeps reading grain for both panels when both are short', () => {
    const panels = buildGspVsGlickoPanels({
      mmr: toMmrSeries(gspSeriesOf(10, DAY_MS)),
      periods: periodsOf(12, DAY_MS),
    });
    expect(panels.grain).toBe('reading');
    expect(panels.mmr.points).toHaveLength(10);
    expect(panels.glicko.points).toHaveLength(12);
  });

  it('agrees on the coarser grain even when the thinner panel would stay finer', () => {
    const panels = buildGspVsGlickoPanels({
      mmr: toMmrSeries(gspSeriesOf(5, DAY_MS)),
      periods: periodsOf(400, DAY_MS),
    });
    const rank = (g: string) => VALUE_SERIES_GRAIN_LADDER.indexOf(g as never);
    expect(panels.mmr.grain).toBe(panels.glicko.grain);
    expect(rank(panels.grain)).toBeGreaterThan(rank('reading'));
  });

  it('spans xDomain from the earliest to the latest point of either panel', () => {
    const mmr = toMmrSeries(gspSeriesOf(10, DAY_MS)); // days 0..9
    const periods = periodsOf(10, DAY_MS).map((p) => ({
      ...p,
      end: p.end + 20 * DAY_MS, // later than every reading
    }));
    const panels = buildGspVsGlickoPanels({ mmr, periods });
    const xs = [...panels.mmr.points, ...panels.glicko.points].map((p) => p.xMs);
    expect(panels.xDomain[0]).toBe(Math.min(...xs));
    expect(panels.xDomain[1]).toBe(Math.max(...xs));
    expect(panels.xDomain[0]).toBe(mmr[0]!.time);
    expect(panels.xDomain[1]).toBe(periods[9]!.end);
  });

  it('keeps raw values: MMR points equal the MMR closes and Glicko points the period ratings (no rescale)', () => {
    const mmr = toMmrSeries(gspSeriesOf(8, DAY_MS));
    const periods = periodsOf(8, DAY_MS);
    const panels = buildGspVsGlickoPanels({ mmr, periods });
    expect(panels.mmr.points.map((p) => p.value)).toEqual(mmr.map((p) => p.mmr));
    expect(panels.glicko.points.map((p) => p.value)).toEqual(periods.map((p) => p.rating));
    // The two scales differ and neither was squeezed onto 0-100.
    expect(Math.min(...panels.mmr.points.map((p) => p.value))).toBeGreaterThan(100);
    expect(Math.min(...panels.glicko.points.map((p) => p.value))).toBeGreaterThan(100);
  });

  it('stamps a Glicko point at its period end and indexes members into the periods', () => {
    const periods = periodsOf(6, DAY_MS);
    const panels = buildGspVsGlickoPanels({ mmr: toMmrSeries(gspSeriesOf(6, DAY_MS)), periods });
    panels.glicko.points.forEach((point, i) => {
      expect(point.xMs).toBe(periods[i]!.end);
      expect(point.memberIndexes).toEqual([i]);
    });
  });

  it('marks a calibration reading (win: null) as a calibration point at reading grain', () => {
    const series: GspPoint[] = [
      { time: START_MS, gsp: 9_800_000, win: true },
      { time: START_MS + DAY_MS, gsp: 9_900_000, win: null },
      { time: START_MS + 2 * DAY_MS, gsp: 9_950_000, win: false },
    ];
    const panels = buildGspVsGlickoPanels({
      mmr: toMmrSeries(series),
      periods: periodsOf(3, DAY_MS),
    });
    expect(panels.mmr.points.map((p) => p.kind)).toEqual(['reading', 'calibration', 'reading']);
  });

  it('does not throw on empty input', () => {
    const panels = buildGspVsGlickoPanels({ mmr: [], periods: [] });
    expect(panels.mmr.points).toEqual([]);
    expect(panels.glicko.points).toEqual([]);
    expect(panels.xDomain).toEqual([0, 0]);
  });
});
