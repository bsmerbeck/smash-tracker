import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { StageBreakdown } from './StageBreakdown';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1_700_000_000_000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

describe('StageBreakdown', () => {
  it('shows an empty state when there is no match data', () => {
    render(<StageBreakdown matches={[]} />);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('shows no thumbnail for the initial "no selection" state', () => {
    render(<StageBreakdown matches={[makeMatch()]} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the stage art thumbnail for a stage that has one', async () => {
    const user = userEvent.setup();
    render(<StageBreakdown matches={[makeMatch({ map: { id: 1, name: 'Battlefield' } })]} />);

    await user.click(screen.getByLabelText('Select stage'));
    // "Battlefield" appears once in "Most played" and once in "All stages" —
    // either selects the same stage id, so just take the first match.
    const [option] = await screen.findAllByRole('option', { name: /Battlefield/ });
    await user.click(option!);

    const thumbnail = document.querySelector('img[src="/assets/stages/1-battlefield.jpg"]');
    expect(thumbnail).toBeInTheDocument();
  });

  it('pins a Favorites group when favoriteStageIds are passed', async () => {
    const user = userEvent.setup();
    render(<StageBreakdown matches={[makeMatch()]} favoriteStageIds={[3]} />);

    await user.click(screen.getByLabelText('Select stage'));

    expect(await screen.findByText('Favorites')).toBeInTheDocument();
    // Final Destination (id 3) appears in Favorites and again in All stages.
    // Exact name: /Final Destination/ would also catch "(Gen. Final Destination)".
    expect(screen.getAllByRole('option', { name: 'Final Destination' })).toHaveLength(2);
  });

  it('shows a fallback abbreviation tile for a stage lacking art', async () => {
    const user = userEvent.setup();
    render(<StageBreakdown matches={[makeMatch({ map: { id: 2, name: 'Big Battlefield' } })]} />);

    await user.click(screen.getByLabelText('Select stage'));
    const [option] = await screen.findAllByRole('option', { name: /Big Battlefield/ });
    await user.click(option!);

    const heading = screen.getByRole('heading', { name: 'Big Battlefield' });
    expect(within(heading.parentElement!).getByText('BB')).toBeInTheDocument();
  });
});
