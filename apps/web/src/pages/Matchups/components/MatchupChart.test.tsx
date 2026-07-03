import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { buildTrendSeries, MatchupChart } from './MatchupChart';

// jsdom has no canvas implementation, and chart.js's resize/render pipeline
// touches real canvas APIs on every re-render (see chart.js's
// core.controller getMaximumSize). Mocking react-chartjs-2's <Line> keeps
// these tests focused on MatchupChart's own window-selector logic, which is
// what this suite is verifying — the chart.js rendering itself isn't owned
// by this component.
vi.mock('react-chartjs-2', () => ({
  Line: () => null,
}));

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function sequence(results: boolean[]): Match[] {
  return results.map((win, i) => makeMatch({ id: `m${i}`, time: i + 1, win }));
}

describe('buildTrendSeries', () => {
  it('builds a trailing-5 rolling window by default mode', () => {
    // 7 matches: L L L L L W W — trailing window 5 at the last point covers
    // matches 3-7 (L L L W W) => 2/5 = 40%.
    const matches = sequence([false, false, false, false, false, true, true]);
    const series = buildTrendSeries(matches, '5');
    expect(series).toHaveLength(7);
    expect(series[series.length - 1]?.winRate).toBeCloseTo(40);
  });

  it('builds a trailing-10 rolling window', () => {
    const matches = sequence([true, true, true, false, false]);
    const series = buildTrendSeries(matches, '10');
    // Only 5 matches exist, so the window is the whole series: 3/5 = 60%.
    expect(series[series.length - 1]?.winRate).toBeCloseTo(60);
  });

  it('builds a cumulative (all-time running) series', () => {
    const matches = sequence([true, false, true, true]);
    const series = buildTrendSeries(matches, 'cumulative');
    // Cumulative win rate after 4 matches: 3/4 = 75%.
    expect(series[series.length - 1]?.winRate).toBeCloseTo(75);
    // Cumulative after match 1: 1/1 = 100%.
    expect(series[0]?.winRate).toBeCloseTo(100);
  });

  it('returns an empty series for no matches', () => {
    expect(buildTrendSeries([], '5')).toEqual([]);
    expect(buildTrendSeries([], 'cumulative')).toEqual([]);
  });
});

describe('MatchupChart', () => {
  it('shows a prompt when there are no matches, regardless of window', () => {
    render(<MatchupChart matchupMatches={[]} />);
    expect(screen.getByText('Submit a match to see the match chart.')).toBeInTheDocument();
  });

  it('defaults to the rolling-5 window', () => {
    render(<MatchupChart matchupMatches={sequence([true, false])} />);
    expect(screen.getByLabelText('Trend window')).toHaveTextContent('Rolling 5');
  });

  it('switches to rolling-10 and cumulative via the selector', async () => {
    const user = userEvent.setup();
    render(<MatchupChart matchupMatches={sequence([true, false, true])} />);

    await user.click(screen.getByLabelText('Trend window'));
    await user.click(await screen.findByRole('option', { name: 'Rolling 10' }));
    expect(screen.getByLabelText('Trend window')).toHaveTextContent('Rolling 10');

    await user.click(screen.getByLabelText('Trend window'));
    await user.click(await screen.findByRole('option', { name: 'Cumulative' }));
    expect(screen.getByLabelText('Trend window')).toHaveTextContent('Cumulative');
  });
});
