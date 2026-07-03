import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { Tournaments, buildTournamentSummaries } from './Tournaments';

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

describe('buildTournamentSummaries', () => {
  it('excludes matches without a tournamentName', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: false, tournamentName: '' }),
    ];
    expect(buildTournamentSummaries(matches)).toEqual([]);
  });

  it('groups matches by tournamentName, computing date range and record', () => {
    const matches = [
      makeMatch({
        id: '1',
        time: Date.UTC(2021, 0, 1),
        win: true,
        tournamentName: 'The Big House 9',
        eventName: 'Ultimate Singles',
        source: 'startgg',
      }),
      makeMatch({
        id: '2',
        time: Date.UTC(2021, 0, 3),
        win: false,
        tournamentName: 'The Big House 9',
        eventName: 'Ultimate Singles',
        source: 'startgg',
      }),
    ];
    const summaries = buildTournamentSummaries(matches);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      tournamentName: 'The Big House 9',
      eventNames: ['Ultimate Singles'],
      wins: 1,
      losses: 1,
      total: 2,
    });
    expect(summaries[0]?.startTime).toBe(Date.UTC(2021, 0, 1));
    expect(summaries[0]?.endTime).toBe(Date.UTC(2021, 0, 3));
  });

  it('collects distinct event names in first-seen order', () => {
    const matches = [
      makeMatch({
        id: '1',
        time: 1,
        win: true,
        tournamentName: 'Genesis 9',
        eventName: 'Singles',
      }),
      makeMatch({
        id: '2',
        time: 2,
        win: true,
        tournamentName: 'Genesis 9',
        eventName: 'Doubles',
      }),
      makeMatch({
        id: '3',
        time: 3,
        win: true,
        tournamentName: 'Genesis 9',
        eventName: 'Singles',
      }),
    ];
    const summaries = buildTournamentSummaries(matches);
    expect(summaries[0]?.eventNames).toEqual(['Singles', 'Doubles']);
  });

  it('sorts tournaments by most recent (endTime descending)', () => {
    const matches = [
      makeMatch({ id: '1', time: Date.UTC(2020, 0, 1), win: true, tournamentName: 'Older Event' }),
      makeMatch({ id: '2', time: Date.UTC(2022, 0, 1), win: true, tournamentName: 'Newer Event' }),
    ];
    const summaries = buildTournamentSummaries(matches);
    expect(summaries.map((s) => s.tournamentName)).toEqual(['Newer Event', 'Older Event']);
  });
});

function renderTournaments(matches: Match[]) {
  return render(
    <MemoryRouter>
      <Tournaments matches={matches} />
    </MemoryRouter>,
  );
}

describe('Tournaments component', () => {
  it('shows the resync hint when no match has a tournamentName', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true })];
    renderTournaments(matches);

    expect(
      screen.getByText(/Tournament names attach on your next start\.gg sync/),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Integrations' });
    expect(link).toHaveAttribute('href', '/settings/integrations');
  });

  it('renders a table row per tournament when tournamentName data exists', () => {
    const matches = [
      makeMatch({
        id: '1',
        time: 1,
        win: true,
        tournamentName: 'The Big House 9',
        eventName: 'Ultimate Singles',
      }),
    ];
    renderTournaments(matches);

    expect(screen.getByText('The Big House 9')).toBeInTheDocument();
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(
      screen.queryByText(/Tournament names attach on your next start\.gg sync/),
    ).not.toBeInTheDocument();
  });
});
