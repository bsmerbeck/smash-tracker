import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GspGainStats } from '@smash-tracker/shared';
import { chartColors, seriesBarDataset } from '@/lib/chartTheme';
import { GainsAnalysis } from './GainsAnalysis';

/**
 * Plan 39.1-39 (OWNER DECISION 2026-09-25, DD-11 extended to GSP): the
 * per-win bars take the series ink (`seriesBarDataset`). Same technique as
 * GspVsGlicko.test.tsx — a file-local react-chartjs-2 mock records the
 * `data` prop, since the alias stub drops it.
 */
type ChartData = { datasets: Array<Record<string, unknown>> };
const captured: { data: ChartData | null } = { data: null };

vi.mock('react-chartjs-2', () => ({
  Bar: (props: { data: ChartData }) => {
    captured.data = props.data;
    return <div data-testid="gains-bar" />;
  },
}));

const stats: GspGainStats = {
  avgGainPerWinLifetime: 120_000,
  avgDropPerLossLifetime: 90_000,
  avgGainPerWinLast20: 110_000,
  avgDropPerLossLast20: 95_000,
  biggestGain: 180_000,
  biggestDrop: 140_000,
  perWinGains: [180_000, 150_000, 120_000, 100_000],
  gainTrend: 'shrinking',
};

describe('GainsAnalysis per-win bar colours (DD-11, owner decision 2026-09-25)', () => {
  it('the per-win bars are the series ink, never brand red', () => {
    captured.data = null;
    render(<GainsAnalysis stats={stats} />);
    expect(captured.data).not.toBeNull();
    const [bars] = captured.data!.datasets;
    expect(bars!.backgroundColor).toBe(seriesBarDataset().backgroundColor);
    expect(bars!.borderColor).toBe(chartColors.series);
    expect(bars!.backgroundColor).not.toBe(chartColors.red);
    expect(bars!.data).toEqual(stats.perWinGains);
  });
});
