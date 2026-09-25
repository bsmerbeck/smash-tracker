import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  buildCareerTimeline,
  type CareerTimeline as CareerTimelineData,
} from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { ChartCard } from './ChartCard';
import { CareerTimeline, type CareerTimelineLabels } from './CareerTimeline';
import { selectTimeAxisTicks } from './timeAxisTicks';
import { CHART_AXIS_FONT_SIZE } from './tokens';

/**
 * Plan 39.1-34 (UI-SPEC §12.1, the kit's frame rule): the shared-time-axis
 * career timeline rendered inside its `ChartCard` frame, with an explicit
 * `width` (Recharts renders 0x0 under jsdom's ResponsiveContainer — D-04).
 * The fixture is guard:layout's sparg0-shaped `career` scale (same seed and
 * options): quarter rating grain, ~93 month cells.
 */
const MATCHES = generateSyntheticMatches({
  seed: 39_134_001,
  count: 8_400,
  startMs: Date.UTC(2018, 11, 18, 18),
  sessionSizeRange: [6, 28],
  sessionGapMs: 135 * 60 * 60 * 1000,
  winRate: 0.73,
  mainFighterIds: [8, 22],
  opponentFighterIds: [1, 10],
  stageIds: [1],
});
const TIMELINE: CareerTimelineData = buildCareerTimeline({
  matches: MATCHES,
  horizon: 'last30',
  nowMs: Date.UTC(2026, 8, 17),
});

const LABELS: CareerTimelineLabels = {
  rate: 'rate',
  games: 'games',
  aria: 'Career timeline — rating 1813 ±91 across 32 periods',
  value: (rating) => String(rating),
  rd: (rd) => `±${rd}`,
  peakClose: (rating) => `${rating} · peak close`,
  lowClose: (rating) => `${rating} · low close`,
  peak: (rating) => `${rating} · peak`,
  low: (rating) => `${rating} · low`,
  band: '30 games',
};

function renderTimeline(width: number, timeline: CareerTimelineData = TIMELINE) {
  return render(
    <ChartCard title="Career timeline" density="compact">
      <CareerTimeline timeline={timeline} labels={LABELS} width={width} />
    </ChartCard>,
  );
}

/** A thin account: ~60 games in sessions two days apart inside one month -> session grain, no strips. */
const THIN_TIMELINE: CareerTimelineData = buildCareerTimeline({
  matches: generateSyntheticMatches({
    seed: 39_134_002,
    count: 60,
    startMs: Date.UTC(2026, 5, 1, 18),
    sessionSizeRange: [4, 8],
    sessionGapMs: 2 * 24 * 60 * 60 * 1000,
    winRate: 0.6,
  }),
  horizon: 'last30',
  nowMs: Date.UTC(2026, 6, 1),
});

function directLabelTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="career-timeline-direct-label"]')).map(
    (el) => el.textContent ?? '',
  );
}

function numberAttr(el: Element, name: string): number {
  return Number(el.getAttribute(name));
}

/** The anchors' own linear time mapping, fitted from their SVG `cx` attributes. */
function anchorMapping(container: HTMLElement): (t: number) => number {
  const anchors = Array.from(container.querySelectorAll('[data-slot="career-timeline-point"]'));
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  const t0 = numberAttr(first, 'data-t');
  const t1 = numberAttr(last, 'data-t');
  const x0 = numberAttr(first, 'cx');
  const x1 = numberAttr(last, 'cx');
  return (t: number) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
}

