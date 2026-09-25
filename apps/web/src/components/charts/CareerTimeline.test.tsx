import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  buildCareerTimeline,
  type CareerTimeline as CareerTimelineData,
} from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { ChartCard } from './ChartCard';
import { CareerTimeline, type CareerTimelineLabels } from './CareerTimeline';

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
  aria: 'Career timeline — rating 1813 ±91 across 31 periods',
};

function renderTimeline(width: number) {
  return render(
    <ChartCard title="Career timeline" density="compact">
      <CareerTimeline timeline={TIMELINE} labels={LABELS} width={width} />
    </ChartCard>,
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
});
