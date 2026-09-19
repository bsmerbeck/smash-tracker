import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { RecentEncounters } from './RecentEncounters';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function renderEncounters(
  matches: Match[],
  initialPath = '/',
  tournamentLinkForMatch?: (m: Match) => { href: string; label: string } | undefined,
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <RecentEncounters matches={matches} tournamentLinkForMatch={tournamentLinkForMatch} />
    </MemoryRouter>,
  );
}

describe('RecentEncounters', () => {
  it('renders no rows when the fixture is empty', () => {
    renderEncounters([]);
    expect(screen.getByText('No encounters recorded yet.')).toBeInTheDocument();
  });

  it('a match with a video renders an anchor to the subject-aware video route', () => {
    const matches = [makeMatch({ id: 'm1', time: 100, win: true, vodUrl: 'https://x.test/v' })];
    renderEncounters(matches);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/vod?match=m1');
  });

  it('carries the coach prefix through the video route', () => {
    const matches = [makeMatch({ id: 'm1', time: 100, win: true, vodUrl: 'https://x.test/v' })];
    renderEncounters(matches, '/coach/client-a/opponents/rival');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/coach/client-a/vods?match=m1');
  });

  it('a match with no video renders a toggle button that expands inline with the match facts', async () => {
    const user = userEvent.setup();
    const matches = [makeMatch({ id: 'm1', time: 100, win: true })];
    renderEncounters(matches);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Battlefield', { selector: 'p' })).not.toBeInTheDocument();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Battlefield', { selector: 'p' })).toBeInTheDocument();
  });

  it('renders the tournament link inside the expansion when the host resolves one', async () => {
    const user = userEvent.setup();
    const matches = [makeMatch({ id: 'm1', time: 100, win: true })];
    renderEncounters(matches, '/', () => ({
      href: '/tournaments/big-house-9',
      label: 'The Big House 9',
    }));

    await user.click(screen.getByRole('button'));
    const link = screen.getByRole('link', { name: 'The Big House 9' });
    expect(link).toHaveAttribute('href', '/tournaments/big-house-9');
  });

  it('preserves the row order given by the caller', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 300, win: true, opponent_id: 10 }),
      makeMatch({ id: 'm2', time: 200, win: false, opponent_id: 11 }),
    ];
    renderEncounters(matches);
    const dates = screen.getAllByText(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(dates.length).toBe(2);
  });
});
