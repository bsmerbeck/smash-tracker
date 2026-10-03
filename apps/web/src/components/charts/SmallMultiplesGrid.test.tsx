import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { buildValueSeries } from '@smash-tracker/shared';
import type { ValueSeriesReading } from '@smash-tracker/shared';
import { ChartCard } from './ChartCard';
import { SmallMultiplesGrid, type SmallMultiplesPanel } from './SmallMultiplesGrid';
import type { TrendValuePoint } from './TrendLine';

/**
 * Plan 41-02 (A3 / DD-41-02, RESEARCH correction 1): the grid owns ONE crosshair. The fixture's
 * panels share NO x value (A on days 1/3/5, B on days 2/4/6) — exactly the case where a value-matched
 * cross-chart sync would silently hide the second panel's crosshair.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 5, 1, 12);
const dayMs = (day: number) => T0 + (day - 1) * DAY_MS;

function closePoint(prefix: string, day: number, value: number): TrendValuePoint {
  return {
    key: `${prefix}:${day}`,
    xMs: dayMs(day),
    value,
    kind: 'close',
    n: 1,
    memberIndexes: [day],
    containsCalibration: false,
    startMs: dayMs(day),
    endMs: dayMs(day) + 1,
    context: { valueKey: 'value', title: `${prefix} ${value}`, lines: [] },
  };
}

function panel(
  key: string,
  title: string,
  days: number[],
  base: number,
  overrides: Partial<SmallMultiplesPanel> = {},
): SmallMultiplesPanel {
  return {
    key,
    title,
    points: days.map((day, i) => closePoint(key, day, base + i * 10)),
    grain: 'day',
    formatTick: (n) => String(n),
    formatValueFull: (n) => n.toLocaleString('en'),
    readoutLine: (point) => `${title} · ${point.value}`,
    labels: { aria: `${title} over time` },
    ...overrides,
  };
}

function renderGrid(panels: SmallMultiplesPanel[], width = 640) {
  return render(
    <ChartCard title="Est. MMR vs Glicko-2">
      <SmallMultiplesGrid
        panels={panels}
        layout="stacked"
        xDomain={[dayMs(1), dayMs(6)]}
        width={width}
        caption="Each panel keeps its own scale — compare the shapes, not the heights."
        aria="2 panels sharing one time axis"
        tableLabels={{ toggle: 'View as table', date: 'Date' }}
      />
    </ChartCard>,
  );
}

const A_DAYS = [1, 3, 5];
const B_DAYS = [2, 4, 6];

function crosshairXs(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('[data-slot="trend-value-crosshair"]')).map((line) =>
    Number(line.getAttribute('x1')),
  );
}

function markX(container: HTMLElement, key: string): number {
  return Number(container.querySelector(`[data-point-key="${key}"]`)!.getAttribute('cx'));
}

describe('SmallMultiplesGrid (plan 41-02, DD-41-02)', () => {
  it('renders one plot per panel inside the frame, a group name, the caption and exactly one x axis', () => {
    const { container } = renderGrid([
      panel('mmr', 'Est. MMR', A_DAYS, 1000),
      panel('glicko', 'Glicko-2', B_DAYS, 1700),
    ]);
    expect(container.querySelector('[data-slot="card"]')).not.toBeNull();
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('2 panels sharing one time axis');
    expect(container.querySelectorAll('[data-slot="trend-line-value"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="trend-value-plot"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="trend-value-x-axis"]')).toHaveLength(1);
    // The one drawn x axis belongs to the LAST panel.
    const lastPanel = container.querySelectorAll('[data-slot="multiples-panel"]')[1]!;
    expect(lastPanel.querySelector('[data-slot="trend-value-x-axis"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="multiples-caption"]')?.textContent).toBe(
      'Each panel keeps its own scale — compare the shapes, not the heights.',
    );
  });

  it('keeps each panel on its own fitted y: the domains differ when the data differ, never normalised', () => {
    const { container } = renderGrid([
      panel('mmr', 'Est. MMR', A_DAYS, 1000),
      panel('glicko', 'Glicko-2', B_DAYS, 1_700_000),
    ]);
    const domains = Array.from(container.querySelectorAll('[data-slot="trend-line-value"]')).map(
      (root) => root.getAttribute('data-y-domain'),
    );
    expect(new Set(domains).size).toBe(2);
  });

  it('hover in one panel draws the crosshair at the SAME x in both panels, even though the x sets share no value', () => {
    const a = panel('mmr', 'Est. MMR', A_DAYS, 1000);
    const b = panel('glicko', 'Glicko-2', B_DAYS, 1700);
    const { container } = renderGrid([a, b]);
    expect(crosshairXs(container)).toEqual([]);

    const hitA = container.querySelectorAll('[data-slot="trend-value-hit"]')[0]!;
    fireEvent.pointerMove(hitA, { clientX: markX(container, 'mmr:3'), pointerType: 'mouse' });
    const xs = crosshairXs(container);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBeCloseTo(xs[1]!, 5);
    expect(xs[0]).toBeCloseTo(markX(container, 'mmr:3'), 5);
    // Panel B has no point on day 3: its crosshair stands where it has none.
    expect(B_DAYS).not.toContain(3);
    // And the one readout lists BOTH panels' nearest values at that x.
    const lines = Array.from(
      container.querySelectorAll('[data-slot="multiples-readout-line"]'),
    ).map((el) => el.textContent);
    expect(lines).toEqual(['Est. MMR · 1010', 'Glicko-2 · 1700']);
    expect(container.querySelectorAll('[data-slot="multiples-readout"]')).toHaveLength(1);

    fireEvent.pointerLeave(hitA, { pointerType: 'mouse' });
    expect(crosshairXs(container)).toEqual([]);
    expect(container.querySelector('[data-slot="multiples-readout"]')).toBeNull();
  });

  it("puts both panels' plots on one pixel column for one x (equal y gutters)", () => {
    const { container } = renderGrid([
      panel('mmr', 'Est. MMR', A_DAYS, 1000, { formatTick: (n) => String(n) }),
      panel('glicko', 'Glicko-2', B_DAYS, 1_700_000, {
        formatTick: (n) => `${(n / 1e6).toFixed(2)}M`,
      }),
    ]);
    const hitA = container.querySelectorAll('[data-slot="trend-value-hit"]')[0]!;
    const hitB = container.querySelectorAll('[data-slot="trend-value-hit"]')[1]!;
    expect(hitA.getAttribute('x')).toBe(hitB.getAttribute('x'));
    expect(hitA.getAttribute('width')).toBe(hitB.getAttribute('width'));
  });

  it("steps the sorted UNION of both panels' x values from the keyboard and moves the crosshair in every panel", () => {
    const onSelectPoint = vi.fn();
    const a = panel('mmr', 'Est. MMR', A_DAYS, 1000);
    const b = panel('glicko', 'Glicko-2', B_DAYS, 1700, { onSelectPoint });
    const { container } = renderGrid([a, b]);
    const group = container.querySelector('[role="group"]') as HTMLElement;
    const plots = container.querySelectorAll('[data-slot="trend-value-plot"]');
    expect(plots).toHaveLength(2);
    plots.forEach((plot) => expect(plot.getAttribute('tabindex')).toBe('0'));

    const stepTo = (key: string) => {
      const xs = crosshairXs(container);
      expect(xs).toHaveLength(2);
      expect(xs[0]).toBeCloseTo(markX(container, key), 5);
      expect(xs[1]).toBeCloseTo(markX(container, key), 5);
    };
    fireEvent.keyDown(plots[1]!, { key: 'ArrowRight' });
    stepTo('glicko:6'); // first press: the latest x of the union (day 6, panel B only)
    fireEvent.keyDown(plots[1]!, { key: 'ArrowLeft' });
    stepTo('mmr:5'); // day 5 (panel A only)
    fireEvent.keyDown(plots[0]!, { key: 'ArrowLeft' });
    stepTo('glicko:4');
    fireEvent.keyDown(group, { key: 'Home' });
    stepTo('mmr:1');
    fireEvent.keyDown(group, { key: 'End' });
    stepTo('glicko:6');
    expect(container.querySelector('[data-slot="multiples-live"]')?.textContent).toContain(
      'Glicko-2 · 1720',
    );

    // Enter selects the focused panel's nearest point (B has a handler, A does not).
    fireEvent.keyDown(plots[1]!, { key: 'Enter' });
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    expect(onSelectPoint.mock.calls[0]![0].key).toBe('glicko:6');
    fireEvent.keyDown(plots[0]!, { key: 'Enter' });
    expect(onSelectPoint).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(group, { key: 'Escape' });
    expect(crosshairXs(container)).toEqual([]);
  });

  it('draws at most 60 marks per panel on a long real series', () => {
    const readings = (offset: number): ValueSeriesReading[] =>
      Array.from({ length: 200 }, (_, i) => ({
        atMs: T0 + Math.round((i * 540 * DAY_MS) / 200) + offset,
        value: 1000 + i,
        calibration: false,
      }));
    const toPoints = (series: ReturnType<typeof buildValueSeries>): TrendValuePoint[] =>
      series.points.map((point) => ({
        ...point,
        context: { valueKey: 'value', title: String(point.value), lines: [] },
      }));
    const seriesA = buildValueSeries(readings(0));
    const seriesB = buildValueSeries(readings(DAY_MS / 2));
    const { container } = renderGrid([
      panel('mmr', 'Est. MMR', [], 0, { points: toPoints(seriesA), grain: seriesA.grain }),
      panel('glicko', 'Glicko-2', [], 0, { points: toPoints(seriesB), grain: seriesB.grain }),
    ]);
    container.querySelectorAll('[data-slot="multiples-panel"]').forEach((el) => {
      const marks = el.querySelectorAll(
        '[data-slot="trend-value-dot"], [data-slot="trend-value-diamond"]',
      );
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.length).toBeLessThanOrEqual(60);
    });
  });

  it("offers one table twin: date · each panel's value, blank where a panel has no point", () => {
    const { container } = renderGrid([
      panel('mmr', 'Est. MMR', A_DAYS, 1000),
      panel('glicko', 'Glicko-2', B_DAYS, 1700),
    ]);
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View as table',
    )!;
    fireEvent.click(toggle);
    expect(
      Array.from(container.querySelectorAll('th[scope="col"]')).map((th) => th.textContent),
    ).toEqual(['Date', 'Est. MMR', 'Glicko-2']);
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
    );
    expect(rows).toHaveLength(6);
    // Day 1: A has a value, B is blank; day 2: the reverse.
    expect(rows[0]![1]).toBe('1,000');
    expect(rows[0]![2]).toBe('');
    expect(rows[1]![1]).toBe('');
    expect(rows[1]![2]).toBe('1,700');
  });

  it('renders nothing when no panel has a point', () => {
    const { container } = renderGrid([panel('mmr', 'Est. MMR', [], 0)]);
    expect(container.querySelector('[data-slot="small-multiples"]')).toBeNull();
  });
});
