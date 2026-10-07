import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { GspGainStats } from '@smash-tracker/shared';
import { GainsAnalysis } from './GainsAnalysis';

/**
 * Plan 41-05 (A4, DD-41-16): the Gains card is four figures over bars by GSP
 * band, read from the shared `gainsByBand` (the card never bins), on the kit.
 */
const stats: GspGainStats = {
  avgGainPerWinLifetime: 120_000,
  avgDropPerLossLifetime: 90_000,
  avgGainPerWinLast20: 110_000,
  avgDropPerLossLast20: 95_000,
  biggestGain: 180_000,
  biggestDrop: 140_000,
  perWinGains: [180_000, 150_000, 120_000, 100_000],
  perWinLevels: [9_000_000, 9_250_000, 9_500_000, 9_750_000],
  recentWinStepCount: 3,
  recentLossStepCount: 1,
  gainsByBand: [
    { fromGsp: 9_000_000, toGsp: 9_250_000, wins: 1, avgGain: 180_000 },
    { fromGsp: 9_250_000, toGsp: 9_500_000, wins: 4, avgGain: 150_000 },
    { fromGsp: 9_500_000, toGsp: 9_750_000, wins: 5, avgGain: 90_000 },
  ],
  gainTrend: 'shrinking',
};

function figureTexts(): string[] {
  const row = document.querySelector('[data-slot="stat-row"]')!;
  return Array.from(row.children).map((child) => child.textContent ?? '');
}

describe('GainsAnalysis', () => {
  // UAT 41 test 9 / F19: each support line counts the steps behind its own average — wins for the
  // avg gain, losses for the avg drop — never one shared 'last N steps'.
  it('states four figures with signed values (U+2212 for drops) and support lines counting their own wins / losses', () => {
    render(<GainsAnalysis stats={stats} />);
    const figures = figureTexts();
    expect(figures).toHaveLength(4);
    expect(figures[0]).toContain('Avg gain per win');
    expect(figures[0]).toContain('+120,000');
    expect(figures[0]).toContain('last 3 wins: +110,000');
    expect(figures[1]).toContain('Avg drop per loss');
    expect(figures[1]).toContain('−' + '90,000');
    expect(figures[1]).toContain('last loss: −' + '95,000');
    expect(figures.join(' ')).not.toContain('steps');
    expect(figures[2]).toContain('+180,000');
    expect(figures[3]).toContain('−' + '140,000');
  });

  it('draws one bar row per band, lowest band first, with its printed gain', () => {
    render(<GainsAnalysis stats={stats} />);
    const list = document.querySelector('[data-slot="comparison-bars-series"]')!;
    const rows = within(list as HTMLElement).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('+180,000');
    expect(rows[2]!.textContent).toContain('+90,000');
    // the fullest bar belongs to the largest average gain
    const fills = list.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-fill"]');
    expect(fills[0]!.style.width).toBe('100%');
    expect(Number.parseFloat(fills[2]!.style.width)).toBeCloseTo(50);
    // no row is a button: bands are not a drill axis
    expect(list.querySelectorAll('button')).toHaveLength(0);
  });

  it('greys a band under three wins and explains why in its tooltip', () => {
    render(<GainsAnalysis stats={stats} />);
    const labels = document.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-label"]');
    expect(labels[0]!.title).toContain('1 win — under 3');
    expect(labels[1]!.title).not.toContain('under');
  });

  it('draws only the drop figures and no bars when there are no wins', () => {
    render(
      <GainsAnalysis
        stats={{
          ...stats,
          avgGainPerWinLifetime: null,
          avgGainPerWinLast20: null,
          biggestGain: null,
          perWinGains: [],
          perWinLevels: [],
          gainsByBand: [],
          gainTrend: 'flat',
        }}
      />,
    );
    expect(figureTexts()).toHaveLength(2);
    expect(screen.queryByText('Avg gain per win')).toBeNull();
    expect(document.querySelector('[data-slot="comparison-bars-series"]')).toBeNull();
  });

  it('shows an em dash and no support for a drop that never happened', () => {
    render(
      <GainsAnalysis
        stats={{
          ...stats,
          avgDropPerLossLifetime: null,
          avgDropPerLossLast20: null,
          biggestDrop: null,
        }}
      />,
    );
    const figures = figureTexts();
    expect(figures[1]).toContain('—');
    expect(figures[1]).not.toContain('last');
  });

  it('shows the empty line and nothing else when there are no steps', () => {
    render(
      <GainsAnalysis
        stats={{
          avgGainPerWinLifetime: null,
          avgDropPerLossLifetime: null,
          avgGainPerWinLast20: null,
          avgDropPerLossLast20: null,
          biggestGain: null,
          biggestDrop: null,
          perWinGains: [],
          perWinLevels: [],
          recentWinStepCount: 0,
          recentLossStepCount: 0,
          gainsByBand: [],
          gainTrend: 'flat',
        }}
      />,
    );
    expect(screen.getByText(/Log a few wins and losses/)).toBeTruthy();
    expect(document.querySelector('[data-slot="stat-row"]')).toBeNull();
  });

  it('draws one bar with its printed value for a single band', () => {
    render(
      <GainsAnalysis
        stats={{
          ...stats,
          gainsByBand: [{ fromGsp: 9_000_000, toGsp: 9_250_000, wins: 4, avgGain: 150_000 }],
        }}
      />,
    );
    const rows = document.querySelectorAll('[data-slot="comparison-bars-series"] li');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('+150,000');
  });
});
