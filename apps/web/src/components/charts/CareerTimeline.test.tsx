import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  buildCareerTimeline,
  type CareerTimeline as CareerTimelineData,
} from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { ChartCard } from './ChartCard';
import {
  CareerTimeline,
  type CareerTimelineEventMarker,
  type CareerTimelineLabels,
  type CareerTimelineMonthRecord,
  type CareerTimelineReadout,
  type CareerTimelineReadoutTarget,
} from './CareerTimeline';
import { selectTimeAxisTicks } from './timeAxisTicks';
import { CHART_AXIS_FONT_SIZE, CHART_TOKENS } from './tokens';

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
  readout: readoutFor,
  eventAria: (marker) => `event ${marker.label}, rating after ${marker.ratingAfter}`,
  table: {
    toggle: 'View as table',
    ratingCaption: 'Rating at each close',
    monthCaption: 'Win rate and games by month',
    headers: {
      period: 'Period',
      rating: 'Rating',
      rd: '±RD',
      record: 'W–L',
      rate: 'Rate',
      games: 'Games',
      year: 'Year',
      total: 'Year total',
    },
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    period: (point) => `period ${point.key}`,
    rd: (rd) => `±${rd}`,
    record: (wins, losses) => `${wins}–${losses}`,
    rate: (rate) => `${Math.round(rate * 100)}%`,
    monthCell: ({ rate, total }) => `${Math.round(rate * 100)}% · ${total}`,
    yearTotal: ({ wins, losses, rate }) => `${wins}–${losses} · ${Math.round(rate * 100)}%`,
  },
};

