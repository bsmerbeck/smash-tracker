import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { StageBreakdown } from './StageBreakdown';

let matchIdCounter = 0;

function makeMatch(stageId: number, fighterId = 1): Match {
  matchIdCounter += 1;
  return {
    id: `m-${matchIdCounter}`,
    fighter_id: fighterId,
    opponent_id: 10,
    time: 1_700_000_000_000 + matchIdCounter,
    map: { id: stageId, name: `Stage ${stageId}` },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
  };
}

function renderCard(matches: Match[]) {
  return render(
    <MemoryRouter>
      <StageBreakdown matches={matches} />
    </MemoryRouter>,
  );
}

/** Real stage ids 1..count (StageList has 123 entries) so getStageById resolves names/art. */
function stagesFixture(count: number): Match[] {
  const matches: Match[] = [];
  for (let stageId = 1; stageId <= count; stageId++) {
    matches.push(makeMatch(stageId));
  }
  return matches;
}

describe('StageBreakdown', () => {
  it('shows an empty state when there is no match data', () => {
    renderCard([]);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('caps the list at 8 with a show-all control, and fully expands within the inline cap', async () => {
    const user = userEvent.setup();
    renderCard(stagesFixture(20));

    expect(document.querySelectorAll('[data-slot="stage-row"]')).toHaveLength(8);
    const showAll = screen.getByRole('button', { name: /show all/i });
    await user.click(showAll);
    expect(document.querySelectorAll('[data-slot="stage-row"]')).toHaveLength(20);
    expect(screen.getByRole('button', { name: /show fewer/i })).toBeInTheDocument();
  });

  it('expands to the inline cap and then shows a terminus anchor beyond 25 stages', async () => {
    const user = userEvent.setup();
    renderCard(stagesFixture(30));

    const showAll = screen.getByRole('button', { name: /show all/i });
    await user.click(showAll);
    expect(document.querySelectorAll('[data-slot="stage-row"]')).toHaveLength(25);
    expect(screen.getByRole('button', { name: /all 30 stages/i })).toBeInTheDocument();
  });

  it('every stage row is a link with a non-empty accessible name and a destination carrying the stage identifier', () => {
    renderCard(stagesFixture(3));

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      expect(link).toHaveAccessibleName();
      expect(link.getAttribute('href')).toMatch(/\/stages\/\d+/);
    }
  });

  it('the stage name element carries the truncation-guard attribute and a title with the full string', () => {
    renderCard(stagesFixture(1));

    const name = document.querySelector('[data-truncate-guard]')!;
    expect(name).toHaveAttribute('title');
    expect(name.getAttribute('title')).toBe(name.textContent);
  });

  it('renders no per-fighter split, even for a fixture whose stage has multiple fighters', () => {
    const matches = [makeMatch(1, 1), makeMatch(1, 2), makeMatch(1, 3)];
    renderCard(matches);

    expect(document.querySelectorAll('table')).toHaveLength(0);
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it("the card's meta line states the sort order", () => {
    renderCard(stagesFixture(3));

    expect(screen.getByText('Most games')).toBeInTheDocument();
  });
});
