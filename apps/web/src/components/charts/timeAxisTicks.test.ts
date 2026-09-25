import { describe, expect, it } from 'vitest';
import { estimateTickLabelWidthPx, MIN_TICK_LABEL_GAP_PX } from './periodTicks';
import { selectTimeAxisTicks, TIME_AXIS_LABEL_OFFSET_PX } from './timeAxisTicks';

/**
 * Plan 39.1-34 (UI-SPEC §12.1 "x ticks = years", sketch 002-C `drawRating`):
 * the career timeline's pure time-axis tick selection — UTC calendar
 * gridlines (years, or months on a short account), local-midnight day ticks
 * (WR-02), labels thinned with `periodTicks`' own width estimate. The web
 * suite runs in UTC (vitest.config.ts); the Los Angeles file pins the other
 * zone.
 */
const CAREER_START = Date.UTC(2018, 11, 18, 18);
const CAREER_END = Date.UTC(2026, 7, 7, 12);
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

function xOf(ms: number, startMs: number, endMs: number, plotWidthPx: number): number {
  return ((ms - startMs) / (endMs - startMs)) * plotWidthPx;
}

describe('selectTimeAxisTicks (plan 39.1-34)', () => {
  it('a 7.6-year career at 1000px: a gridline on every UTC Jan 1 (2019..2026), every year labelled, anchored start', () => {
    const ticks = selectTimeAxisTicks({
      startMs: CAREER_START,
      endMs: CAREER_END,
      plotWidthPx: 1000,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual(YEARS.map((y) => Date.UTC(y, 0, 1)));
    expect(ticks.labels.map((l) => l.text)).toEqual(YEARS.map(String));
    expect(ticks.labels.every((l) => l.anchor === 'start')).toBe(true);
    expect(ticks.labels.map((l) => l.ms)).toEqual(ticks.gridlines);
  });

  it('the same career at a 248px plot keeps all 8 gridlines but thins the labels to every 2nd year, never colliding', () => {
    const plotWidthPx = 248;
    const ticks = selectTimeAxisTicks({
      startMs: CAREER_START,
      endMs: CAREER_END,
      plotWidthPx,
      locale: 'en',
    });
    expect(ticks.gridlines).toHaveLength(8);
    expect(ticks.labels.map((l) => l.text)).toEqual(['2019', '2021', '2023', '2025']);
    for (let i = 1; i < ticks.labels.length; i++) {
      const previous = ticks.labels[i - 1]!;
      const current = ticks.labels[i]!;
      const previousRight =
        xOf(previous.ms, CAREER_START, CAREER_END, plotWidthPx) +
        TIME_AXIS_LABEL_OFFSET_PX +
        estimateTickLabelWidthPx(previous.text);
      const currentLeft =
        xOf(current.ms, CAREER_START, CAREER_END, plotWidthPx) + TIME_AXIS_LABEL_OFFSET_PX;
      expect(currentLeft - previousRight).toBeGreaterThanOrEqual(MIN_TICK_LABEL_GAP_PX);
    }
  });

  it('a 75-day span switches to UTC month starts, labelled with the short month', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2026, 6, 3),
      endMs: Date.UTC(2026, 8, 16),
      plotWidthPx: 600,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual([Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)]);
    expect(ticks.labels.map((l) => l.text)).toEqual(['Aug', 'Sep']);
  });

  it('in month mode, a span crossing Jan 1 labels that January with its year', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2025, 10, 10),
      endMs: Date.UTC(2026, 2, 20),
      plotWidthPx: 800,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual([
      Date.UTC(2025, 11, 1),
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 1, 1),
      Date.UTC(2026, 2, 1),
    ]);
    expect(ticks.labels.map((l) => l.text)).toEqual(['Dec', 'Jan 2026', 'Feb', 'Mar']);
  });

  it('plan 39.1-35 fidelity: a 59-day thin account (sketch 002-C casual) ticks month starts, never a gridline per day', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2026, 6, 3, 19),
      endMs: Date.UTC(2026, 7, 31, 20),
      plotWidthPx: 996,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual([Date.UTC(2026, 7, 1)]);
    expect(ticks.labels.map((l) => l.text)).toEqual(['Aug']);
  });

  it('plan 39.1-35 fidelity: in day mode every gridline carries a label — a 20-day span at 300px draws no unlabelled daily rules', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2026, 2, 2, 12),
      endMs: Date.UTC(2026, 2, 22, 12),
      plotWidthPx: 300,
      locale: 'en',
    });
    expect(ticks.labels.length).toBeGreaterThan(1);
    expect(ticks.gridlines).toEqual(ticks.labels.map((l) => l.ms));
  });

  it('a 4-day span uses day ticks at midnight, labelled with a short date', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2026, 2, 3, 12),
      endMs: Date.UTC(2026, 2, 7, 6),
      plotWidthPx: 600,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual([
      Date.UTC(2026, 2, 4),
      Date.UTC(2026, 2, 5),
      Date.UTC(2026, 2, 6),
      Date.UTC(2026, 2, 7),
    ]);
    expect(ticks.labels.map((l) => l.text)).toEqual(['Mar 4', 'Mar 5', 'Mar 6', 'Mar 7']);
  });

  it("formats years with the locale's own formatter (ja) — never a hand-built suffix", () => {
    const ticks = selectTimeAxisTicks({
      startMs: CAREER_START,
      endMs: CAREER_END,
      plotWidthPx: 1400,
      locale: 'ja',
    });
    const jaYear = new Intl.DateTimeFormat('ja', { year: 'numeric', timeZone: 'UTC' });
    expect(ticks.labels.map((l) => l.text)).toEqual(
      YEARS.map((y) => jaYear.format(new Date(Date.UTC(y, 0, 1)))),
    );
  });
});