/** A deterministic readout per target — the kit composes nothing itself, so the test labels do. */
function readoutFor(target: CareerTimelineReadoutTarget): CareerTimelineReadout {
  if (target.kind === 'point') {
    return {
      title: `point ${target.point.key}`,
      lines: [`rating ${target.point.rating}`, `${target.point.wins}-${target.point.losses}`],
    };
  }
  if (target.kind === 'cell') {
    return {
      title: `cell ${target.cell.key}`,
      lines: [`${target.cell.wins}-${target.cell.losses}`, `n ${target.cell.total}`],
    };
  }
  return {
    title: `event ${target.marker.label}`,
    lines: [`after ${target.marker.ratingAfter}`, `${target.marker.wins}-${target.marker.losses}`],
  };
}

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

  it('plan 39.1-53 (UAT 39.1-35b): a career starting mid-2020 names 2020 as its first x label, with no gridline at the origin', () => {
    const midYear = buildCareerTimeline({
      matches: generateSyntheticMatches({
        seed: 39_153_001,
        count: 2_000,
        startMs: Date.UTC(2020, 5, 14, 18),
        sessionSizeRange: [4, 6],
        sessionGapMs: 135 * 60 * 60 * 1000,
        winRate: 0.6,
        mainFighterIds: [8],
        opponentFighterIds: [1, 10],
        stageIds: [1],
      }),
      horizon: 'last30',
      nowMs: Date.UTC(2026, 8, 17),
    });
    expect(new Date(midYear.domain!.startMs).getUTCFullYear()).toBe(2020);
    const { container } = renderTimeline(1000, midYear);
    const xLabels = Array.from(
      container.querySelectorAll('[data-slot="career-timeline-tick-label"][data-axis="x"]'),
    ).map((el) => el.textContent);
    expect(xLabels[0]).toBe('2020');
    expect(container.querySelectorAll('[data-slot="career-timeline-gridline"]')).toHaveLength(
      new Date(midYear.domain!.endMs).getUTCFullYear() - 2020,
    );
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

  it("does not clip text drawn in the chart's margins (sketch 002-C: the plot svg overflows visibly)", () => {
    const { container } = renderTimeline(400);
    const root = container.querySelector('[data-slot="career-timeline"]')!;
    expect(root.className).toContain('[&_.recharts-surface]:overflow-visible');
    expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
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

/**
 * Plan 39.1-35 Task 1 (UI-SPEC §10.1 / §12.1, sketch 002-C `locate()` /
 * `show()` / `onkeydown`): ONE synced crosshair, ONE readout, keyboard
 * stepping with a polite live mirror, click / Enter / two-tap drill. Under
 * jsdom the SVG's bounding rect is all zeros, so a pointer's clientX / clientY
 * are the SVG's own x / y — events aim at the anchors' `cx` and the cells' `x`.
 */
describe('CareerTimeline (plan 39.1-35) — crosshair, readout, keyboard and drill', () => {
  function renderInteractive(
    width: number,
    options: { onSelectPeriod?: boolean; timeline?: CareerTimelineData } = {},
  ) {
    const onSelectPeriod = vi.fn();
    const utils = render(
      <CareerTimeline
        timeline={options.timeline ?? TIMELINE}
        labels={LABELS}
        width={width}
        {...(options.onSelectPeriod === false ? {} : { onSelectPeriod })}
      />,
    );
    return { ...utils, onSelectPeriod };
  }

  function plotBox(container: HTMLElement) {
    const plot = container.querySelector('[data-slot="career-timeline-plot-area"]')!;
    const top = numberAttr(plot, 'y');
    return { top, bottom: top + numberAttr(plot, 'height') };
  }

  function hitTarget(container: HTMLElement): Element {
    const hit = container.querySelector('[data-slot="career-timeline-hit"]');
    expect(hit, 'the transparent career-timeline-hit rect').not.toBeNull();
    return hit!;
  }

  function anchorAt(container: HTMLElement, index: number) {
    const anchor = container.querySelectorAll('[data-slot="career-timeline-point"]')[index]!;
    return { x: numberAttr(anchor, 'cx'), y: numberAttr(anchor, 'cy') };
  }

  function readoutOf(container: HTMLElement): CareerTimelineReadout | null {
    const el = container.querySelector('[data-slot="career-timeline-readout"]');
    if (!el) return null;
    return {
      title: el.querySelector('[data-slot="career-timeline-readout-title"]')?.textContent ?? '',
      lines: Array.from(el.querySelectorAll('[data-slot="career-timeline-readout-line"]')).map(
        (line) => line.textContent ?? '',
      ),
    };
  }

  function liveText(container: HTMLElement): string | null {
    const live = container.querySelector('[data-slot="career-timeline-live"]');
    expect(live, 'the polite live mirror').not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('polite');
    return live!.textContent;
  }

  function cellCentre(cell: Element) {
    return numberAttr(cell, 'x') + numberAttr(cell, 'width') / 2;
  }

  function cellOf(el: Element) {
    const start = numberAttr(el, 'data-start-ms');
    return TIMELINE.strips!.wide.cells.find((cell) => cell.startMs === start)!;
  }

  const points = TIMELINE.rating.points;

  it('pointer over the plot band snaps to that anchor: crosshair from the plot top to the strip bottom, a dot on the point, one readout', () => {
    const { container } = renderInteractive(1000);
    const { top, bottom } = plotBox(container);
    const at = anchorAt(container, 10);
    fireEvent.pointerMove(hitTarget(container), {
      clientX: at.x,
      clientY: top + 40,
      pointerType: 'mouse',
    });
    const crosshair = container.querySelector('[data-slot="career-timeline-crosshair"]');
    expect(crosshair).not.toBeNull();
    expect(numberAttr(crosshair!, 'x1')).toBeCloseTo(at.x, 3);
    expect(numberAttr(crosshair!, 'x2')).toBeCloseTo(at.x, 3);
    expect(numberAttr(crosshair!, 'y1')).toBe(top);
    expect(numberAttr(crosshair!, 'y2')).toBe(bottom + 48);
    const dot = container.querySelector('[data-slot="career-timeline-crosshair-dot"]');
    expect(dot).not.toBeNull();
    expect(numberAttr(dot!, 'cx')).toBeCloseTo(at.x, 3);
    expect(numberAttr(dot!, 'cy')).toBeCloseTo(at.y, 3);
    expect(container.querySelectorAll('[data-slot="career-timeline-readout"]')).toHaveLength(1);
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[10]! }));
  });

  it('a pointer between two anchors selects the nearer one', () => {
    const { container } = renderInteractive(1000);
    const { top } = plotBox(container);
    const a = anchorAt(container, 12);
    const b = anchorAt(container, 13);
    const hit = hitTarget(container);
    fireEvent.pointerMove(hit, { clientX: a.x + (b.x - a.x) * 0.4, clientY: top + 20 });
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[12]! }));
    fireEvent.pointerMove(hit, { clientX: a.x + (b.x - a.x) * 0.6, clientY: top + 20 });
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[13]! }));
  });

  it('pointer over a rate cell inside the strip band: crosshair at the cell centre and the cell readout; pointerleave removes both', () => {
    const { container } = renderInteractive(1000);
    const { top, bottom } = plotBox(container);
    const cellEl = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]')[40]!;
    const hit = hitTarget(container);
    fireEvent.pointerMove(hit, {
      clientX: cellCentre(cellEl),
      clientY: numberAttr(cellEl, 'y') + 7,
    });
    const crosshair = container.querySelector('[data-slot="career-timeline-crosshair"]');
    expect(crosshair).not.toBeNull();
    expect(numberAttr(crosshair!, 'x1')).toBeCloseTo(cellCentre(cellEl), 3);
    expect(numberAttr(crosshair!, 'y1')).toBe(top);
    expect(numberAttr(crosshair!, 'y2')).toBe(bottom + 48);
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'cell', cell: cellOf(cellEl) }));
    fireEvent.pointerLeave(hit);
    expect(container.querySelector('[data-slot="career-timeline-crosshair"]')).toBeNull();
    expect(container.querySelector('[data-slot="career-timeline-readout"]')).toBeNull();
  });

  it('the plot is one tab stop (role img + summary label); Arrow / Home / End step the periods, Escape hides, Enter drills the active period', () => {
    const { container, onSelectPeriod } = renderInteractive(1000);
    const plot = container.querySelector('[data-slot="career-timeline-plot"]');
    expect(plot).not.toBeNull();
    expect(plot!.getAttribute('tabindex')).toBe('0');
    expect(plot!.getAttribute('role')).toBe('img');
    expect(plot!.getAttribute('aria-label')).toBe(LABELS.aria);
    const last = points.length - 1;
    fireEvent.keyDown(plot!, { key: 'ArrowLeft' });
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[last]! }));
    fireEvent.keyDown(plot!, { key: 'ArrowLeft' });
    expect(readoutOf(container)).toEqual(
      LABELS.readout({ kind: 'point', point: points[last - 1]! }),
    );
    fireEvent.keyDown(plot!, { key: 'Home' });
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[0]! }));
    fireEvent.keyDown(plot!, { key: 'ArrowRight' });
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[1]! }));
    fireEvent.keyDown(plot!, { key: 'End' });
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[last]! }));
    fireEvent.keyDown(plot!, { key: 'Enter' });
    expect(onSelectPeriod).toHaveBeenCalledTimes(1);
    expect(onSelectPeriod).toHaveBeenCalledWith({
      fromMs: points[last]!.startMs,
      toMs: points[last]!.endMs - 1,
    });
    fireEvent.keyDown(plot!, { key: 'Escape' });
    expect(readoutOf(container)).toBeNull();
    expect(container.querySelector('[data-slot="career-timeline-crosshair"]')).toBeNull();
  });

  it('a keyboard step is mirrored into the polite live region; a pointer hover never announces', () => {
    const { container } = renderInteractive(1000);
    const plot = container.querySelector('[data-slot="career-timeline-plot"]')!;
    expect(plot).not.toBeNull();
    fireEvent.keyDown(plot, { key: 'End' });
    const readout = container.querySelector('[data-slot="career-timeline-readout"]')!;
    expect(readout).not.toBeNull();
    expect(liveText(container)).toBe(readout.textContent);
    expect(liveText(container)).not.toBe('');
    fireEvent.keyDown(plot, { key: 'Escape' });
    const { top } = plotBox(container);
    fireEvent.pointerMove(hitTarget(container), {
      clientX: anchorAt(container, 5).x,
      clientY: top + 30,
    });
    expect(readoutOf(container)).not.toBeNull();
    expect(liveText(container)).toBe('');
  });

  it('a click on the plot band drills the nearest period; a click on a cell drills that cell', () => {
    const { container, onSelectPeriod } = renderInteractive(1000);
    const { top } = plotBox(container);
    const hit = hitTarget(container);
    fireEvent.click(hit, { clientX: anchorAt(container, 7).x + 1, clientY: top + 30 });
    expect(onSelectPeriod).toHaveBeenCalledTimes(1);
    expect(onSelectPeriod).toHaveBeenLastCalledWith({
      fromMs: points[7]!.startMs,
      toMs: points[7]!.endMs - 1,
    });
    const cellEl = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]')[20]!;
    fireEvent.click(hit, { clientX: cellCentre(cellEl), clientY: numberAttr(cellEl, 'y') + 5 });
    const cell = cellOf(cellEl);
    expect(onSelectPeriod).toHaveBeenCalledTimes(2);
    expect(onSelectPeriod).toHaveBeenLastCalledWith({ fromMs: cell.startMs, toMs: cell.endMs - 1 });
  });

  it('touch: the first tap shows the readout without drilling; a second tap on the same target drills once', () => {
    const { container, onSelectPeriod } = renderInteractive(400);
    const { top } = plotBox(container);
    const hit = hitTarget(container);
    const at = { clientX: anchorAt(container, 3).x, clientY: top + 30 };
    fireEvent.pointerDown(hit, { ...at, pointerType: 'touch' });
    fireEvent.click(hit, at);
    expect(onSelectPeriod).not.toHaveBeenCalled();
    expect(readoutOf(container)).toEqual(LABELS.readout({ kind: 'point', point: points[3]! }));
    // A touch pointerleave follows every lifted finger — it must not hide the readout.
    fireEvent.pointerLeave(hit, { pointerType: 'touch' });
    expect(readoutOf(container)).not.toBeNull();
    fireEvent.pointerDown(hit, { ...at, pointerType: 'touch' });
    fireEvent.click(hit, at);
    expect(onSelectPeriod).toHaveBeenCalledTimes(1);
    expect(onSelectPeriod).toHaveBeenCalledWith({
      fromMs: points[3]!.startMs,
      toMs: points[3]!.endMs - 1,
    });
  });

  it('without an onSelectPeriod prop a click does nothing and throws nothing', () => {
    const { container } = renderInteractive(1000, { onSelectPeriod: false });
    const { top } = plotBox(container);
    const hit = hitTarget(container);
    expect(() =>
      fireEvent.click(hit, { clientX: anchorAt(container, 2).x, clientY: top + 30 }),
    ).not.toThrow();
    const plot = container.querySelector('[data-slot="career-timeline-plot"]')!;
    fireEvent.keyDown(plot, { key: 'End' });
    expect(() => fireEvent.keyDown(plot, { key: 'Enter' })).not.toThrow();
  });

  it('without strips (a thin timeline) the crosshair ends at the plot bottom', () => {
    const { container } = renderInteractive(1000, { timeline: THIN_TIMELINE });
    const { top, bottom } = plotBox(container);
    fireEvent.pointerMove(hitTarget(container), {
      clientX: anchorAt(container, 2).x,
      clientY: top + 30,
    });
    const crosshair = container.querySelector('[data-slot="career-timeline-crosshair"]');
    expect(crosshair).not.toBeNull();
    expect(numberAttr(crosshair!, 'y2')).toBe(bottom);
  });
});

