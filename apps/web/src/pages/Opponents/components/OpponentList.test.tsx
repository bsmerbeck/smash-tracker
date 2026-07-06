import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { OpponentList } from './OpponentList';

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win' | 'opponent'>,
): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 1, name: 'Battlefield' },
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

/**
 * alice: 4 games (3-1), most played, oldest activity.
 * bob:   2 games (0-2), most recent activity, lowest win rate.
 * cara:  1 game  (1-0), 100% win rate, small sample.
 */
const MATCHES: Match[] = [
  makeMatch({ id: 'a1', time: 100, win: true, opponent: 'alice' }),
  makeMatch({ id: 'a2', time: 200, win: true, opponent: 'alice' }),
  makeMatch({ id: 'a3', time: 300, win: true, opponent: 'alice' }),
  makeMatch({ id: 'a4', time: 400, win: false, opponent: 'alice' }),
  makeMatch({ id: 'b1', time: 900, win: false, opponent: 'bob' }),
  makeMatch({ id: 'b2', time: 1000, win: false, opponent: 'bob' }),
  makeMatch({ id: 'c1', time: 500, win: true, opponent: 'cara' }),
];

function renderList() {
  return render(
    <OpponentList matches={MATCHES} selected={null} onSelect={vi.fn()} onRequestMerge={vi.fn()} />,
  );
}

function rowNames(): string[] {
  const list = screen.getByRole('list', { name: 'Opponents' });
  return within(list)
    .getAllByRole('listitem')
    .map((li) => within(li).getByTitle(/.+/).textContent ?? '');
}

describe('OpponentList sorting and filtering', () => {
  it('defaults to most played', () => {
    renderList();
    expect(rowNames()).toEqual(['alice', 'bob', 'cara']);
  });

  it('sorts by most recent activity', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Recently played' }));
    expect(rowNames()).toEqual(['bob', 'cara', 'alice']);
  });

  it('sorts by highest and lowest win rate', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Highest win rate' }));
    expect(rowNames()).toEqual(['cara', 'alice', 'bob']);

    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Lowest win rate' }));
    expect(rowNames()).toEqual(['bob', 'alice', 'cara']);
  });

  it('sorts alphabetically', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'A → Z' }));
    expect(rowNames()).toEqual(['alice', 'bob', 'cara']);
  });

  it('the 3+ games toggle hides small samples', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(
      screen.getByRole('button', { name: 'Only show opponents with 3 or more games' }),
    );
    expect(rowNames()).toEqual(['alice']);
    // The header count still reflects everyone faced, not the filtered view.
    expect(screen.getByText('3 opponents faced')).toBeInTheDocument();
  });
});