describe('CareerTimeline (plan 39.1-34) — the shared-time-axis kit chart', () => {
  it('renders inside its ChartCard frame: one full timeline, one plot area, one anchor per rating point, no canvas', () => {
    const { container } = renderTimeline(1000);
    expect(screen.getByText('Career timeline')).toBeInTheDocument();
    const roots = container.querySelectorAll('[data-slot="career-timeline"]');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.getAttribute('data-state')).toBe('full');
    expect(container.querySelectorAll('[data-slot="career-timeline-plot-area"]')).toHaveLength(1);
    const points = container.querySelectorAll('[data-slot="career-timeline-point"]');
    expect(points).toHaveLength(TIMELINE.rating.points.length);
    for (const point of points) {
      expect(Number.isFinite(numberAttr(point, 'data-t'))).toBe(true);
    }
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('wide (1000px): month strips, one rate and one games cell per engine cell, each carrying its period and step', () => {
    const { container } = renderTimeline(1000);
    const strips = container.querySelector('[data-slot="career-timeline-strips"]');
    expect(strips?.getAttribute('data-grain')).toBe('month');
    const rateCells = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]');
    const gamesCells = container.querySelectorAll('[data-slot="career-timeline-games-cell"]');
    expect(rateCells).toHaveLength(TIMELINE.strips!.wide.cells.length);
    expect(gamesCells).toHaveLength(TIMELINE.strips!.wide.cells.length);
    for (const cell of [...rateCells, ...gamesCells]) {
      for (const attr of [
        'data-start-ms',
        'data-end-ms',
        'data-wins',
        'data-losses',
        'data-step',
      ]) {
        expect(cell.hasAttribute(attr), attr).toBe(true);
      }
    }
    expect(screen.getByText('rate')).toBeInTheDocument();
    expect(screen.getByText('games')).toBeInTheDocument();
  });

  it('narrow (400px): the strips re-grain to the engine’s quarter cells', () => {
    const { container } = renderTimeline(400);
    const strips = container.querySelector('[data-slot="career-timeline-strips"]');
    expect(strips?.getAttribute('data-grain')).toBe('quarter');
    expect(container.querySelectorAll('[data-slot="career-timeline-rate-cell"]')).toHaveLength(
      TIMELINE.strips!.narrow.cells.length,
    );
  });

  it("every rate cell's x sits on the rating anchors' own linear time mapping (0.5px inset, clipped to the plot)", () => {
    const { container } = renderTimeline(1000);
    const x = anchorMapping(container);
    const plot = container.querySelector('[data-slot="career-timeline-plot-area"]')!;
    const plotLeft = numberAttr(plot, 'x');
    const cells = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const expected = Math.max(plotLeft, x(numberAttr(cell, 'data-start-ms'))) + 0.5;
      expect(Math.abs(numberAttr(cell, 'x') - expected)).toBeLessThanOrEqual(0.5);
    }
  });

  it('draws exactly three visible dots on the quarter line — last, peak and low', () => {
    const { container } = renderTimeline(1000);
    const { lastIndex, peakIndex, lowIndex } = TIMELINE.rating;
    expect([lastIndex, peakIndex, lowIndex].every((i) => i !== null)).toBe(true);
    expect(container.querySelectorAll('[data-slot="career-timeline-dot"]')).toHaveLength(3);
  });

  it('direct-labels last (value and ±RD), peak close and low close at 1000px', () => {
    const { container } = renderTimeline(1000);
    const points = TIMELINE.rating.points;
    const last = points[TIMELINE.rating.lastIndex!]!;
    const peak = points[TIMELINE.rating.peakIndex!]!;
    const low = points[TIMELINE.rating.lowIndex!]!;
    expect(directLabelTexts(container).sort()).toEqual(
      [
        LABELS.value(last.rating),
        LABELS.rd(last.rd),
        LABELS.peakClose(peak.rating),
        LABELS.lowClose(low.rating),
      ].sort(),
    );
  });

  it('drops the ±RD sublabel on a narrow (400px) plot', () => {
    const { container } = renderTimeline(400);
    const last = TIMELINE.rating.points[TIMELINE.rating.lastIndex!]!;
    const texts = directLabelTexts(container);
    expect(texts).toContain(LABELS.value(last.rating));
    expect(texts).not.toContain(LABELS.rd(last.rd));
  });

  it('labels the fitted y-domain: 100-point ticks wide, 200-point ticks narrow', () => {
    const lo =
      Math.floor(Math.min(...TIMELINE.rating.points.map((p) => p.rating - p.rd)) / 100) * 100;
    const hi =
      Math.ceil(Math.max(...TIMELINE.rating.points.map((p) => p.rating + p.rd)) / 100) * 100;
    const yTicks = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll('[data-slot="career-timeline-tick-label"][data-axis="y"]'),
      ).map((el) => el.textContent);
    const wide = renderTimeline(1000);
    const expectedWide: string[] = [];
    for (let v = lo; v <= hi; v += hi - lo > 600 ? 200 : 100) expectedWide.push(String(v));
    expect(yTicks(wide.container)).toEqual(expectedWide);
    wide.unmount();
    const narrow = renderTimeline(400);
    const expectedNarrow: string[] = [];
    for (let v = lo; v <= hi; v += 200) expectedNarrow.push(String(v));
    expect(yTicks(narrow.container)).toEqual(expectedNarrow);
  });

  it("draws the tick module's year gridlines from the plot top through the strips' bottom", () => {
    const { container } = renderTimeline(1000);
    const plot = container.querySelector('[data-slot="career-timeline-plot-area"]')!;
    const plotTop = numberAttr(plot, 'y');
    const plotBottom = plotTop + numberAttr(plot, 'height');
    const ticks = selectTimeAxisTicks({
      startMs: TIMELINE.domain!.startMs,
      endMs: TIMELINE.domain!.endMs,
      plotWidthPx: numberAttr(plot, 'width'),
      locale: 'en',
    });
    const gridlines = container.querySelectorAll('[data-slot="career-timeline-gridline"]');
    expect(gridlines).toHaveLength(ticks.gridlines.length);
    for (const line of gridlines) {
      expect(numberAttr(line, 'y1')).toBe(plotTop);
      expect(numberAttr(line, 'y2')).toBe(plotBottom + 48);
    }
    const xLabels = Array.from(
      container.querySelectorAll('[data-slot="career-timeline-tick-label"][data-axis="x"]'),
    ).map((el) => el.textContent);
    expect(xLabels).toEqual(ticks.labels.map((l) => l.text));
  });

  it('shades the recent window (at least 6px wide) and labels it with the horizon; no band without a window', () => {
    const { container, unmount } = renderTimeline(1000);
    const band = container.querySelector('[data-slot="career-timeline-recent-band"]');
    expect(band).not.toBeNull();
    const rect = band!.querySelector('rect')!;
    expect(numberAttr(rect, 'width')).toBeGreaterThanOrEqual(6);
    expect(band!.textContent).toBe(LABELS.band);
    unmount();
    const without = renderTimeline(1000, { ...TIMELINE, recentWindow: null });
    expect(without.container.querySelector('[data-slot="career-timeline-recent-band"]')).toBeNull();
  });

  it('plots 200px tall at 1000px and 150px at 400px (sketch 002-C: plot bottom 220 / 170 under a 20px top margin)', () => {
    const wide = renderTimeline(1000);
    expect(
      numberAttr(
        wide.container.querySelector('[data-slot="career-timeline-plot-area"]')!,
        'height',
      ),
    ).toBe(200);
    wide.unmount();
    const narrow = renderTimeline(400);
    expect(
      numberAttr(
        narrow.container.querySelector('[data-slot="career-timeline-plot-area"]')!,
        'height',
      ),
    ).toBe(150);
  });

  it('a thin (session-grain) timeline dots every point and labels peak / low without "close"', () => {
    expect(THIN_TIMELINE.state).toBe('thin');
    expect(THIN_TIMELINE.rating.grain).toBe('session');
    const { container } = renderTimeline(1000, THIN_TIMELINE);
    expect(container.querySelectorAll('[data-slot="career-timeline-dot"]')).toHaveLength(
      THIN_TIMELINE.rating.points.length,
    );
    expect(container.querySelector('[data-slot="career-timeline-strips"]')).toBeNull();
    const texts = directLabelTexts(container);
    const { peakIndex, lowIndex, points } = THIN_TIMELINE.rating;
    if (peakIndex !== null) expect(texts).toContain(LABELS.peak(points[peakIndex]!.rating));
    if (lowIndex !== null) expect(texts).toContain(LABELS.low(points[lowIndex]!.rating));
    expect(texts.some((text) => text.includes('close'))).toBe(false);
  });

  it('every SVG text uses the kit axis font size', () => {
    const { container } = renderTimeline(1000);
    const texts = container.querySelectorAll('svg text');
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.getAttribute('font-size')).toBe(String(CHART_AXIS_FONT_SIZE));
    }
  });
});
