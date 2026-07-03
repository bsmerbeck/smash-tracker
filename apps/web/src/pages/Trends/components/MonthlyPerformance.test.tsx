import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import {
  MonthlyPerformance,
  SMALL_SAMPLE_THRESHOLD,
  buildMonthlyChartData,
  formatMonthLabel,
} from './MonthlyPerformance';
import { getMonthlyRecords } from '@/lib/stats';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('formatMonthLabel', () => {
  it('formats a YYYY-MM key as a short month/year label', () => {
    expect(formatMonthLabel('2021-01')).toBe('Jan 2021');
    expect(formatMonthLabel('2021-12')).toBe('Dec 2021');
  });

  it('falls back to the raw key for malformed input', () => {
    expect(formatMonthLabel('garbage')).toBe('garbage');
  });
});

describe('buildMonthlyChartData', () => {
  it('marks months under the small-sample threshold with the reduced-opacity color', () => {
    const matches = [
      // 2021-01: 2 games (below threshold of 3)
      makeMatch({ id: '1', time: Date.UTC(2021, 0, 1), win: true }),
      makeMatch({ id: '2', time: Date.UTC(2021, 0, 2), win: false }),
      // 2021-02: 3 games (at threshold)
      makeMatch({ id: '3', time: Date.UTC(2021, 1, 1), win: true }),
      makeMatch({ id: '4', time: Date.UTC(2021, 1, 2), win: true }),
      makeMatch({ id: '5', time: Date.UTC(2021, 1, 3), win: false }),
    ];
    const records = getMonthlyRecords(matches);
    const data = buildMonthlyChartData(records);

    expect(records[0]?.total).toBe(2);
    expect(records[1]?.total).toBe(3);
    // First bar (small sample) should differ in color from the second (full opacity).
    const colors = data.datasets[0]?.backgroundColor as string[];
    expect(colors[0]).not.toBe(colors[1]);
  });

  it('carries win rate and games-played data for each month', () => {
    const matches = [
      makeMatch({ id: '1', time: Date.UTC(2021, 0, 1), win: true }),
      makeMatch({ id: '2', time: Date.UTC(2021, 0, 2), win: true }),
      makeMatch({ id: '3', time: Date.UTC(2021, 0, 3), win: false }),
    ];
    const records = getMonthlyRecords(matches);
    const data = buildMonthlyChartData(records);

    expect(data.labels).toEqual(['Jan 2021']);
    expect(data.datasets[0]?.data).toEqual([67]);
    expect(data.datasets[0]?.games).toEqual([3]);
  });

  it('returns an empty dataset for no matches', () => {
    const data = buildMonthlyChartData(getMonthlyRecords([]));
    expect(data.labels).toEqual([]);
    expect(data.datasets[0]?.data).toEqual([]);
  });
});

describe('MonthlyPerformance component', () => {
  it('shows an empty state with no match data', () => {
    render(<MonthlyPerformance matches={[]} />);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('renders the small-sample caption and a table row per month', () => {
    const matches = [
      makeMatch({ id: '1', time: Date.UTC(2021, 0, 1), win: true }),
      makeMatch({ id: '2', time: Date.UTC(2021, 1, 1), win: true }),
      makeMatch({ id: '3', time: Date.UTC(2021, 1, 2), win: true }),
      makeMatch({ id: '4', time: Date.UTC(2021, 1, 3), win: false }),
    ];
    render(<MonthlyPerformance matches={matches} />);

    expect(
      screen.getByText(
        `Faded bars mark months with fewer than ${SMALL_SAMPLE_THRESHOLD} games — small sample, read with caution.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Jan 2021')).toBeInTheDocument();
    expect(screen.getByText('Feb 2021')).toBeInTheDocument();
    // Table shows most recent month first.
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Feb 2021');
  });
});