/**
 * Plan 39.1-35 Task 2 (D-07, UI-SPEC §12.1 / §14.4 / §14.6, sketch 002-C 640 /
 * 662-665 / 855-856): the thin account's slot, the locked inset, the table
 * twin and the event-diamond layer (built to contract; Trends passes no
 * markers until Phase 39.2 — the owner's 2026-09-25 decision).
 */
describe('CareerTimeline (plan 39.1-35) — thin slot, locked inset, table twin, event layer', () => {
  /** Month records from the engine's own month cells (the host bins them with the same calendar rule). */
  const MONTH_RECORDS: CareerTimelineMonthRecord[] = TIMELINE.strips!.wide.cells.map((cell) => {
    const d = new Date(cell.startMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      wins: cell.wins,
      losses: cell.losses,
      total: cell.total,
    };
  });

  const LOCKED_LABELS: CareerTimelineLabels = {
    ...LABELS,
    locked: 'Career timeline — 2 more games unlock this chart',
    lockedCount: '3 of 5 games',
  };

  const locked = (count: number) =>
    buildCareerTimeline({
      matches: MATCHES.slice(0, count),
      horizon: 'last30',
      nowMs: Date.UTC(2026, 8, 17),
    });

  it('thin: the thinStrip slot renders under the plot inside the root; a full timeline never renders it', () => {
    const probe = <div data-slot="thin-probe">per-game strip</div>;
    const thin = render(
      <CareerTimeline timeline={THIN_TIMELINE} labels={LABELS} width={1000} thinStrip={probe} />,
    );
    const root = thin.container.querySelector('[data-slot="career-timeline"]')!;
    expect(root.getAttribute('data-state')).toBe('thin');
    expect(root.querySelector('[data-slot="career-timeline-strips"]')).toBeNull();
    expect(root.querySelectorAll('[data-slot="career-timeline-dot"]')).toHaveLength(
      THIN_TIMELINE.rating.points.length,
    );
    const slot = root.querySelector('[data-slot="career-timeline-thin-strip"]');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('[data-slot="thin-probe"]')).not.toBeNull();
    thin.unmount();
    const full = render(
      <CareerTimeline timeline={TIMELINE} labels={LABELS} width={1000} thinStrip={probe} />,
    );
    expect(full.container.querySelector('[data-slot="career-timeline-thin-strip"]')).toBeNull();
  });

  it('locked (3 games): an inset with the sentence and a 3-of-5 meter — no svg, never an empty frame', () => {
    const timeline = locked(3);
    expect(timeline.state).toBe('locked');
    const { container } = render(
      <CareerTimeline timeline={timeline} labels={LOCKED_LABELS} width={1000} />,
    );
    const inset = container.querySelector('[data-slot="career-timeline-locked"]');
    expect(inset).not.toBeNull();
    expect(inset!.textContent).toContain('Career timeline — 2 more games unlock this chart');
    const meter = within(inset as HTMLElement).getByRole('img');
    expect(meter.getAttribute('aria-label')).toBe('3 of 5 games');
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('60%');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-slot="career-timeline-table-toggle"]')).toBeNull();
  });

  it('locked (0 games): the meter is empty and the inset still renders', () => {
    const timeline = locked(0);
    const { container } = render(
      <CareerTimeline
        timeline={timeline}
        labels={{ ...LOCKED_LABELS, locked: '5 more games', lockedCount: '0 of 5 games' }}
        width={1000}
      />,
    );
    const inset = container.querySelector('[data-slot="career-timeline-locked"]');
    expect(inset?.textContent).toContain('5 more games');
    const meter = within(inset as HTMLElement).getByRole('img');
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('0%');
  });

  it('table twin: closed by default; opens a captioned rating-close table with scoped headers and one row per close', () => {
    const { container } = render(
      <CareerTimeline
        timeline={TIMELINE}
        labels={LABELS}
        width={1000}
        monthRecords={MONTH_RECORDS}
      />,
    );
    expect(container.querySelector('[data-slot="career-timeline-table"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const twin = container.querySelector('[data-slot="career-timeline-table"]');
    expect(twin).not.toBeNull();
    const [ratingTable, monthTable] = Array.from(twin!.querySelectorAll('table'));
    expect(ratingTable!.querySelector('caption')?.textContent).toBe('Rating at each close');
    const ratingHeaders = Array.from(ratingTable!.querySelectorAll('thead th'));
    expect(ratingHeaders.map((th) => th.textContent)).toEqual([
      'Period',
      'Rating',
      '±RD',
      'W–L',
      'Rate',
      'Games',
    ]);
    for (const th of ratingHeaders) expect(th.getAttribute('scope')).toBe('col');
    const rows = Array.from(ratingTable!.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(TIMELINE.rating.points.length);
    const first = TIMELINE.rating.points[0]!;
    expect(Array.from(rows[0]!.children).map((cell) => cell.textContent)).toEqual([
      `period ${first.key}`,
      String(first.rating),
      `±${first.rd}`,
      `${first.wins}–${first.losses}`,
      `${Math.round((first.wins / first.total) * 100)}%`,
      String(first.total),
    ]);
    expect(monthTable!.querySelector('caption')?.textContent).toBe('Win rate and games by month');
  });

  it("plan 39.1-35 fidelity: the twin toggle is sketch 002's neutral bordered .btn, never brand-red link ink", () => {
    render(<CareerTimeline timeline={TIMELINE} labels={LABELS} width={1000} />);
    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle.getAttribute('data-variant')).toBe('outline');
    expect(toggle.className).not.toMatch(/\btext-primary\b/);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('table twin: the year x month table runs newest year first, 12 months + a year total, "<rate> · <n>" or "—", stacked per row below 640px', () => {
    const { container } = render(
      <CareerTimeline
        timeline={TIMELINE}
        labels={LABELS}
        width={1000}
        monthRecords={MONTH_RECORDS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const monthTable = container.querySelectorAll('[data-slot="career-timeline-table"] table')[1]!;
    const head = monthTable.querySelector('thead')!;
    expect(head.className).toContain('max-sm:hidden');
    const headers = Array.from(head.querySelectorAll('th'));
    expect(headers.map((th) => th.textContent)).toEqual([
      'Year',
      ...LABELS.table!.months,
      'Year total',
    ]);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
    const years = [...new Set(MONTH_RECORDS.map((r) => r.year))];
    const newest = Math.max(...years);
    const oldest = Math.min(...years);
    const bodyRows = Array.from(monthTable.querySelectorAll('tbody tr'));
    expect(bodyRows).toHaveLength(newest - oldest + 1);
    const yearCell = bodyRows[0]!.querySelector('th')!;
    expect(yearCell.getAttribute('scope')).toBe('row');
    expect(yearCell.textContent).toBe(String(newest));
    const monthCells = Array.from(bodyRows[0]!.querySelectorAll('td[data-m]'));
    expect(monthCells).toHaveLength(12);
    expect(monthCells.map((td) => td.getAttribute('data-m'))).toEqual(LABELS.table!.months);
    for (const td of monthCells) {
      expect(td.className).toContain('max-sm:before:content-[attr(data-m)]');
    }
    expect(bodyRows[0]!.className).toContain('max-sm:flex');
    const aRecord = MONTH_RECORDS.find((r) => r.year === newest)!;
    expect(monthCells[aRecord.month]!.textContent).toBe(
      `${Math.round((aRecord.wins / aRecord.total) * 100)}% · ${aRecord.total}`,
    );
    const emptyMonth = LABELS.table!.months.findIndex(
      (_, m) => !MONTH_RECORDS.some((r) => r.year === newest && r.month === m),
    );
    expect(emptyMonth).toBeGreaterThanOrEqual(0);
    expect(monthCells[emptyMonth]!.textContent).toBe('—');
  });

  const MARKERS: CareerTimelineEventMarker[] = [
    {
      key: 'evt-a',
      label: 'Genesis 10',
      atMs: TIMELINE.rating.points[8]!.closeMs,
      wins: 5,
      losses: 2,
      tier: 'supermajor',
      basis: 'recorded',
      ratingAfter: 1810,
    },
    {
      key: 'evt-b',
      label: 'Supernova',
      atMs: TIMELINE.rating.points[20]!.closeMs,
      wins: 3,
      losses: 2,
      tier: 'major',
      basis: 'manual',
      ratingAfter: 1850,
    },
  ];

  it('event layer: one baseline diamond per marker (11px, context ink, surface stroke) over a 24x24 hit area, focusable and labelled', () => {
    const { container } = render(
      <CareerTimeline
        timeline={TIMELINE}
        labels={LABELS}
        width={1000}
        eventMarkers={MARKERS}
        onSelectEventMarker={vi.fn()}
      />,
    );
    const x = anchorMapping(container);
    const plot = container.querySelector('[data-slot="career-timeline-plot-area"]')!;
    const baseline = numberAttr(plot, 'y') + numberAttr(plot, 'height');
    const events = container.querySelectorAll('[data-slot="career-timeline-event"]');
    expect(events).toHaveLength(2);
    events.forEach((el, i) => {
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.getAttribute('aria-label')).toBe(LABELS.eventAria!(MARKERS[i]!));
      const hit = el.querySelector('rect')!;
      expect(numberAttr(hit, 'width')).toBe(24);
      expect(numberAttr(hit, 'height')).toBe(24);
      expect(hit.getAttribute('fill')).toBe('transparent');
      const cx = numberAttr(hit, 'x') + 12;
      const cy = numberAttr(hit, 'y') + 12;
      expect(Math.abs(cx - x(MARKERS[i]!.atMs))).toBeLessThanOrEqual(0.5);
      expect(cy).toBe(baseline);
      const diamond = el.querySelector('path')!;
      expect(diamond.getAttribute('fill')).toBe(CHART_TOKENS.deemphasis);
      expect(diamond.getAttribute('stroke')).toBe(CHART_TOKENS.surface);
      expect(diamond.getAttribute('stroke-width')).toBe('1.5');
    });
  });

  it('event layer (12.6 anti-masquerade): an estimated marker is hollow with data-basis, a recorded or manual one is filled', () => {
    const estimated: CareerTimelineEventMarker = {
      ...MARKERS[0]!,
      key: 'evt-est',
      tier: 'major',
      basis: 'estimated',
      ratingAfter: null,
    };
    const { container } = render(
      <CareerTimeline
        timeline={TIMELINE}
        labels={LABELS}
        width={1000}
        eventMarkers={[MARKERS[0]!, MARKERS[1]!, estimated]}
        onSelectEventMarker={vi.fn()}
      />,
    );
    const events = Array.from(container.querySelectorAll('[data-slot="career-timeline-event"]'));
    expect(events).toHaveLength(3);
    expect(events.map((el) => el.getAttribute('data-basis'))).toEqual([
      'recorded',
      'manual',
      'estimated',
    ]);
    const paths = events.map((el) => el.querySelector('path')!);
    for (const filled of [paths[0]!, paths[1]!]) {
      expect(filled.getAttribute('fill')).toBe(CHART_TOKENS.deemphasis);
      expect(filled.getAttribute('stroke')).toBe(CHART_TOKENS.surface);
    }
    const hollow = paths[2]!;
    expect(hollow.getAttribute('fill')).toBe(CHART_TOKENS.surface);
    expect(hollow.getAttribute('stroke')).toBe(CHART_TOKENS.deemphasis);
    expect(hollow.getAttribute('stroke-width')).toBe('1.5');
  });

  it('event layer: supermajor and major markers share one shape (the tier is in the readout, never the mark)', () => {
    const { container } = render(
      <CareerTimeline
        timeline={TIMELINE}
        labels={LABELS}
        width={1000}
        eventMarkers={MARKERS}
        onSelectEventMarker={vi.fn()}
      />,
    );
    const shapes = Array.from(
      container.querySelectorAll('[data-slot="career-timeline-event"] path'),
    );
    // Same diamond geometry (relative offsets), same fill: only x differs.
    const normalise = (d: string) => d.replace(/-?\d+(\.\d+)?/g, '#');
    expect(new Set(shapes.map((el) => normalise(el.getAttribute('d')!))).size).toBe(1);
    expect(new Set(shapes.map((el) => el.getAttribute('fill'))).size).toBe(1);
  });

  it('event layer: focus shows the event readout, Enter and click select the marker', () => {
    const onSelectEventMarker = vi.fn();
    const { container } = render(
      <CareerTimeline
        timeline={TIMELINE}
        labels={LABELS}
        width={1000}
        eventMarkers={MARKERS}
        onSelectEventMarker={onSelectEventMarker}
      />,
    );
    const diamonds = Array.from(container.querySelectorAll('[data-slot="career-timeline-event"]'));
    expect(diamonds, 'one focusable diamond per marker').toHaveLength(2);
    const [first, second] = diamonds;
    fireEvent.focus(first!);
    const readout = container.querySelector('[data-slot="career-timeline-readout"]');
    expect(readout?.querySelector('[data-slot="career-timeline-readout-title"]')?.textContent).toBe(
      LABELS.readout({ kind: 'event', marker: MARKERS[0]! }).title,
    );
    fireEvent.keyDown(first!, { key: 'Enter' });
    expect(onSelectEventMarker).toHaveBeenLastCalledWith('evt-a');
    fireEvent.click(second!);
    expect(onSelectEventMarker).toHaveBeenLastCalledWith('evt-b');
    expect(onSelectEventMarker).toHaveBeenCalledTimes(2);
  });

  it('event layer: without markers there are no diamonds and no extra tab stops', () => {
    const { container } = render(
      <CareerTimeline timeline={TIMELINE} labels={LABELS} width={1000} />,
    );
    expect(container.querySelectorAll('[data-slot="career-timeline-event"]')).toHaveLength(0);
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });
});
