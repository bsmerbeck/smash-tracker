import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { HeroStats } from './HeroStats';

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

describe('HeroStats', () => {
  it('renders the account-wide overall record with sample size', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    expect(screen.getByText('2-1')).toBeInTheDocument();
    expect(screen.getByText('67% win rate')).toBeInTheDocument();
    expect(screen.getByText('3 games')).toBeInTheDocument();
  });

  it('shows an empty state for the overall record when there are no matches', () => {
    render(<HeroStats matches={[]} timeFilteredMatches={[]} />);

    expect(screen.getAllByText('No match data to report yet.').length).toBeGreaterThan(0);
  });

  it('renders the current streak in the form card', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: false }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: true }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    expect(screen.getByText('2W')).toBeInTheDocument();
  });

  it('computes the casual-vs-competitive delta from timeFilteredMatches, ignoring the source filter', () => {
    // matches (source-filtered) only contains the manual bucket, but
    // timeFilteredMatches carries both — the card must use the latter.
    const manual = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
    ]; // 50%
    const competitive = [
      makeMatch({ id: 'c1', time: 3, win: true, source: 'startgg' }),
      makeMatch({ id: 'c2', time: 4, win: true, source: 'startgg' }),
      makeMatch({ id: 'c3', time: 5, win: false, source: 'startgg' }),
    ]; // 67%

    render(<HeroStats matches={manual} timeFilteredMatches={[...manual, ...competitive]} />);

    expect(screen.getByText('Casual')).toBeInTheDocument();
    expect(screen.getByText('Competitive')).toBeInTheDocument();
    // 67 - 50 = +17pts
    expect(screen.getByText('+17pts')).toBeInTheDocument();
  });

  it('shows "no data" for a bucket with zero matches instead of a delta', () => {
    const manual = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
    ];

    render(<HeroStats matches={manual} timeFilteredMatches={manual} />);

    expect(screen.getByText('no data')).toBeInTheDocument();
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
  });

  it('renders the online/offline split respecting all global filters', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, matchType: 'quickplay' }),
      makeMatch({ id: '2', time: 2, win: false, matchType: 'offline-friendly' }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows an empty state for online/offline when there are no matches', () => {
    render(<HeroStats matches={[]} timeFilteredMatches={[]} />);

    const onlineOfflineCard = screen.getByText('Online vs Offline').closest('div');
    expect(onlineOfflineCard).not.toBeNull();
  });
});
