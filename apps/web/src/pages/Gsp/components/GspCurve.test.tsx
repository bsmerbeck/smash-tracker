import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { GSP_MODEL, estimateT, mmrToGsp } from '@smash-tracker/shared';
import { GspCurve } from './GspCurve';

vi.mock('@/hooks/useGspLive', () => ({ useGspLive: () => ({ data: undefined }) }));

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 0, 5, 12);
const NEVER_SAVED: GspSettings = { eliteThreshold: 10_000_000, updatedAt: 0 };

/** `count` readings spread over `spanDays`, rising 5k each; indexes in `calibrationAt` are manual re-baselines. */
function makeSeries(
  count: number,
  spanDays: number,
  { start = 9_000_000, calibrationAt = [] as number[] } = {},
): GspPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    time: START_MS + Math.round((i * spanDays * DAY_MS) / count),
    gsp: start + i * 5_000,
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
    renderCurve(makeSeries(40, 120, { start: 9_500_000 }));
    expect(screen.getByText('GSP by reading')).toBeInTheDocument();
    expect(screen.getByText(/logged post-match GSP reading/)).toBeInTheDocument();
    expect(screen.getByText(/^Elite threshold [\d,]+$/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Est. MMR' }));
    expect(screen.getByText('Est. MMR by reading')).toBeInTheDocument();
    expect(screen.getByText(/doesn't inflate over time/)).toBeInTheDocument();
    expect(screen.queryByText(/logged post-match GSP reading/)).not.toBeInTheDocument();
    expect(
      screen.getByText(`Elite threshold ${GSP_MODEL.ELITE_MMR.toLocaleString('en')}`),
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
});
