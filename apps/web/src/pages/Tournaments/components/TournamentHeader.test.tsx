import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { render, screen } from '@testing-library/react';
import type { TournamentEntry } from '@smash-tracker/shared';
import { TournamentHeader, buildSeedPlacementBadge } from './TournamentHeader';

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

describe('buildSeedPlacementBadge', () => {
  it('returns null when seed is absent', () => {
    expect(buildSeedPlacementBadge(makeEntry({ placement: 5 }), i18n.t)).toBeNull();
  });

  it('returns null when placement is absent', () => {
    expect(buildSeedPlacementBadge(makeEntry({ seed: 5 }), i18n.t)).toBeNull();
  });

  it('returns a success-toned badge when placement beats seed', () => {
    const badge = buildSeedPlacementBadge(makeEntry({ seed: 408, placement: 257 }), i18n.t);
    expect(badge).toEqual({ tone: 'success', label: 'Outperformed seed: 408 → 257' });
  });

  it('returns a destructive-toned badge when placement is worse than seed', () => {
    const badge = buildSeedPlacementBadge(makeEntry({ seed: 32, placement: 65 }), i18n.t);
    expect(badge).toEqual({ tone: 'destructive', label: 'Underperformed seed: 32 → 65' });
  });

  it('returns a neutral badge when placement matches seed exactly', () => {
    const badge = buildSeedPlacementBadge(makeEntry({ seed: 16, placement: 16 }), i18n.t);
    expect(badge).toEqual({ tone: 'secondary', label: 'Matched seed: 16 → 16' });
  });
});

describe('TournamentHeader', () => {
  it('shows the tournament name as the title, with the event name as a sub-line', () => {
    render(
      <TournamentHeader
        entry={makeEntry({ tournamentName: 'The Big House 9', eventName: 'Ultimate Singles' })}
      />,
    );
    expect(screen.getByText('The Big House 9')).toBeInTheDocument();
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
  });

  it('falls back to eventName as the title when tournamentName is absent, without a redundant sub-line', () => {
    render(<TournamentHeader entry={makeEntry({ tournamentName: undefined })} />);
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    // Only one occurrence — no duplicated sub-line.
    expect(screen.getAllByText('Ultimate Singles')).toHaveLength(1);
  });

  it('shows the entrant count when present', () => {
    render(<TournamentHeader entry={makeEntry({ numEntrants: 128 })} />);
    expect(screen.getByText('128 entrants')).toBeInTheDocument();
  });

  it('omits the entrant count when absent', () => {
    render(<TournamentHeader entry={makeEntry({ numEntrants: undefined })} />);
    expect(screen.queryByText(/entrants/)).not.toBeInTheDocument();
  });

  it('renders the seed/placement badge when both fields are present', () => {
    render(<TournamentHeader entry={makeEntry({ seed: 408, placement: 257 })} />);
    expect(screen.getByText('Outperformed seed: 408 → 257')).toBeInTheDocument();
  });

  it('omits the seed/placement badge cleanly when absent', () => {
    render(<TournamentHeader entry={makeEntry({ seed: undefined, placement: undefined })} />);
    expect(screen.queryByText(/seed/i)).not.toBeInTheDocument();
  });

  it('shows the sets played count', () => {
    render(<TournamentHeader entry={makeEntry({ setsPlayed: 7 })} />);
    expect(screen.getByText('7 sets played')).toBeInTheDocument();
  });

  it('shows a "View on start.gg" button linking to the event slug when present', () => {
    render(
      <TournamentHeader
        entry={makeEntry({
          slug: 'tournament/the-box-juice-box-26',
          eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
        })}
      />,
    );
    const link = screen.getByRole('link', { name: /View on start\.gg/ });
    expect(link).toHaveAttribute(
      'href',
      'https://start.gg/tournament/the-box-juice-box-26/event/ultimate-singles',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('falls back to the tournament slug when eventSlug is absent', () => {
    render(<TournamentHeader entry={makeEntry({ slug: 'tournament/the-box-juice-box-26' })} />);
    const link = screen.getByRole('link', { name: /View on start\.gg/ });
    expect(link).toHaveAttribute('href', 'https://start.gg/tournament/the-box-juice-box-26');
  });

  it('omits the "View on start.gg" button when neither slug is present', () => {
    render(<TournamentHeader entry={makeEntry({ slug: undefined, eventSlug: undefined })} />);
    expect(screen.queryByRole('link', { name: /View on start\.gg/ })).not.toBeInTheDocument();
  });

  it('renders an inline external link on the tournament title when a slug is present', () => {
    render(
      <TournamentHeader
        entry={makeEntry({
          tournamentName: 'The Big House 9',
          eventSlug: 'tournament/tbh9/event/ult',
        })}
      />,
    );
    const link = screen.getByRole('link', { name: 'View The Big House 9 on start.gg' });
    expect(link).toHaveAttribute('href', 'https://start.gg/tournament/tbh9/event/ult');
  });

  it('omits the inline title link when no slug is present', () => {
    render(<TournamentHeader entry={makeEntry()} />);
    expect(screen.queryByRole('link', { name: /View .* on start\.gg/ })).not.toBeInTheDocument();
  });
});
