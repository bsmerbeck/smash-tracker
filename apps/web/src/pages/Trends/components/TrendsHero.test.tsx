import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { TrendsHero } from './TrendsHero';

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

describe('TrendsHero', () => {
  it('shows the not-enough-games / no-data placeholders with no match history', () => {
    render(<TrendsHero matches={[]} />);

    expect(screen.getByText('Current Rating')).toBeInTheDocument();
    expect(screen.getByText('Peak Rating')).toBeInTheDocument();
    expect(screen.getByText('Best Month')).toBeInTheDocument();
    expect(screen.getByText('Current Form')).toBeInTheDocument();
    expect(screen.getAllByText('Not enough games yet').length).toBe(2);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('renders current rating, peak rating, best month, and current form once there is history', () => {
    const matches = [
      // Jan 2021: 5 games, 100% win rate -> best month.
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `jan-${i}`, time: Date.UTC(2021, 0, i + 1), win: true }),
      ),
      // Feb 2021: 5 games, 0% win rate.
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `feb-${i}`, time: Date.UTC(2021, 1, i + 1), win: false }),
      ),
    ];

    render(<TrendsHero matches={matches} />);

    expect(screen.getByText('Glicko-2 rating')).toBeInTheDocument();
    expect(screen.getByText('Best session rating')).toBeInTheDocument();
    expect(screen.getByText(/Jan 2021/)).toBeInTheDocument();
    expect(screen.getByText(/Last 10 of 20 games/)).toBeInTheDocument();
  });
});
