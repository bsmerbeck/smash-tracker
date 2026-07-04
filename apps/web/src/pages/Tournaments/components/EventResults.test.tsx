import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EventResults } from './EventResults';

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 1),
    setsPlayed: 3,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function renderResults(entry: TournamentEntry, entryMatches: Match[] = []) {
  return render(
    <TooltipProvider>
      <EventResults entry={entry} entryMatches={entryMatches} />
    </TooltipProvider>,
  );
}

describe('EventResults', () => {
  it('shows the resync hint when topStandings is absent', () => {
    renderResults(makeEntry({ topStandings: undefined }));
    expect(screen.getByText('Full results attach on your next start.gg sync.')).toBeInTheDocument();
  });

  it('shows a winner callout for placement 1', () => {
    renderResults(
      makeEntry({
        topStandings: [{ placement: 1, name: 'Champ', gamerTag: 'Champ' }],
      }),
    );
    expect(screen.getByText('Champ won this event')).toBeInTheDocument();
  });

  it('renders a top-8 table with placement and entrant name', () => {
    renderResults(
      makeEntry({
        topStandings: [
          { placement: 1, name: 'Champ' },
          { placement: 2, name: 'RunnerUp' },
        ],
      }),
    );
    expect(screen.getByText('Champ')).toBeInTheDocument();
    expect(screen.getByText('RunnerUp')).toBeInTheDocument();
  });

  it('shows the gamerTag alongside the raw name when they differ', () => {
    renderResults(
      makeEntry({
        topStandings: [{ placement: 1, name: 'Sponsor | Rival', gamerTag: 'Rival' }],
      }),
    );
    expect(screen.getByText('Rival')).toBeInTheDocument();
    expect(screen.getByText('(Sponsor | Rival)')).toBeInTheDocument();
  });

  it('links out to start.gg for rows with a userSlug', () => {
    renderResults(
      makeEntry({
        topStandings: [{ placement: 2, name: 'Champ', userSlug: 'user/abc123' }],
      }),
    );
    const link = screen.getByRole('link', { name: 'View Champ on start.gg' });
    expect(link).toHaveAttribute('href', 'https://start.gg/user/abc123');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('shows the profile link both in the winner callout and the table row for the placement-1 winner', () => {
    renderResults(
      makeEntry({
        topStandings: [{ placement: 1, name: 'Champ', userSlug: 'user/abc123' }],
      }),
    );
    const links = screen.getAllByRole('link', { name: 'View Champ on start.gg' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'https://start.gg/user/abc123');
    }
  });

  it('omits the profile link for rows without a userSlug', () => {
    renderResults(makeEntry({ topStandings: [{ placement: 1, name: 'Champ' }] }));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('tints and tooltips rows whose gamerTag matches an opponent played at this event', () => {
    const matches = [makeMatch({ id: 'm1', time: 100, win: true, opponent: 'rival' })];
    renderResults(
      makeEntry({
        topStandings: [{ placement: 3, name: 'Sponsor | Rival', gamerTag: 'Rival' }],
      }),
      matches,
    );
    const row = screen.getByText('Rival').closest('tr');
    expect(row?.className).toContain('bg-primary/5');
  });

  it('does not tint rows that were not played at this event', () => {
    renderResults(
      makeEntry({
        topStandings: [{ placement: 3, name: 'Stranger' }],
      }),
      [],
    );
    const row = screen.getByText('Stranger').closest('tr');
    expect(row?.className ?? '').not.toContain('bg-primary/5');
  });
});
