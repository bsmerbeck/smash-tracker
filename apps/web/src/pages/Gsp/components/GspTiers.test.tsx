import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  estimateT,
  getGspTierLadder,
  getGspTierPosition,
  type GspPoint,
  type GspSettings,
} from '@smash-tracker/shared';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { bestCalibration } from '../lib/gspMmrModel';
import { GspTiers } from './GspTiers';

vi.mock('@/hooks/useGspLive', () => ({
  useGspLive: () => ({ data: undefined }),
}));

const settings: GspSettings = { eliteThreshold: 9_000_000, updatedAt: Date.UTC(2026, 0, 1) };

/** A reading halfway between two interior ladder rows, so a next tier and a progress bar exist. */
function midLadderSeries(): { series: GspPoint[]; progress: number } {
  const nowMs = Date.now();
  const ladder = getGspTierLadder(estimateT(nowMs, bestCalibration(settings, undefined)), {});
  const byGsp = [...ladder].sort((a, b) => a.gsp - b.gsp);
  const lower = byGsp[2]!;
  const upper = byGsp[3]!;
  const gsp = Math.round((lower.gsp + upper.gsp) / 2);
  const position = getGspTierPosition(gsp, ladder);
  return {
    series: [
      { time: nowMs - 2 * 60 * 60 * 1000, gsp: gsp - 5_000, win: null },
      { time: nowMs - 60 * 60 * 1000, gsp, win: true },
    ],
    progress: Math.round((position.progressToNext ?? 0) * 100),
  };
}

function renderTiers(series: GspPoint[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GspTiers series={series} settings={settings} />
    </QueryClientProvider>,
  );
}

/**
 * Plan 39.1-50 (OOS-13; DD-11 extended to GSP by the owner 2026-09-25;
 * UI-SPEC §4.3 "brand red is never a data mark" and rule 3, a selected
 * data-adjacent state is neutral).
 */
describe('GspTiers ink (plan 39.1-50, OOS-13)', () => {
  it('fills the tier progress bar with the series ink, never the brand-red primary', () => {
    const { series } = midLadderSeries();
    const { container } = renderTiers(series);
    const fill = container.querySelector('[data-slot="gsp-tier-progress-fill"]') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.className).not.toMatch(/primary/);
    expect(fill.getAttribute('style') ?? '').toContain(`background-color: ${CHART_TOKENS.series1}`);
  });

  it("the fill's width still reflects progressToNext", () => {
    const { series, progress } = midLadderSeries();
    const { container } = renderTiers(series);
    const fill = container.querySelector('[data-slot="gsp-tier-progress-fill"]') as HTMLElement;
    expect(fill.style.width).toBe(`${progress}%`);
  });

  it("marks the current tier row neutrally and keeps its 'You' badge", () => {
    const { series } = midLadderSeries();
    renderTiers(series);
    const badge = screen.getByText('You');
    const row = badge.closest('li') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.className).not.toMatch(/primary/);
  });
});
