import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScoutRecentEvent } from '@smash-tracker/shared';
import { ScoutRecentEventsCard } from './ScoutRecentEventsCard';

describe('ScoutRecentEventsCard', () => {
  it('renders a start.gg event with a slug as an external link to start.gg', () => {
    const events: ScoutRecentEvent[] = [
      {
        eventName: 'Ultimate Singles',
        lastSetAt: 1_700_000_000_000,
        slug: 'tournament/the-big-house-9/event/ultimate-singles',
        source: 'startgg',
      },
    ];
    render(<ScoutRecentEventsCard events={events} />);

    const link = screen.getByRole('link', { name: /Ultimate Singles/ });
    expect(link).toHaveAttribute(
      'href',
      'https://www.start.gg/tournament/the-big-house-9/event/ultimate-singles',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a pre-V9-B event with no slug as plain text (back-compat)', () => {
    const events: ScoutRecentEvent[] = [
      { eventName: 'Ultimate Singles', lastSetAt: 1_700_000_000_000 },
    ];
    render(<ScoutRecentEventsCard events={events} />);

    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a parry.gg event as plain text even when a slug is present (no verified event URL shape)', () => {
    const events: ScoutRecentEvent[] = [
      {
        eventName: 'Ultimate Singles',
        lastSetAt: 1_700_000_000_000,
        slug: 'my-tournament-01931d1c/test',
        source: 'parrygg',
      },
    ];
    render(<ScoutRecentEventsCard events={events} />);

    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no events', () => {
    render(<ScoutRecentEventsCard events={[]} />);
    expect(screen.getByText('No recent events sampled.')).toBeInTheDocument();
  });
});
