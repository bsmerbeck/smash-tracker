import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { GSP_MODEL, buildValueSeries, estimateT, mmrToGsp } from '@smash-tracker/shared';
import { GspCurve } from './GspCurve';
import { computedEliteThreshold } from '../lib/gspMmrModel';
import { referencePlacement } from '@/components/charts/valueTrendGeometry';

vi.mock('@/hooks/useGspLive', () => ({ useGspLive: () => ({ data: undefined }) }));

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 0, 5, 12);
const NEVER_SAVED: GspSettings = { eliteThreshold: 10_000_000, updatedAt: 0 };

/**
 * A manual calibration saved "now": the computed GSP Elite threshold the curve draws is then this value
 * to within rounding (the model clamps t, so an arbitrary threshold is NOT reproduced - hence the helper
 * hands back what the component will actually compute).
 */
function calibratedNow(): { settings: GspSettings; elite: number } {
  const settings: GspSettings = { eliteThreshold: 14_000_000, updatedAt: Date.now() };
  const elite = computedEliteThreshold(Date.now(), {
    eliteThresholdGsp: settings.eliteThreshold,
    atMs: settings.updatedAt,
  });
  return { settings, elite };
}

/** `count` readings spread over `spanDays`, rising 5k each; indexes in `calibrationAt` are manual re-baselines. */
function makeSeries(
  count: number,
  spanDays: number,
  { start = 9_000_000, step = 5_000, calibrationAt = [] as number[] } = {},
): GspPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    time: START_MS + Math.round((i * spanDays * DAY_MS) / count),
    gsp: start + i * step,
    win: calibrationAt.includes(i) ? null : i % 3 !== 0,
  }));
}

function renderCurve(series: GspPoint[], props: Partial<Parameters<typeof GspCurve>[0]> = {}) {
  return render(<GspCurve series={series} settings={NEVER_SAVED} chartWidth={830} {...props} />);
}

function marks(container: HTMLElement): Element[] {
  return [
    ...container.querySelectorAll(
      '[data-slot="trend-value-dot"], [data-slot="trend-value-diamond"]',
    ),
  ];
}

describe('GspCurve on the kit value mode (plan 41-06, A1)', () => {
  it('is a compact card titled GSP Curve with the GSP | Est. MMR switch and no canvas', () => {
    const { container } = renderCurve(makeSeries(40, 120));
    expect(screen.getByText('GSP Curve')).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'View' });
    expect(within(group).getByRole('radio', { name: 'GSP' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Est. MMR' })).not.toBeChecked();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('[data-slot="trend-line-value"]')).not.toBeNull();
  });

  it('names the reading grain in the overline for a thin series and marks only the last reading', () => {
    const { container } = renderCurve(makeSeries(40, 120), { onSelectReading: vi.fn() });
    expect(screen.getByText('GSP by reading')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="trend-value-dot"]')).toHaveLength(1);
    expect(screen.getByText('Click a point to edit that reading.')).toBeInTheDocument();
  });

  it('draws calibration readings as diamonds and names them in the legend', () => {
    const { container } = renderCurve(makeSeries(40, 120, { calibrationAt: [10] }), {
      onSelectReading: vi.fn(),
    });
    expect(container.querySelectorAll('[data-slot="trend-value-diamond"]')).toHaveLength(1);
    expect(screen.getAllByText('set manually').length).toBeGreaterThan(0);
  });

  it('toggles the series and the reference between GSP and Est. MMR', async () => {
    const user = userEvent.setup();
    const { settings, elite } = calibratedNow();
    renderCurve(makeSeries(40, 120, { start: elite - 400_000, step: 10_000 }), { settings });
    expect(screen.getByText('GSP by reading')).toBeInTheDocument();
    expect(screen.getByText(/logged post-match GSP reading/)).toBeInTheDocument();
    expect(screen.getByText(/^Elite threshold [\d,]+$/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Est. MMR' }));
    expect(screen.getByText('Est. MMR by reading')).toBeInTheDocument();
    expect(screen.getByText(/doesn't inflate over time/)).toBeInTheDocument();
    expect(screen.queryByText(/logged post-match GSP reading/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(`^Elite threshold ${GSP_MODEL.ELITE_MMR.toLocaleString('en')}( — .+)?$`),
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'GSP' }));
    expect(screen.getByText('GSP by reading')).toBeInTheDocument();
  });

  it('plots Est. MMR flat for a flat-skill series even though its GSP inflated', async () => {
    const user = userEvent.setup();
    const t0 = GSP_MODEL.T_ANCHOR.atMs;
    const flat: GspPoint[] = Array.from({ length: 6 }, (_, i) => {
      const time = t0 + i * 14 * DAY_MS;
      return { time, gsp: Math.round(mmrToGsp(1050, estimateT(time))), win: true };
    });
    const { container } = renderCurve(flat);
    await user.click(screen.getByRole('radio', { name: 'Est. MMR' }));
    await user.click(screen.getByRole('button', { name: 'View as table' }));
    const values = [...container.querySelectorAll('[data-slot="trend-value-table"] tbody tr')].map(
      (row) => Number(row.querySelectorAll('td')[1]?.textContent?.replace(/,/g, '')),
    );
    expect(values).toHaveLength(6);
    // Rounded to a whole MMR by the 1-GSP rounding of each input reading: flat to within a few points.
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(3);
    expect(Math.abs(values[0]! - 1050)).toBeLessThanOrEqual(3);
  });

  it('draws a 200-reading series as at most 60 points at a coarser grain the overline names', () => {
    const { container } = renderCurve(makeSeries(200, 18 * 30), { onSelectPeriod: vi.fn() });
    const root = container.querySelector('[data-slot="trend-line-value"]')!;
    const grain = root.getAttribute('data-grain')!;
    expect(grain).not.toBe('reading');
    const drawn = marks(container);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThanOrEqual(60);
    expect(screen.getByText(new RegExp(`^GSP · close of ${grain}$`))).toBeInTheDocument();
    expect(screen.getByText('Click a close to find its readings in the log.')).toBeInTheDocument();
    expect(screen.queryByText('GSP by reading')).not.toBeInTheDocument();
  });

  // 41-REVIEW CR-02: compact ticks derive their fraction digits from the tick step, so two adjacent
  // hairlines never carry the same label (10,010,000-10,080,000 sits on a 20,000 step).
  it('CR-02: a narrow GSP range prints one distinct y label per hairline (10.01M-10.08M)', () => {
    const { container } = renderCurve(makeSeries(40, 120, { start: 10_010_000, step: 1_795 }));
    const labels = [...container.querySelectorAll('.recharts-yAxis-tick-labels text')].map(
      (el) => el.textContent ?? '',
    );
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // 41-REVIEW WR-05: under 520px the kit draws the coarser series, so the footer hint and the aria count
  // describe THAT series - a phone user with 45 readings sees closes, not "Click a point to edit".
  it('WR-05: a narrow plot states the drawn grain in the click hint and the drawn count in the aria label', () => {
    const { container } = renderCurve(makeSeries(45, 120), {
      chartWidth: 420,
      onSelectReading: vi.fn(),
      onSelectPeriod: vi.fn(),
    });
    const root = container.querySelector('[data-slot="trend-line-value"]')!;
    expect(root.getAttribute('data-narrow')).toBe('true');
    expect(root.getAttribute('data-grain')).not.toBe('reading');
    const drawnCount = Number(root.getAttribute('data-point-count'));
    expect(drawnCount).toBeLessThan(45);
    expect(screen.getByText('Click a close to find its readings in the log.')).toBeInTheDocument();
    expect(screen.queryByText('Click a point to edit that reading.')).not.toBeInTheDocument();
    const aria = container
      .querySelector('[data-slot="trend-value-plot"]')!
      .getAttribute('aria-label')!;
    expect(aria).toContain(String(drawnCount));
    expect(aria).not.toContain('45');
  });

  it('WR-05: a wide plot keeps the reading hint and the reading count', () => {
    const { container } = renderCurve(makeSeries(45, 120), {
      chartWidth: 830,
      onSelectReading: vi.fn(),
      onSelectPeriod: vi.fn(),
    });
    expect(
      container.querySelector('[data-slot="trend-line-value"]')!.getAttribute('data-narrow'),
    ).toBe('false');
    expect(screen.getByText('Click a point to edit that reading.')).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="trend-value-plot"]')!.getAttribute('aria-label'),
    ).toContain('45');
  });

  it('re-grains a narrow plot to the 30-point series', () => {
    const { container } = renderCurve(makeSeries(200, 18 * 30), { chartWidth: 420 });
    expect(marks(container).length).toBeLessThanOrEqual(30);
  });

  it('shows the locked inset with the meter at one reading', () => {
    const { container } = renderCurve(makeSeries(1, 1));
    const root = container.querySelector('[data-slot="trend-line-value"]')!;
    expect(root.getAttribute('data-state')).toBe('locked');
    expect(
      screen.getByText(
        'Log at least 2 matches with a GSP reading for this fighter to see the curve.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('1 of 2 readings')).toBeInTheDocument();
    expect(container.querySelector('svg.recharts-surface')).toBeNull();
  });

  it('keeps the card with the unlock sentence at zero readings (no empty chart frame)', () => {
    const { container } = renderCurve([]);
    expect(screen.getByText('GSP Curve')).toBeInTheDocument();
    expect(screen.getByText(/Log at least 2 matches/)).toBeInTheDocument();
    expect(container.querySelector('[data-slot="trend-line-value"]')).toBeNull();
  });

  it('raises onSelectReading with the entry index of the clicked reading (A2, T-41-16)', () => {
    const onSelectReading = vi.fn();
    const onSelectPeriod = vi.fn();
    const { container } = renderCurve(makeSeries(40, 120, { calibrationAt: [10] }), {
      onSelectReading,
      onSelectPeriod,
    });
    const hit = container.querySelector('[data-slot="trend-value-hit"]')!;

    const diamond = container.querySelector('[data-slot="trend-value-diamond"]')!;
    // The diamond is a path `M{x} {y-h} ...`: its x is the first number.
    const diamondX = Number(/^M(-?[\d.]+)/.exec(diamond.getAttribute('d') ?? '')![1]);
    fireEvent.click(hit, { clientX: diamondX, clientY: 100 });
    expect(onSelectReading).toHaveBeenLastCalledWith(10);

    const last = container.querySelector('[data-slot="trend-value-dot"]')!;
    fireEvent.click(hit, { clientX: Number(last.getAttribute('cx')), clientY: 100 });
    expect(onSelectReading).toHaveBeenLastCalledWith(39);
    expect(onSelectPeriod).not.toHaveBeenCalled();
  });

  it('raises onSelectPeriod with the close memberIndexes at a coarser grain, never onSelectReading (DD-41-12)', () => {
    const series = makeSeries(200, 18 * 30);
    const onSelectReading = vi.fn();
    const onSelectPeriod = vi.fn();
    const { container } = renderCurve(series, { onSelectReading, onSelectPeriod });
    const expected = buildValueSeries(
      series.map((p) => ({ atMs: p.time, value: p.gsp, calibration: p.win === null })),
      { target: 60 },
    ).points;
    const target = expected[4]!;
    expect(target.memberIndexes.length).toBeGreaterThan(1);
    const mark = container.querySelector(`[data-point-key="${target.key}"]`)!;
    const hit = container.querySelector('[data-slot="trend-value-hit"]')!;
    fireEvent.click(hit, { clientX: Number(mark.getAttribute('cx')), clientY: 100 });
    expect(onSelectPeriod).toHaveBeenCalledTimes(1);
    expect(onSelectPeriod).toHaveBeenCalledWith(target.memberIndexes);
    expect(onSelectReading).not.toHaveBeenCalled();
  });

  // UAT 41 test 9 / F19: readings sharing one instant (two matches and a calibration on Jul 7) are one
  // close-of-instant point — no zero-width vertical spike, and every peak/low/last label is a drawn vertex.
  describe('same-instant readings (F19)', () => {
    const T = START_MS + 10 * DAY_MS;
    const tied: GspPoint[] = [
      { time: T - 5 * DAY_MS, gsp: 12_100_000, win: true },
      { time: T, gsp: 12_500_000, win: true },
      { time: T, gsp: 12_700_000, win: true },
      { time: T, gsp: 13_456_789, win: null },
      { time: T + 60 * 60 * 1000, gsp: 12_600_000, win: false },
      { time: T + DAY_MS, gsp: 12_890_123, win: true },
    ];

    function vertices(container: HTMLElement): { x: number; y: number }[] {
      const d = container
        .querySelector('.trend-line-value-line .recharts-line-curve')!
        .getAttribute('d')!;
      return [...d.matchAll(/[ML]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      }));
    }

    it('draws one vertex per instant: no two consecutive vertices share an x', () => {
      const { container } = renderCurve(tied);
      const points = vertices(container);
      expect(points).toHaveLength(4);
      points.slice(1).forEach((point, i) => {
        expect(point.x).not.toBe(points[i]!.x);
      });
    });

    it('labels only values the line actually draws, the peak on the one vertex at its x', () => {
      const { container } = renderCurve(tied);
      // The close of each instant: T's three readings close on the calibration (last in series order).
      const drawn = new Set(['12,100,000', '13,456,789', '12,600,000', '12,890,123']);
      const labels = [...container.querySelectorAll('[data-slot="trend-value-label"]')];
      expect(labels.length).toBeGreaterThan(0);
      labels.forEach((label) => expect(drawn).toContain(label.textContent ?? ''));
      const peak = container.querySelector('[data-slot="trend-value-label"][data-role="peak"]')!;
      expect(peak.textContent).toBe('13,456,789');
      const peakX = Number(peak.getAttribute('x'));
      // Before F19 the instant drew three vertices at this x (a zero-width spike up to the label).
      expect(vertices(container).filter((point) => Math.abs(point.x - peakX) < 0.5)).toHaveLength(
        1,
      );
    });

    it('a collapsed instant click raises onSelectPeriod with every member, never onSelectReading', () => {
      const onSelectReading = vi.fn();
      const onSelectPeriod = vi.fn();
      const { container } = renderCurve(tied, { onSelectReading, onSelectPeriod });
      const diamond = container.querySelector('[data-slot="trend-value-diamond"]')!;
      const diamondX = Number(/^M(-?[\d.]+)/.exec(diamond.getAttribute('d') ?? '')![1]);
      const hit = container.querySelector('[data-slot="trend-value-hit"]')!;
      fireEvent.click(hit, { clientX: diamondX, clientY: 100 });
      expect(onSelectPeriod).toHaveBeenCalledWith([1, 2, 3]);
      expect(onSelectReading).not.toHaveBeenCalled();
    });
  });

  it('writes no URL axis: the curve never touches the router (A2)', () => {
    // No Router wraps this render: a `useNavigate` / `useSearchParams` call would throw.
    expect(() => renderCurve(makeSeries(40, 120), { onSelectReading: vi.fn() })).not.toThrow();
  });
});

describe('GspCurve Elite reference placement (DD-41-13)', () => {
  const referenceLine = (container: HTMLElement) =>
    container.querySelector('[data-slot="trend-value-reference"]');

  it('draws no line and says "above this range" when Elite sits far above the readings', () => {
    const { settings, elite } = calibratedNow();
    // 40 readings spanning 195k, about 8M below Elite: far beyond twice the data span.
    const { container } = renderCurve(makeSeries(40, 120, { start: elite - 8_000_000 }), {
      settings,
    });
    expect(referenceLine(container)).toBeNull();
    expect(container.querySelector('[data-slot="trend-value-reference-label"]')).toBeNull();
    const legend = screen.getByText(/^Elite threshold [\d,]+ — above this range$/);
    const value = Number(
      /Elite threshold ([\d,]+)/.exec(legend.textContent!)![1]!.replace(/,/g, ''),
    );
    expect(Math.abs(value - elite)).toBeLessThan(1_000);
  });

  it('draws no line and says "below this range" when Elite sits far below the readings', () => {
    const { settings, elite } = calibratedNow();
    const { container } = renderCurve(makeSeries(40, 120, { start: elite + 700_000 }), {
      settings,
    });
    expect(referenceLine(container)).toBeNull();
    expect(screen.getByText(/^Elite threshold [\d,]+ — below this range$/)).toBeInTheDocument();
  });

  it('draws the dashed line and its direct label when Elite is near the readings', () => {
    const { settings, elite } = calibratedNow();
    // Readings 400k..10k under Elite (span 390k): Elite is within twice the span.
    const { container } = renderCurve(
      makeSeries(40, 120, { start: elite - 400_000, step: 10_000 }),
      { settings },
    );
    expect(referenceLine(container)).not.toBeNull();
    expect(container.querySelector('[data-slot="trend-value-reference-label"]')).not.toBeNull();
    expect(screen.getByText(/^Elite threshold [\d,]+$/)).toBeInTheDocument();
    expect(screen.queryByText(/this range/)).not.toBeInTheDocument();
  });

  it('judges the MMR view on its own scale: Elite MMR 1142 against the converted readings', async () => {
    const user = userEvent.setup();
    const { settings, elite } = calibratedNow();
    renderCurve(makeSeries(40, 120, { start: elite - 400_000, step: 10_000 }), { settings });
    await user.click(screen.getByRole('radio', { name: 'Est. MMR' }));
    // Whatever the placement, the legend names Elite at the fixed model value, never the GSP threshold.
    const eliteMmr = GSP_MODEL.ELITE_MMR.toLocaleString('en');
    expect(
      screen.getByText(new RegExp(`^Elite threshold ${eliteMmr}( — (above|below) this range)?$`)),
    ).toBeInTheDocument();
  });

  it("applies the stated placement examples to the kit's rule", () => {
    // 2.0M-2.1M with a 10M Elite: far above. 11.0M-11.2M with 10.3M: far below. 9.2M-9.6M with 9.8M: a line.
    expect(referencePlacement([2_000_000, 2_050_000, 2_100_000], 10_000_000)).toBe('above-range');
    expect(referencePlacement([11_000_000, 11_100_000, 11_200_000], 10_300_000)).toBe(
      'below-range',
    );
    expect(referencePlacement([9_200_000, 9_400_000, 9_600_000], 9_800_000)).toBe('line');
  });
});
